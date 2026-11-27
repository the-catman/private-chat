import { expect, type Page } from '@playwright/test';
import { imageHostPng } from './file-checks';
import { expectInput } from './message-input';

async function send(page: Page, text: string) {
    const composer = page.locator('.composer [role="textbox"]');
    await composer.fill(text);
    await composer.press('Enter');
    await expectInput(composer, '');
}

async function setStatus(page: Page, status: string) {
    await page
        .getByRole('button', { name: /Change status or profile$/ })
        .click();
    await page
        .getByRole('menuitemradio', { name: status, exact: true })
        .click();
}

async function editProfile(
    page: Page,
    edit: (dialog: ReturnType<Page['getByRole']>) => Promise<void>
) {
    await page
        .getByRole('button', { name: /Change status or profile$/ })
        .click();
    await page
        .getByRole('menuitem', { name: 'Edit profile', exact: true })
        .click();
    const dialog = page.getByRole('dialog', { name: 'Profile', exact: true });
    await edit(dialog);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
}

// Statuses, renames, encrypted pictures and status text, and profile cards.
export async function checkProfiles(alice: Page, bob: Page) {
    for (const page of [alice, bob])
        await page
            .locator('.channel-row')
            .filter({ hasText: 'general' })
            .click();
    await send(bob, 'Before the rename');
    const earlier = alice.getByTestId('chat-message').filter({
        has: alice.getByText('Before the rename', { exact: true }),
    });
    await expect(earlier).toBeVisible();

    await editProfile(bob, async (dialog) => {
        await dialog.getByLabel('Choose profile picture').setInputFiles({
            name: 'me.png',
            mimeType: 'image/png',
            buffer: imageHostPng,
        });
        await expect(dialog.locator('.avatar img')).toBeVisible();
        await dialog.getByLabel('Name', { exact: true }).fill('Bobby');
        await dialog.getByLabel('Status', { exact: true }).fill('Back at 6');
    });
    // Alice sees the new name everywhere, including on earlier messages.
    await expect(alice.locator('.presence-event.renamed').last()).toContainText(
        'Bob is now Bobby'
    );
    await expect(earlier.locator('.author-name')).toHaveText('Bobby');
    const row = alice.locator('.dm-row').filter({ hasText: 'Bobby' });
    await expect(row).toContainText('Back at 6');
    // The picture is resized to a small square before it is encrypted.
    await expect
        .poll(() =>
            row
                .locator('.avatar img')
                .evaluate((node: HTMLImageElement) => node.naturalWidth)
        )
        .toBe(128);

    // The profile card opens from a message and closes on Escape.
    const name = earlier.locator('.author-name button');
    await name.click();
    const card = alice.getByRole('dialog', {
        name: 'Profile: Bobby',
        exact: true,
    });
    await expect(card).toContainText('Back at 6');
    await expect(card).toContainText('Online');
    await alice.screenshot({ path: 'test-results/profile-card.png' });
    await alice.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await expect(name).toBeFocused();
    await name.click();
    await card.getByRole('button', { name: 'Message', exact: true }).click();
    await expect(
        alice.getByRole('heading', { name: 'Bobby', exact: true })
    ).toBeVisible();

    await setStatus(bob, 'Do not disturb');
    await expect(row.locator('.status-dot.dnd')).toBeVisible();
    await expect(
        bob.getByRole('menuitemradio', { name: 'Do not disturb' })
    ).toHaveCount(0);

    // Invisible looks offline and leaves quietly, but DMs still arrive.
    await setStatus(bob, 'Invisible');
    await expect(row.locator('.status-dot.offline')).toBeVisible();
    await expect(
        alice.getByRole('button', { name: 'Start voice call', exact: true })
    ).toBeDisabled();
    await send(alice, 'Are you around?');
    await bob.locator('.dm-row').filter({ hasText: 'Alice' }).click();
    await expect(
        bob.getByText('Are you around?', { exact: true })
    ).toBeVisible();
    await alice.locator('.channel-row').filter({ hasText: 'general' }).click();
    await expect(
        alice.locator('.presence-event').filter({ hasText: 'Bobby left' })
    ).toHaveCount(0);

    // Back to how the other checks expect Bob.
    await setStatus(bob, 'Online');
    await editProfile(bob, async (dialog) => {
        await dialog
            .getByRole('button', { name: 'Remove', exact: true })
            .click();
        await dialog.getByLabel('Name', { exact: true }).fill('Bob');
        await dialog.getByLabel('Status', { exact: true }).fill('');
    });
    const back = alice.locator('.dm-row').filter({ hasText: 'Bob' });
    await expect(back.locator('.status-dot.online')).toBeVisible();
    await expect(back.locator('.avatar img')).toHaveCount(0);
    await expect(back).not.toContainText('Back at 6');
    await bob.locator('.channel-row').filter({ hasText: 'general' }).click();
    console.log(
        'PASS: statuses, invisible DMs, renames, encrypted pictures and status text, and profile cards'
    );
}
