import { expect, type Page } from '@playwright/test';
import { expectInput } from './message-input';

async function send(page: Page, text: string) {
    const composer = page.locator('.composer [role="textbox"]');
    await composer.fill(text);
    await composer.press('Enter');
    await expectInput(composer, '');
}

const favicon = (page: Page) => page.locator('link[rel="icon"]');

async function setHidden(page: Page, hidden: boolean) {
    await page.evaluate((hide) => {
        if (hide)
            Object.defineProperty(document, 'visibilityState', {
                configurable: true,
                value: 'hidden',
            });
        else delete (document as { visibilityState?: unknown }).visibilityState;
        document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
}

async function conversationAction(page: Page, name: string) {
    await page
        .getByRole('button', { name: 'Conversation actions', exact: true })
        .click();
    await page.getByRole('menuitem', { name, exact: true }).click();
}

// The unread count in the tab title and icon, muting, and what a hidden tab
// counts.
export async function checkNotifications(alice: Page, bob: Page) {
    const general = (page: Page) =>
        page.locator('.channel-row').filter({ hasText: 'general' });
    await general(alice).click();
    await expect(alice).toHaveTitle('Hush');
    await expect(favicon(alice)).toHaveAttribute('data-unread', 'false');

    await bob.locator('.dm-row').filter({ hasText: 'Alice' }).click();
    await send(bob, 'A quick question');
    await expect(alice).toHaveTitle('(1) Hush');
    await expect(favicon(alice)).toHaveAttribute('data-unread', 'true');
    const row = alice.locator('.dm-row').filter({ hasText: 'Bob' });
    await expect(row.locator('.unread-badge')).toHaveText('1');
    await row.click();
    await expect(alice).toHaveTitle('Hush');
    await expect(favicon(alice)).toHaveAttribute('data-unread', 'false');

    // A muted conversation counts only mentions.
    await conversationAction(alice, 'Mute conversation');
    await general(alice).click();
    await send(bob, 'Nothing urgent');
    await expect(row.getByRole('img', { name: 'Muted' })).toBeVisible();
    await expect(row.locator('.unread-badge')).toHaveCount(0);
    await expect(alice).toHaveTitle('Hush');
    await send(bob, '@Alice when you have a minute');
    await expect(alice).toHaveTitle('(1) Hush');
    await expect(row.locator('.unread-badge')).toHaveText('1');
    await row.click();
    await expect(alice).toHaveTitle('Hush');
    await conversationAction(alice, 'Unmute conversation');
    await expect(row.getByRole('img', { name: 'Muted' })).toHaveCount(0);

    // A hidden tab counts the open conversation too, and marks where it
    // left off when it shows again.
    await general(alice).click();
    await general(bob).click();
    await setHidden(alice, true);
    await send(bob, 'Posted while Alice was away');
    await expect(alice).toHaveTitle('(1) Hush');
    await setHidden(alice, false);
    await expect(alice).toHaveTitle('Hush');
    await expect(
        alice
            .locator('.new-divider + *')
            .filter({ hasText: 'Posted while Alice was away' })
    ).toBeVisible();

    // A reload does not count what was already read.
    await alice.reload();
    await expect(general(alice)).toBeVisible();
    await expect(
        alice.getByText('Posted while Alice was away', { exact: true })
    ).toBeVisible({ timeout: 15000 });
    await expect(alice).toHaveTitle('Hush');
    console.log(
        'PASS: unread count in the tab title and icon, muted conversations count mentions, hidden tabs count, reloads do not'
    );
}
