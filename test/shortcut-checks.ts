import { expect, type Page } from '@playwright/test';

const row = (page: Page, text: string) =>
    page.getByTestId('chat-message').filter({
        has: page.getByText(text, { exact: true }),
    });

async function send(page: Page, text: string, displayed = text) {
    await page.locator('.composer textarea').fill(text);
    await page.keyboard.press('Enter');
    await expect(
        row(page, displayed).locator('.message-delivery')
    ).toHaveAttribute('title', 'Received by the server, encrypted');
}

export async function checkMessageShortcuts(alice: Page, bob: Page) {
    for (const page of [alice, bob])
        await page
            .locator('.channel-row')
            .filter({ hasText: 'The living room' })
            .click();
    const composer = alice.locator('.composer textarea');
    const editor = alice.getByRole('textbox', {
        name: 'Edit message',
        exact: true,
    });
    const dialog = alice.getByRole('dialog', {
        name: 'Delete this message?',
        exact: true,
    });
    await send(alice, 'An older shortcut message.');
    await send(alice, 'The latest shortcut message.');
    await send(bob, 'Bob owns this shortcut message.');

    await composer.fill('Keep my unfinished draft');
    await composer.press('ArrowUp');
    await expect(editor).toHaveCount(0);
    await expect(composer).toHaveValue('Keep my unfinished draft');
    await composer.fill('');
    await composer.press('Control+ArrowUp');
    await composer.press('Shift+ArrowUp');
    await expect(editor).toHaveCount(0);
    await composer.press('ArrowUp');
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue('The latest shortcut message.');
    await editor.fill('The latest shortcut message, edited.');
    await editor.press('Enter');
    await expect(
        row(bob, 'The latest shortcut message, edited.')
    ).toBeVisible();
    await expect(composer).toBeFocused();

    await row(alice, 'An older shortcut message.').click({
        button: 'right',
        modifiers: ['Control'],
    });
    await expect(editor).toHaveValue('An older shortcut message.');
    await expect(editor).toBeFocused();
    await expect(alice.getByRole('menu')).toHaveCount(0);
    await editor.fill('');
    await expect(dialog).toHaveCount(0);
    await editor.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(row(bob, 'An older shortcut message.')).toBeVisible();
    await alice.keyboard.press('Escape');
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue('');
    await editor.fill('An older shortcut message, kept.');
    await alice.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(row(bob, 'An older shortcut message, kept.')).toBeVisible();
    await row(alice, 'An older shortcut message, kept.').click({
        button: 'right',
        modifiers: ['Control'],
    });
    await editor.fill(' \n\t ');
    await alice.getByRole('button', { name: 'Delete…', exact: true }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue(' \n\t ');
    await editor.press('Enter');
    await dialog
        .getByRole('button', { name: 'Delete for everyone', exact: true })
        .click();
    await expect(dialog).toHaveCount(0);
    await expect(editor).toHaveCount(0);
    for (const page of [alice, bob])
        await expect(row(page, 'An older shortcut message, kept.')).toHaveCount(
            0
        );
    await expect(composer).toBeFocused();

    const latest = row(alice, 'The latest shortcut message, edited.');
    await latest.click({ modifiers: ['Control'] });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(latest).toBeVisible();
    await latest.click({ modifiers: ['Control'] });
    await dialog
        .getByRole('button', { name: 'Delete for everyone', exact: true })
        .click();
    for (const page of [alice, bob])
        await expect(
            row(page, 'The latest shortcut message, edited.')
        ).toHaveCount(0);

    await send(alice, 'Delete this immediately.');
    await row(alice, 'Delete this immediately.').click({
        modifiers: ['Control', 'Shift'],
    });
    await expect(dialog).toHaveCount(0);
    for (const page of [alice, bob])
        await expect(row(page, 'Delete this immediately.')).toHaveCount(0);
    await expect(composer).toBeFocused();

    const other = row(alice, 'Bob owns this shortcut message.');
    await other.click({ modifiers: ['Control'] });
    await expect(dialog).toHaveCount(0);
    await other.click({ button: 'right', modifiers: ['Control'] });
    await expect(editor).toHaveCount(0);
    await other.click({ modifiers: ['Control', 'Shift'] });
    await expect(other).toBeVisible();
    await expect(row(bob, 'Bob owns this shortcut message.')).toBeVisible();

    // Ctrl-click keeps its ordinary meaning on links and message controls.
    const linkUrl = new URL('/shortcut-link-test', alice.url()).href;
    await alice.context().route(linkUrl, (route) =>
        route.fulfill({
            body: 'Synthetic link target',
            contentType: 'text/plain',
        })
    );
    await send(alice, `[Shortcut test link](${linkUrl})`, 'Shortcut test link');
    const link = alice.getByRole('link', {
        name: 'Shortcut test link',
        exact: true,
    });
    const linkRow = alice.getByTestId('chat-message').filter({ has: link });
    // Links use noopener, so the new tab belongs to the context, not this page.
    const popupOpened = alice.context().waitForEvent('page');
    await link.click({ modifiers: ['Control'] });
    const popup = await popupOpened;
    await popup.waitForLoadState('domcontentloaded');
    await popup.close();
    await alice.context().unroute(linkUrl);
    await expect(dialog).toHaveCount(0);
    await expect(linkRow).toBeVisible();
    await linkRow
        .getByRole('button', {
            name: 'Actions for message from Alice',
            exact: true,
        })
        .click({ modifiers: ['Control'] });
    await expect(alice.getByRole('menu')).toBeVisible();
    await alice
        .getByRole('menuitem', { name: 'Select message', exact: true })
        .click();
    await expect(linkRow.getByRole('checkbox')).toBeChecked();
    await linkRow.getByRole('checkbox').click({ modifiers: ['Control'] });
    await expect(linkRow.getByRole('checkbox')).not.toBeChecked();
    await expect(dialog).toHaveCount(0);
    await alice.keyboard.press('Escape');

    await alice.getByLabel('Choose attachment').setInputFiles({
        name: 'shortcut.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Synthetic shortcut attachment'),
    });
    await alice
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
    const file = alice.getByTestId('chat-message').filter({
        has: alice.getByRole('link', {
            name: 'Download shortcut.txt',
            exact: true,
        }),
    });
    await expect(file.locator('.message-delivery')).toHaveAttribute(
        'title',
        'Received by the server, encrypted'
    );
    await file
        .locator('.author-name')
        .click({ button: 'right', modifiers: ['Control'] });
    await expect(editor).toHaveCount(0);
    await file
        .locator('.author-name')
        .click({ modifiers: ['Control', 'Shift'] });
    for (const page of [alice, bob])
        await expect(
            page.getByRole('link', {
                name: 'Download shortcut.txt',
                exact: true,
            })
        ).toHaveCount(0);

    await alice.locator('.dm-row').filter({ hasText: 'Bob' }).click();
    await bob.locator('.dm-row').filter({ hasText: 'Alice' }).click();
    await send(alice, 'A private shortcut message.');
    await composer.press('ArrowUp');
    await expect(editor).toHaveValue('A private shortcut message.');
    await editor.fill('A private shortcut edit.');
    await editor.press('Enter');
    await expect(row(bob, 'A private shortcut edit.')).toBeVisible();
    await row(alice, 'A private shortcut edit.').click({
        modifiers: ['Control', 'Shift'],
    });
    for (const page of [alice, bob]) {
        await expect(row(page, 'A private shortcut edit.')).toHaveCount(0);
        await page
            .locator('.channel-row')
            .filter({ hasText: 'The living room' })
            .click();
        await expect(
            row(page, 'Bob owns this shortcut message.')
        ).toBeVisible();
    }
    console.log(
        'PASS: Up Arrow, Ctrl-click/right-click, Shift bypass, blank-edit confirmation/cancel, ownership, interactive controls, files and DM shortcuts'
    );
}
