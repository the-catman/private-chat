import { expect, type BrowserContext, type Page } from '@playwright/test';
import { expectInput } from './message-input';

type Person = { context: BrowserContext; page: Page };

async function send(page: Page, text: string) {
    const composer = page.locator('.composer [role="textbox"]');
    await composer.fill(text);
    await composer.press('Enter');
    await expectInput(composer, '');
}

async function create(page: Page, kind: 'Text' | 'Voice', name: string) {
    await page
        .getByRole('button', { name: 'Create channel', exact: true })
        .click();
    const dialog = page.getByRole('dialog', {
        name: 'New channel',
        exact: true,
    });
    await dialog.locator('label').filter({ hasText: kind }).click();
    await expect(dialog.getByLabel(kind, { exact: true })).toBeChecked();
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(dialog).toHaveCount(0);
}

function deleteDialog(page: Page, heading: string) {
    return page.getByRole('dialog', { name: heading, exact: true });
}

const textRow = (page: Page, name: string) =>
    page.locator('.channel-row:not(.voice-channel)').filter({ hasText: name });
const voiceRow = (page: Page, name: string) =>
    page.locator('.voice-channel').filter({ hasText: name });

// Channels anyone creates and deletes, and sharing what someone missed.
export async function checkChannels(alice: Person, bob: Person) {
    const a = alice.page;
    const b = bob.page;
    await create(a, 'Text', 'plans');
    // The creator lands in the new channel; everyone else sees it listed.
    await expect(
        a.getByRole('heading', { name: 'plans', exact: true })
    ).toBeVisible();
    await textRow(b, 'plans').click();
    await expect(
        b.getByRole('heading', { name: 'plans', exact: true })
    ).toBeVisible();
    await send(a, 'Plans start here');
    await expect(
        b.getByText('Plans start here', { exact: true })
    ).toBeVisible();

    // Bob misses a message while offline; Alice shares it in one click.
    await bob.context.setOffline(true);
    await b.evaluate(() =>
        window.__testSockets.forEach((socket) => socket.close())
    );
    await expect(b.locator('.connection-banner')).toBeVisible();
    await send(a, 'Sent while Bob was away');
    await bob.context.setOffline(false);
    await expect(b.locator('.connection-banner')).toHaveCount(0, {
        timeout: 20000,
    });
    const prompt = a.locator('.share-prompt');
    await expect(prompt).toContainText('Bob can’t see 1 earlier message here.');
    await expect(
        b.getByText('Sent while Bob was away', { exact: true })
    ).toHaveCount(0);
    await a.screenshot({ path: 'test-results/share-prompt.png' });
    await prompt.getByRole('button', { name: 'Share', exact: true }).click();
    await expect(
        b.getByText('Sent while Bob was away', { exact: true })
    ).toBeVisible();
    await expect(prompt).toHaveCount(0);

    // A voice channel cannot be deleted while someone is in it.
    await create(a, 'Voice', 'hangout');
    await expect(voiceRow(b, 'hangout')).toBeVisible();
    await voiceRow(b, 'hangout').click();
    await expect(b.getByRole('region', { name: 'Active call' })).toBeVisible();
    await expect(voiceRow(a, 'hangout')).toContainText('1');
    await a
        .getByRole('button', { name: 'Delete channel hangout', exact: true })
        .click();
    const voiceDialog = deleteDialog(a, 'Delete hangout?');
    await voiceDialog
        .getByRole('button', { name: 'Delete channel', exact: true })
        .click();
    await expect(voiceDialog.getByRole('alert')).toHaveText(
        'Someone is in this voice channel. Try again when it is empty.'
    );
    await voiceDialog
        .getByRole('button', { name: 'Cancel', exact: true })
        .click();
    await b.getByRole('button', { name: 'Leave', exact: true }).click();
    await expect(b.getByRole('region', { name: 'Active call' })).toHaveCount(0);
    await expect(voiceRow(a, 'hangout')).not.toContainText('1');
    await a
        .getByRole('button', { name: 'Delete channel hangout', exact: true })
        .click();
    await voiceDialog
        .getByRole('button', { name: 'Delete channel', exact: true })
        .click();
    await expect(voiceDialog).toHaveCount(0);
    await expect(voiceRow(a, 'hangout')).toHaveCount(0);
    await expect(voiceRow(b, 'hangout')).toHaveCount(0);

    // Deleting a text channel asks first, then removes it for everyone.
    await a
        .getByRole('button', { name: 'Delete channel plans', exact: true })
        .click();
    const textDialog = deleteDialog(a, 'Delete #plans?');
    await expect(
        textDialog.getByRole('button', { name: 'Cancel', exact: true })
    ).toBeFocused();
    await a.keyboard.press('Escape');
    await expect(textDialog).toHaveCount(0);
    await expect(textRow(b, 'plans')).toBeVisible();
    await a
        .getByRole('button', { name: 'Delete channel plans', exact: true })
        .click();
    await textDialog
        .getByRole('button', { name: 'Delete channel', exact: true })
        .click();
    await expect(textDialog).toHaveCount(0);
    for (const page of [a, b]) {
        await expect(textRow(page, 'plans')).toHaveCount(0);
        await expect(
            page.getByRole('heading', { name: 'general', exact: true })
        ).toBeVisible();
    }
    console.log(
        'PASS: creating and deleting text and voice channels, the occupied voice guard, and the share prompt'
    );
}
