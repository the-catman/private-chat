import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';

// A file above the auto-download size uploads, reaches recipients as a
// click-to-download entry, and never holds back later history on reload.
export async function checkLargeFiles(alice: Page, bob: Page, dir: string) {
    const name = 'synthetic-clip.mp4';
    const path = join(dir, name);
    const data = Buffer.alloc(40 * 1024 * 1024);
    for (let i = 0; i < data.length; i += 997) data[i] = i % 251;
    await writeFile(path, data);
    await alice.getByLabel('Choose attachment').setInputFiles(path);
    await alice
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
    const row = (page: Page) =>
        page.getByTestId('chat-message').filter({ hasText: name });
    await expect(row(alice)).toBeVisible();
    await expect(row(alice)).not.toContainText('Sending', { timeout: 15_000 });
    const fetch = bob.getByRole('button', {
        name: `Download ${name}`,
        exact: true,
    });
    await expect(fetch).toBeVisible();
    await alice.locator('.composer [role="textbox"]').fill('After the clip.');
    await alice
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
    const after = bob.getByText('After the clip.', { exact: true });
    await expect(after).toBeVisible();
    const start = Date.now();
    await bob.reload();
    await expect(after).toBeVisible();
    assert.ok(
        Date.now() - start < 3000,
        'large files do not slow down loading the app'
    );
    const download = bob.waitForEvent('download', { timeout: 15_000 });
    await fetch.click();
    await expect(row(bob)).toContainText('Receiving');
    const saved = join(dir, 'downloaded.mp4');
    await (await download).saveAs(saved);
    assert.ok((await readFile(saved)).equals(data), 'downloaded bytes match');
    await expect(
        bob.getByRole('link', { name: `Download ${name}`, exact: true })
    ).toBeVisible();
}

// Images sent in a DM must open on both sides without breaking the DM.
export async function checkDmImage(alice: Page, bob: Page) {
    const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6b2sAAAAASUVORK5CYII=',
        'base64'
    );
    // Padding after the PNG end keeps it valid but above the auto-download size.
    const large = Buffer.concat([png, Buffer.alloc(12 * 1024 * 1024)]);
    await alice.locator('.dm-row').filter({ hasText: 'Bob' }).click();
    await bob.locator('.dm-row').filter({ hasText: 'Alice' }).click();
    for (const [name, buffer] of [
        ['dm-small.png', png],
        ['dm-large.png', large],
    ] as const) {
        await alice
            .getByLabel('Choose attachment')
            .setInputFiles({ name, mimeType: 'image/png', buffer });
        await alice
            .getByRole('button', { name: 'Send message', exact: true })
            .click();
        await expect(
            alice.getByRole('button', { name: `Preview ${name}`, exact: true })
        ).toBeVisible({ timeout: 10_000 });
        const preview = bob.getByRole('button', {
            name: `Preview ${name}`,
            exact: true,
        });
        if (buffer === large)
            await bob
                .getByRole('button', { name: `Download ${name}`, exact: true })
                .click();
        await expect(preview).toBeVisible({ timeout: 10_000 });
        await preview.click();
        const dialog = bob.getByRole('dialog', { name, exact: true });
        await expect
            .poll(
                () =>
                    dialog
                        .locator('img')
                        .evaluate(
                            (node: HTMLImageElement) => node.naturalWidth
                        ),
                { timeout: 10_000 }
            )
            .toBe(1);
        await dialog
            .getByRole('button', { name: 'Close file preview', exact: true })
            .click();
    }
    await alice.locator('.composer [role="textbox"]').fill('DM still works.');
    await alice
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
    await expect(
        bob.getByText('DM still works.', { exact: true })
    ).toBeVisible();
}
