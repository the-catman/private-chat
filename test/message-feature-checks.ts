import { expect, type Page } from '@playwright/test';
import { expectInput } from './message-input';

const row = (page: Page, text: string) =>
    page.getByTestId('chat-message').filter({
        has: page.locator('.message-text').getByText(text, { exact: true }),
    });

async function send(page: Page, text: string) {
    const composer = page.locator('.composer [role="textbox"]');
    await composer.fill(text);
    await composer.press('Enter');
    await expectInput(composer, '');
}

// Reactions, replies, mentions and pins, between two people in the room.
export async function checkMessageFeatures(alice: Page, bob: Page) {
    for (const page of [alice, bob])
        await page
            .locator('.channel-row')
            .filter({ hasText: 'general' })
            .click();
    const question = 'Lunch at noon, @Alice?';
    await send(bob, question);
    const asked = row(alice, question);
    await expect(asked).toHaveClass(/\bmentioned\b/);
    await expect(asked.locator('.mention.me')).toHaveText('@Alice');
    await expect(row(bob, question)).not.toHaveClass(/\bmentioned\b/);
    await expect(row(bob, question).locator('.mention')).toHaveText('@Alice');

    // React from the hover toolbar, then join in and take it back.
    await asked.hover();
    await asked
        .getByRole('button', { name: 'Add reaction', exact: true })
        .click();
    const picker = alice.getByRole('dialog', { name: 'Emoji picker' });
    await picker
        .getByRole('textbox', { name: 'Search emojis', exact: true })
        .fill('wave');
    await picker
        .getByRole('button', { name: 'Insert :wave:', exact: true })
        .click();
    await expect(picker).toHaveCount(0);
    const chip = (page: Page, count: number) =>
        row(page, question).getByRole('button', {
            name: new RegExp(`^👋 ${count}:`),
        });
    await expect(chip(bob, 1)).toHaveAttribute('aria-pressed', 'false');
    await chip(bob, 1).click();
    await expect(chip(alice, 2)).toHaveAttribute('aria-pressed', 'true');
    await expect(chip(bob, 2)).toHaveAttribute('title', 'Alice, Bob');
    await chip(alice, 2).click();
    await expect(chip(bob, 1)).toHaveAttribute('title', 'Bob');

    // Reply, with the quote leading back to the original.
    await asked.hover();
    await asked.getByRole('button', { name: 'Reply', exact: true }).click();
    const composer = alice.locator('.composer [role="textbox"]');
    await expect(composer).toBeFocused();
    await expect(alice.locator('.reply-bar')).toContainText('Replying to Bob');
    await composer.press('Escape');
    await expect(alice.locator('.reply-bar')).toHaveCount(0);
    await asked.hover();
    await asked.getByRole('button', { name: 'Reply', exact: true }).click();
    await send(alice, 'Sounds good');
    await expect(alice.locator('.reply-bar')).toHaveCount(0);
    const answer = row(bob, 'Sounds good');
    await expect(answer.locator('.reply-quote')).toContainText(
        `Bob${question}`
    );
    // A reply to your message counts as mentioning you.
    await expect(answer).toHaveClass(/\bmentioned\b/);
    await answer.locator('.reply-quote').click();
    await expect(row(bob, question)).toBeFocused();

    // Mentions complete from the people in the conversation.
    await composer.fill('Thanks @Bo');
    const suggestions = alice.getByRole('listbox', {
        name: 'Mention suggestions',
    });
    await expect(suggestions.getByRole('option')).toHaveText(['@Bob']);
    await composer.press('Tab');
    await expectInput(composer, 'Thanks @Bob ');
    await expect(suggestions).toHaveCount(0);
    await composer.fill('');

    // Anyone in the room can pin; everyone sees it and can jump to it.
    await row(bob, question).click({ button: 'right' });
    await bob
        .getByRole('menuitem', { name: 'Pin message', exact: true })
        .click();
    const pins = alice.getByRole('button', {
        name: 'Pinned messages',
        exact: true,
    });
    await expect(asked.locator('.pinned-note')).toHaveText('Pinned');
    await pins.click();
    const panel = alice.getByRole('dialog', { name: 'Pinned messages' });
    await expect(panel.locator('.pinned-item')).toContainText(question);
    await alice.screenshot({ path: 'test-results/message-features.png' });
    await alice.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(pins).toBeFocused();
    await pins.click();
    await panel.locator('.pinned-item').click();
    await expect(panel).toHaveCount(0);
    await expect(asked).toBeFocused();
    await pins.click();
    await panel
        .getByRole('button', { name: 'Unpin message from Bob', exact: true })
        .click();
    for (const page of [alice, bob]) {
        await expect(
            page.getByRole('button', { name: 'Pinned messages', exact: true })
        ).toHaveCount(0);
        await expect(row(page, question).locator('.pinned-note')).toHaveCount(
            0
        );
    }
    console.log(
        'PASS: mentions, reactions, replies with jump-back, mention completion and pins'
    );
}
