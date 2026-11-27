import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { expect, type Locator, type Page } from '@playwright/test';

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
const tinyPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6b2sAAAAASUVORK5CYII=',
    'base64'
);
// A synthetic 240×150 gradient, so screenshots show a realistic embed.
export const imageHostPng = (() => {
    const [width, height] = [240, 150];
    const rows = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
            rows.set(
                [60 + x / 2, 90 + y / 2, 200 - x / 3],
                y * (width * 3 + 1) + 1 + x * 3
            );
    const chunk = (type: string, data: Buffer) => {
        const body = Buffer.concat([Buffer.from(type), data]);
        const size = Buffer.alloc(4);
        size.writeUInt32BE(data.length);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(body));
        return Buffer.concat([size, body, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 2, 0, 0, 0], 8);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(rows)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
})();
const loaded = (image: Locator, width = 1) =>
    expect
        .poll(
            () => image.evaluate((node: HTMLImageElement) => node.naturalWidth),
            { timeout: 10_000 }
        )
        .toBe(width);

// Image links show inline, loaded through the server rather than the browser.
export async function checkImageLinks(alice: Page, bob: Page, base: string) {
    for (const page of [alice, bob])
        await page
            .locator('.channel-row')
            .filter({ hasText: 'general' })
            .click();
    const text = `Cat picture ${base}/cat.png and ![a missing one](${base}/missing.png)`;
    await alice.locator('.composer [role="textbox"]').fill(text);
    await alice
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
    const row = bob
        .getByTestId('chat-message')
        .filter({ hasText: 'Cat picture' });
    const embed = row.locator('.message-embeds img');
    await loaded(embed, 240);
    expect(await embed.getAttribute('src')).toBe(
        `/api/image?url=${encodeURIComponent(`${base}/cat.png`)}`
    );
    // A link that is not an image falls back to its description.
    await expect(row.locator('.markdown-image-label')).toHaveText(
        'a missing one'
    );
    await expect(row.locator('img')).toHaveCount(1);
    await row.getByRole('button', { name: 'Open image', exact: true }).click();
    const viewer = bob.getByRole('dialog', { name: 'Image', exact: true });
    await loaded(viewer.locator('.file-preview-body img'), 240);
    await expect(
        viewer.getByRole('link', { name: 'Open original', exact: true })
    ).toHaveAttribute('href', `${base}/cat.png`);
    await bob.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
    // Image attachments also show inline.
    await alice.getByLabel('Choose attachment').setInputFiles({
        name: 'gradient.png',
        mimeType: 'image/png',
        buffer: imageHostPng,
    });
    await alice
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
    await loaded(
        bob
            .getByRole('button', { name: 'Preview gradient.png', exact: true })
            .locator('img'),
        240
    );
    await bob.screenshot({ path: 'test-results/image-links.png' });
    console.log(
        'PASS: image links load through the server proxy, open in a viewer, and fall back when missing; image attachments show inline'
    );
}

export async function checkDmImage(alice: Page, bob: Page) {
    const png = tinyPng;
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
        // Received images show inline as thumbnails.
        await loaded(preview.locator('img'));
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
