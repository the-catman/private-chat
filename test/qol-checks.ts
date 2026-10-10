import assert from 'node:assert/strict';
import { expect, type Page, type BrowserContext } from '@playwright/test';

declare global {
    interface Window {
        __composerSendTest?: {
            started: boolean;
            blurs: number;
            release: () => void;
            restore: () => void;
        };
    }
}

async function holdComposerSend(page: Page, text: string, fail = false) {
    await page.evaluate(
        ({ text, fail }) => {
            const encrypt = crypto.subtle.encrypt;
            const editor =
                document.querySelector<HTMLTextAreaElement>(
                    '.composer textarea'
                )!;
            let release!: () => void;
            const pending = new Promise<void>((resolve) => {
                release = resolve;
            });
            const test = {
                started: false,
                blurs: 0,
                release,
                onBlur() {
                    test.blurs++;
                },
                restore() {
                    crypto.subtle.encrypt = encrypt;
                    editor.removeEventListener('blur', test.onBlur);
                    release();
                    delete window.__composerSendTest;
                },
            };
            window.__composerSendTest = test;
            editor.addEventListener('blur', test.onBlur);
            // Hold only this message's encryption, not typing or presence packets.
            crypto.subtle.encrypt = async (...args) => {
                if (
                    new TextDecoder().decode(args[2]) ===
                    JSON.stringify({ kind: 'text', text })
                ) {
                    test.started = true;
                    await pending;
                    if (fail) throw new Error('Synthetic send failure');
                }
                return encrypt.apply(crypto.subtle, args);
            };
        },
        { text, fail }
    );
}

export async function checkComposerFocus(page: Page) {
    const composer = page.locator('.composer textarea');
    const sendButton = page.getByRole('button', {
        name: 'Send message',
        exact: true,
    });
    // Focus must not depend on animation frames (which browsers may delay).
    await page.evaluate(() => {
        const request = window.requestAnimationFrame;
        const cancel = window.cancelAnimationFrame;
        const pending = new Map<number, FrameRequestCallback>();
        window.requestAnimationFrame = (callback) => {
            const id = request(() => {});
            pending.set(id, callback);
            return id;
        };
        window.cancelAnimationFrame = (id) => {
            pending.delete(id);
            cancel(id);
        };
        (
            window as Window & { resumeComposerFrames?: () => void }
        ).resumeComposerFrames = () => {
            window.requestAnimationFrame = request;
            window.cancelAnimationFrame = cancel;
            for (const callback of pending.values()) request(callback);
        };
    });
    try {
        for (const method of ['Enter', 'button']) {
            const text = `Focus stays after sending with ${method}.`;
            await composer.fill(text);
            const border = await page
                .locator('.composer')
                .evaluate((node) => getComputedStyle(node).borderColor);
            await holdComposerSend(page, text);
            if (method === 'Enter') await page.keyboard.press('Enter');
            else await sendButton.click();
            await expect
                .poll(() =>
                    page.evaluate(() => window.__composerSendTest?.started)
                )
                .toBe(true);
            await expect(composer).toBeEditable();
            await expect(composer).toHaveValue('');
            await expect(composer).toBeFocused();
            assert.equal(
                await page
                    .locator('.composer')
                    .evaluate((node) => getComputedStyle(node).borderColor),
                border,
                'the focused composer border stays steady while sending'
            );
            await expect(
                page.getByRole('button', { name: 'Add emoji', exact: true })
            ).toBeEnabled();
            // Raw keyboard input deliberately doesn't focus the element for us.
            await page.keyboard.type('The next message');
            await page.keyboard.press('Enter');
            await expect(sendButton).toBeDisabled();
            await page.evaluate(() => window.__composerSendTest?.release());
            await expect(page.getByText(text, { exact: true })).toBeVisible();
            await expect(sendButton).toBeEnabled();
            await expect(composer).toHaveValue('The next message');
            await expect(composer).toBeFocused();
            assert.equal(
                await page.evaluate(() => window.__composerSendTest?.blurs),
                0,
                'sending never blurs the editor, even briefly'
            );
            await expect(
                page
                    .getByTestId('chat-message')
                    .getByText('The next message', { exact: true })
            ).toHaveCount(0);
            await page.evaluate(() => window.__composerSendTest?.restore());
        }
        for (const nextDraft of ['', 'Already writing something else']) {
            const text = 'Keep this draft if sending fails.';
            await composer.fill(text);
            await holdComposerSend(page, text, true);
            await page.keyboard.press('Enter');
            await expect(composer).toHaveValue('');
            if (nextDraft) await page.keyboard.type(nextDraft);
            // Completing a send must not pull focus away from another control.
            const help = page.getByRole('button', {
                name: 'Formatting help',
                exact: true,
            });
            await help.focus();
            await page.evaluate(() => window.__composerSendTest?.release());
            await expect(page.locator('.toast')).toContainText(
                'Synthetic send failure'
            );
            await expect(sendButton).toBeEnabled();
            await expect(composer).toHaveValue(
                nextDraft ? `${text}\n${nextDraft}` : text
            );
            await expect(help).toBeFocused();
            await page.evaluate(() => window.__composerSendTest?.restore());
        }
        await composer.fill('');
    } finally {
        await page.evaluate(() => {
            window.__composerSendTest?.restore();
            (
                window as Window & { resumeComposerFrames?: () => void }
            ).resumeComposerFrames?.();
            delete (window as Window & { resumeComposerFrames?: () => void })
                .resumeComposerFrames;
        });
    }
    console.log(
        'PASS: Enter and send-button keep focus and styling throughout encryption, preserve continued typing, and restore failed drafts without stealing focus'
    );
}

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
