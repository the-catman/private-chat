import assert from 'node:assert/strict';
import { expect, type Page, type BrowserContext } from '@playwright/test';

export async function checkParticipantVolume(alice: Page, bob: Page) {
    const bobId = await bob.evaluate(
        () =>
            JSON.parse(
                window.__testTraffic.find(
                    (packet) => JSON.parse(packet).type === 'join'
                )!
            ).id as string
    );
    const audio = alice.locator(`[data-peer-audio="${bobId}"] audio`);
    await alice
        .locator('.call-panel')
        .getByRole('button', { name: 'Volume for Bob', exact: true })
        .click();
    const slider = alice.getByRole('slider', {
        name: 'Bob volume',
        exact: true,
    });
    await slider.fill('35');
    await expect
        .poll(() =>
            audio.first().evaluate((node: HTMLAudioElement) => node.volume)
        )
        .toBe(0.35);
    assert.ok(
        await bob
            .locator('.call-audio audio')
            .evaluateAll((nodes) =>
                nodes.every((node) => (node as HTMLAudioElement).volume === 1)
            ),
        'my volume preference does not affect another listener'
    );
    assert.ok(
        await alice
            .locator(
                `[data-peer-audio]:not([data-peer-audio="${bobId}"]) audio`
            )
            .evaluateAll((nodes) =>
                nodes.every((node) => (node as HTMLAudioElement).volume === 1)
            ),
        'another participant stays at full volume'
    );
    await slider.fill('0');
    await expect(slider).toHaveAttribute('aria-valuetext', 'Muted for you');
    await expect
        .poll(() =>
            audio.first().evaluate((node: HTMLAudioElement) => node.volume)
        )
        .toBe(0);
    await slider.fill('35');
    await alice.keyboard.press('Escape');
    await expect(slider).toBeHidden();
    await expect(
        alice
            .locator('.call-panel')
            .getByRole('button', { name: 'Volume for Bob', exact: true })
    ).toBeFocused();
    await alice.getByRole('button', { name: 'Deafen', exact: true }).click();
    assert.ok(
        await audio.first().evaluate((node: HTMLAudioElement) => node.muted)
    );
    await alice.getByRole('button', { name: 'Undeafen', exact: true }).click();
    assert.equal(
        await audio.first().evaluate((node: HTMLAudioElement) => node.volume),
        0.35
    );
    assert.ok(
        !(await audio.first().evaluate((node: HTMLAudioElement) => node.muted))
    );
    await alice
        .getByRole('button', { name: 'Expand call', exact: true })
        .click();
    await alice
        .locator('.call-panel')
        .getByRole('button', { name: 'Volume for Bob', exact: true })
        .click();
    await alice.keyboard.press('Escape');
    await expect(slider).toBeHidden();
    await expect(
        alice.getByRole('button', { name: 'Restore chat view', exact: true })
    ).toBeVisible();
    await alice
        .getByRole('button', { name: 'Restore chat view', exact: true })
        .click();
    console.log(
        'PASS: per-person volume, local mute, independent listeners, deafening and Escape in an expanded call'
    );
}

export async function checkPopoutVolume(popup: Page, parent: Page) {
    await popup
        .getByRole('button', { name: 'Volume for Bob', exact: true })
        .click();
    const slider = popup.getByRole('slider', {
        name: 'Bob volume',
        exact: true,
    });
    await expect(slider).toHaveValue('35');
    await slider.fill('60');
    await expect
        .poll(() =>
            parent
                .locator('.call-audio audio')
                .evaluateAll((nodes) =>
                    nodes.some(
                        (node) => (node as HTMLAudioElement).volume === 0.6
                    )
                )
        )
        .toBe(true);
    await popup.getByText('The lounge', { exact: true }).click();
    await expect(slider).toBeHidden();
    console.log(
        'PASS: popped-out volume controls update audio in the original tab and dismiss on an outside click'
    );
}

async function send(page: Page, text: string) {
    await page.locator('.composer textarea').fill(text);
    await page
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
    await expect(page.locator('.composer textarea')).toHaveValue('');
}

