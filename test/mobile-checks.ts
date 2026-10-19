import { expectInput, inputText } from './message-input';
import assert from 'node:assert/strict';
import { expect, type Page } from '@playwright/test';

declare global {
    interface Window {
        __mobileViewportTest?: {
            resize: (height: number, top: number, scale?: number) => void;
            restore: () => void;
        };
    }
}

export async function checkMobileLayout(page: Page, peer: Page, touch = false) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page
        .getByRole('button', { name: 'Open navigation', exact: true })
        .click();
    await page.locator('.channel-row:not(.voice-channel)').click();
    await peer.locator('.channel-row:not(.voice-channel)').click();
    const composer = page.locator('.composer [role="textbox"]');
    const options = page.getByRole('button', {
        name: 'Message options',
        exact: true,
    });
    const conversation = page.getByRole('button', {
        name: 'Conversation actions',
        exact: true,
    });

    for (const width of [320, 390, 430, 720]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(
            page.locator('.conversation-header button:visible')
        ).toHaveCount(3);
        const header = await page.locator('.conversation-header').boundingBox();
        const input = await page.locator('.composer').boundingBox();
        assert.ok(
            header && header.height <= 64,
            'the phone header stays on one row'
        );
        assert.ok(
            input && input.height <= 60,
            'the empty composer stays on one row'
        );
        assert.equal(
            await page.evaluate(
                () => document.documentElement.scrollWidth > innerWidth
            ),
            false
        );
        for (const button of await page
            .locator(
                '.conversation-header button:visible, .composer button:visible'
            )
            .all()) {
            const box = await button.boundingBox();
            assert.ok(
                box && box.width >= 44 && box.height >= 44,
                'primary phone controls have generous tap targets'
            );
        }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await conversation.click();
    const sheet = page.getByRole('dialog', {
        name: 'Conversation actions',
        exact: true,
    });
    await expect(sheet).toBeVisible();
    await expect
        .poll(async () => {
            const box = await sheet.boundingBox();
            return box ? Math.abs(box.y + box.height - 844) : Infinity;
        })
        .toBeLessThan(2);
    await page.keyboard.press('Shift+Tab');
    assert.equal(
        await sheet.evaluate((node) => node.contains(document.activeElement)),
        true
    );
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(conversation).toBeFocused();
    await conversation.click();
    await page.mouse.click(12, 12);
    await expect(sheet).toHaveCount(0);

    await conversation.click();
    await page
        .getByRole('menuitem', {
            name: 'Search this conversation',
            exact: true,
        })
        .click();
    await expect(
        page.getByRole('textbox', { name: 'Search messages', exact: true })
    ).toBeFocused();
    await page
        .getByRole('button', { name: 'Close search', exact: true })
        .click();

    await options.click();
    await page
        .getByRole('menuitem', { name: 'Formatting help', exact: true })
        .click();
    await expect(
        page.getByRole('dialog', { name: 'Format your messages', exact: true })
    ).toBeVisible();
    await page
        .getByRole('button', { name: 'Close formatting help', exact: true })
        .click();
    await expect(composer).toBeFocused();

    await options.click();
    const fileChooser = page.waitForEvent('filechooser');
    await page
        .getByRole('menuitem', {
            name: 'Attach file (up to 256 MB)',
            exact: true,
        })
        .click();
    await (
        await fileChooser
    ).setFiles({
        name: 'mobile-example.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Synthetic mobile attachment'),
    });
    await expect(page.locator('.attachment-preview')).toContainText(
        'mobile-example.txt'
    );
    await page
        .getByRole('button', { name: 'Remove attachment', exact: true })
        .click();
    await options.click();
    await page
        .getByRole('menuitem', { name: 'Add emoji', exact: true })
        .click();
    await expect(
        page.getByRole('dialog', { name: 'Emoji picker', exact: true })
    ).toBeVisible();
    await page.locator('.emoji-grid button').first().click();
    await expect(composer).toBeFocused();
    await expect.poll(() => inputText(composer)).not.toBe('');

    const sent = 'A message from the mobile layout.\nWith a second line.';
    if (touch) {
        await composer.fill('A message from the mobile layout.');
        await composer.press('Enter');
        await page.keyboard.type('With a second line.');
        await expectInput(composer, sent);
        await page
            .getByRole('button', { name: 'Send message', exact: true })
            .tap();
    } else {
        await composer.fill(sent);
        await page
            .getByRole('button', { name: 'Send message', exact: true })
            .click();
    }
    await expect(peer.getByText(sent, { exact: true })).toBeVisible();
    await expect(composer).toBeFocused();
    await expectInput(composer, '');
    await expect(
        page.getByRole('button', { name: 'Record voice note', exact: true })
    ).toBeVisible();

    for (let i = 0; i < 14; i++) {
        await peer
            .locator('.composer [role="textbox"]')
            .fill(
                `Mobile scroll example ${i + 1}.\nA little more text to check reading position.`
            );
        await peer
            .getByRole('button', { name: 'Send message', exact: true })
            .click();
    }
    await expect(
        page.getByText('Mobile scroll example 14.', { exact: false })
    ).toBeVisible();
    const distanceFromBottom = () =>
        page
            .locator('.message-scroll')
            .evaluate(
                (node) => node.scrollHeight - node.clientHeight - node.scrollTop
            );
    await expect.poll(distanceFromBottom).toBeLessThan(2);
    await page.screenshot({ path: 'test-results/mobile-polish-dark.png' });

    // Desktop emulation cannot open an OS keyboard. Exercise the same viewport
    // events Safari emits, including its offset, without changing the layout viewport.
    await page.evaluate(() => {
        const viewport = window.visualViewport!;
        const names = ['height', 'offsetTop', 'scale'] as const;
        const descriptors = names.map((name) =>
            Object.getOwnPropertyDescriptor(viewport, name)
        );
        window.__mobileViewportTest = {
            resize(height, top, scale = 1) {
                for (const [name, value] of Object.entries({
                    height,
                    offsetTop: top,
                    scale,
                }))
                    Object.defineProperty(viewport, name, {
                        configurable: true,
                        value,
                    });
                viewport.dispatchEvent(new Event('resize'));
                viewport.dispatchEvent(new Event('scroll'));
            },
            restore() {
                names.forEach((name, index) => {
                    if (descriptors[index])
                        Object.defineProperty(
                            viewport,
                            name,
                            descriptors[index]!
                        );
                    else Reflect.deleteProperty(viewport, name);
                });
                viewport.dispatchEvent(new Event('resize'));
                delete window.__mobileViewportTest;
            },
        };
        window.__mobileViewportTest.resize(360, 60);
    });
    try {
        await expect
            .poll(
                async () =>
                    (await page.locator('.app-shell').boundingBox())?.height
            )
            .toBe(360);
        const input = await page.locator('.composer').boundingBox();
        const header = await page.locator('.conversation-header').boundingBox();
        assert.ok(input && input.y + input.height <= 420);
        assert.ok(header && header.y === 60);
        await expect.poll(distanceFromBottom).toBeLessThan(2);
        await page.screenshot({
            path: 'test-results/mobile-keyboard-layout.png',
        });

        await page.locator('.message-scroll').evaluate((node) => {
            node.scrollTop = 60;
        });
        await expect
            .poll(() =>
                page
                    .locator('.message-scroll')
                    .evaluate((node) => node.scrollTop)
            )
            .toBe(60);
        await page.evaluate(() => window.__mobileViewportTest!.resize(460, 0));
        await expect
            .poll(
                async () =>
                    (await page.locator('.app-shell').boundingBox())?.height
            )
            .toBe(460);
        assert.equal(
            await page
                .locator('.message-scroll')
                .evaluate((node) => node.scrollTop),
            60,
            'resizing preserves the position while reading earlier messages'
        );

        await page.evaluate(() =>
            window.__mobileViewportTest!.resize(230, 30, 2)
        );
        await page.evaluate(() => new Promise(requestAnimationFrame));
        assert.equal(
            (await page.locator('.app-shell').boundingBox())?.height,
            460,
            'pinch zoom does not shrink and reflow the app'
        );
    } finally {
        await page.evaluate(() => window.__mobileViewportTest?.restore());
    }

    await conversation.click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    await page.getByRole('radio', { name: 'Light', exact: true }).check();
    await page.getByRole('radio', { name: 'Large', exact: true }).check();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.setViewportSize({ width: 320, height: 640 });
    assert.equal(
        await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth
        ),
        false
    );
    await page.screenshot({
        path: 'test-results/mobile-polish-light-large.png',
    });
    await conversation.click();
    await page.screenshot({ path: 'test-results/mobile-action-sheet.png' });
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    await page.getByRole('radio', { name: 'Dark', exact: true }).check();
    await page.getByRole('radio', { name: 'Comfortable', exact: true }).check();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    console.log(
        'PASS: compact mobile controls, action sheets, settings, attachments, emoji, sending focus, keyboard viewport, scroll position, and zoom'
    );
}