export async function checkMarkdown(alice: Page, bob: Page) {
    const peopleWereVisible = await alice.locator('.members-panel').isVisible();
    if (!peopleWereVisible)
        await alice
            .getByRole('button', { name: 'Toggle people list', exact: true })
            .click();
    await alice
        .locator('.members-panel')
        .getByRole('button', { name: 'Volume for Bob', exact: true })
        .click();
    await expect(
        alice.getByRole('slider', { name: 'Bob volume', exact: true })
    ).toHaveValue('60');
    await alice.keyboard.press('Escape');
    if (!peopleWereVisible)
        await alice
            .getByRole('button', { name: 'Toggle people list', exact: true })
            .click();
    await alice
        .getByRole('button', { name: 'Formatting help', exact: true })
        .click();
    const helper = alice.getByRole('dialog', {
        name: 'Format your messages',
        exact: true,
    });
    await expect(helper).toBeVisible();
    await expect(
        helper.locator('strong').filter({ hasText: 'bold text' })
    ).toBeVisible();
    await helper.screenshot({ path: 'test-results/markdown-helper.png' });
    await alice.keyboard.press('Escape');
    await expect(helper).toHaveCount(0);
    await expect(alice.locator('.composer textarea')).toBeFocused();
    const text =
        '**A formatted message** with *emphasis* and ~~old words~~.\n\n> A quoted line\n\n- first\n- second\n\n```ts\nconst greeting = "hello";\n```\n\n[Example](https://example.com)';
    await send(alice, text);
    for (const page of [alice, bob]) {
        const row = page
            .getByTestId('chat-message')
            .filter({ hasText: 'A formatted message' });
        await expect(
            row.locator('strong').filter({ hasText: 'A formatted message' })
        ).toBeVisible();
        await expect(row.locator('em')).toHaveText('emphasis');
        await expect(row.locator('del')).toHaveText('old words');
        await expect(row.locator('li')).toHaveCount(2);
        await expect(row.locator('pre code')).toContainText('const greeting');
        await expect(
            row.getByRole('link', { name: 'Example', exact: true })
        ).toHaveAttribute('rel', 'noopener noreferrer');
    }
    assert.equal(
        await alice
            .locator('.avatar')
            .first()
            .evaluate((node) => getComputedStyle(node).userSelect),
        'none'
    );
    assert.equal(
        await alice
            .locator('.message-text')
            .first()
            .evaluate((node) => getComputedStyle(node).userSelect),
        'text'
    );
    const row = alice
        .getByTestId('chat-message')
        .filter({ hasText: 'A formatted message' });
    await row.click({ button: 'right' });
    await alice
        .getByRole('menuitem', { name: 'Edit message', exact: true })
        .click();
    await expect(
        alice.getByRole('textbox', { name: 'Edit message', exact: true })
    ).toHaveValue(text);
    await alice.keyboard.press('Escape');
    await send(
        alice,
        'Safe rendering: [unsafe](javascript:alert%281%29) ![remote image](https://tracker.invalid/pixel)\n\n<script>alert(1)</script>'
    );
    const safe = bob
        .getByTestId('chat-message')
        .filter({ hasText: 'Safe rendering:' });
    await expect(safe).toBeVisible();
    await expect(safe.locator('a, img, script, iframe')).toHaveCount(0);
    await alice.screenshot({ path: 'test-results/markdown-chat.png' });
    console.log(
        'PASS: Markdown formatting, editable source, safe links, no remote images or HTML and selectable message content'
    );
}

type Participant = { page: Page; context: BrowserContext };
export async function checkClearChat(
    alice: Participant,
    bob: Participant,
    newcomer: Participant
) {
    await alice.page.locator('.dm-row').filter({ hasText: 'Bob' }).click();
    await send(alice.page, 'This private message survives a room clear.');
    await alice.page
        .locator('.channel-row')
        .filter({ hasText: 'The living room' })
        .click();
    const openClear = async (page: Page) => {
        await page
            .getByRole('button', { name: 'Conversation actions', exact: true })
            .click();
        await page
            .getByRole('menuitem', {
                name: 'Clear chat for everyone',
                exact: true,
            })
            .click();
        return page.getByRole('dialog', {
            name: 'Clear chat for everyone?',
            exact: true,
        });
    };
    const cancel = await openClear(newcomer.page);
    await expect(
        cancel.getByRole('button', { name: 'Cancel', exact: true })
    ).toBeFocused();
    await cancel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(alice.page.getByTestId('chat-message').first()).toBeVisible();
    await bob.context.setOffline(true);
    await bob.page.evaluate(() =>
        window.__testSockets.forEach((socket) => socket.close())
    );
    await expect(bob.page.locator('.connection-banner')).toBeVisible();
    const clear = await openClear(newcomer.page);
    await clear
        .getByRole('button', { name: 'Clear for everyone', exact: true })
        .click();
    await expect(clear).toHaveCount(0);
    await expect(alice.page.getByTestId('chat-message')).toHaveCount(0);
    await expect(newcomer.page.getByTestId('chat-message')).toHaveCount(0);
    await bob.context.setOffline(false);
    await expect(bob.page.locator('.connection-banner')).toHaveCount(0, {
        timeout: 20000,
    });
    await expect(bob.page.getByTestId('chat-message')).toHaveCount(0);
    await alice.page.reload();
    await expect(
        alice.page.getByRole('heading', {
            name: 'The living room',
            exact: true,
        })
    ).toBeVisible();
    await expect(alice.page.getByTestId('chat-message')).toHaveCount(0);
    await alice.page.locator('.dm-row').filter({ hasText: 'Bob' }).click();
    await expect(
        alice.page.getByText('This private message survives a room clear.', {
            exact: true,
        })
    ).toBeVisible();
    await bob.page.locator('.dm-row').filter({ hasText: 'Alice' }).click();
    await expect(
        bob.page.getByText('This private message survives a room clear.', {
            exact: true,
        })
    ).toBeVisible();
    const dmClear = await openClear(bob.page);
    await dmClear
        .getByRole('button', { name: 'Clear for everyone', exact: true })
        .click();
    await expect(alice.page.getByTestId('chat-message')).toHaveCount(0);
    await expect(bob.page.getByTestId('chat-message')).toHaveCount(0);
    await send(alice.page, 'A new conversation after clearing.');
    await expect(
        bob.page.getByText('A new conversation after clearing.', {
            exact: true,
        })
    ).toBeVisible();
    console.log(
        'PASS: anyone can clear room history, cancel confirmation, offline readers resync, DMs stay private and both DM participants can clear'
    );
}
