import assert from 'node:assert/strict';
import { expect, type Page, type Locator } from '@playwright/test';
import { expectInput, inputText } from './message-input';

function samplePdf() {
    const streams = [
        'BT /F1 20 Tf 30 120 Td (First synthetic page) Tj ET',
        'BT /F1 20 Tf 30 120 Td (Second synthetic page) Tj ET',
    ];
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        ...streams.map(
            (stream) =>
                `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
        ),
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    for (const [i, object] of objects.entries()) {
        offsets.push(pdf.length);
        pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
    }
    const xref = pdf.length;
    pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
    pdf += offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
        .join('');
    return Buffer.from(
        pdf +
            `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
    );
}

async function openSettings(page: Page, mobile: boolean) {
    if (mobile) {
        await page
            .getByRole('button', { name: 'Conversation actions', exact: true })
            .click();
        await page
            .getByRole('menuitem', { name: 'Settings', exact: true })
            .click();
    } else
        await page
            .getByRole('button', { name: 'Settings', exact: true })
            .click();
}

export async function checkUiChanges(page: Page, peer: Page, mobile = false) {
    const prefix = mobile ? 'Mobile' : 'Desktop';
    const composer = page.locator('.composer [role="textbox"]');
    await openSettings(page, mobile);
    const settings = page.getByRole('dialog', {
        name: 'Make yourself comfortable.',
        exact: true,
    });
    for (const method of ['button', 'escape']) {
        await settings
            .getByRole('button', { name: 'Privacy & encryption', exact: true })
            .click();
        await expect(
            page.getByRole('heading', { name: 'Private by design.' })
        ).toBeVisible();
        if (method === 'button')
            await page
                .getByRole('button', { name: 'Sounds good', exact: true })
                .click();
        else await page.keyboard.press('Escape');
        await expect(settings).toBeVisible();
        await expect(
            settings.getByRole('button', {
                name: 'Privacy & encryption',
                exact: true,
            })
        ).toBeFocused();
    }
    await settings.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(settings).toHaveCount(0);
    if (mobile) {
        await page
            .getByRole('button', { name: 'Message options', exact: true })
            .click();
        await page
            .getByRole('menuitem', { name: 'Shortcut help', exact: true })
            .click();
    } else
        await page
            .getByRole('button', { name: 'Shortcut help', exact: true })
            .click();
    const help = page.getByRole('dialog', {
        name: 'Keyboard shortcuts',
        exact: true,
    });
    await expect(help).toContainText('Ctrl + right-click');
    await page.keyboard.press('Escape');
    await expect(help).toHaveCount(0);
    await expect(composer).toBeFocused();

    await composer.pressSequentially('**bold**');
    await composer.press('Backspace');
    await expect(composer.locator('strong')).toHaveText('bol');
    await composer.press('Control+z');
    await expect(composer.locator('strong')).toHaveText('bold');
    await composer.fill('**x**');
    await composer.press('End');
    await composer.press('Backspace');
    await expectInput(composer, '');
    await composer.fill(
        '[unsafe](javascript:alert(1)) <img src="https://tracker.invalid/pixel">'
    );
    await expect(composer.locator('a, img, script, iframe')).toHaveCount(0);
    await composer.fill('');

    const source = `${prefix} **bold** *italic* ~~old~~ and \`code\``;
    await composer.pressSequentially(source);
    await expect(composer.locator('strong')).toHaveText('bold');
    await expect(composer.locator('em')).toHaveText('italic');
    await expect(composer.locator('del')).toHaveText('old');
    await expect(composer.locator('code')).toHaveText('code');
    assert.equal(
        await composer
            .locator('em')
            .evaluate((node) => getComputedStyle(node).fontStyle),
        'italic'
    );
    assert.notEqual(
        await composer
            .locator('em')
            .evaluate((node) => getComputedStyle(node).fontSynthesis),
        'none'
    );
    await expect(page.locator('.draft-preview')).toHaveCount(0);
    await page.screenshot({
        path: `test-results/${prefix.toLowerCase()}-inline-formatting.png`,
    });
    await page
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
    await expectInput(composer, '');
    const row = page
        .getByTestId('chat-message')
        .filter({ hasText: `${prefix} bold` });
    const peerRow = peer
        .getByTestId('chat-message')
        .filter({ hasText: `${prefix} bold` });
    await expect(peerRow.locator('em')).toHaveText('italic');
    await row.getByRole('button', { name: /^Actions for message/ }).click();
    await page
        .getByRole('menuitem', { name: 'Edit message', exact: true })
        .click();
    const editor = page.getByRole('textbox', {
        name: 'Edit message',
        exact: true,
    });
    await expect(editor).toBeFocused();
    await page.keyboard.type(' appended');
    await expect
        .poll(() => inputText(editor))
        .toBe(`${prefix} bold italic old and code appended`);
    await expect(editor.locator('em')).toHaveText('italic');
    if (mobile) {
        await editor.press('Enter');
        await page.keyboard.type('next line');
        await expect(editor).toBeVisible();
        await expect
            .poll(() => inputText(editor))
            .toContain('appended\nnext line');
    }
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(peerRow).toContainText('appended');
    await expect(composer).toBeFocused();

    async function attach(name: string, mimeType: string, buffer: Buffer) {
        await page
            .locator('.composer-wrap input[type="file"]')
            .setInputFiles({ name, mimeType, buffer });
        await page
            .getByRole('button', { name: 'Send message', exact: true })
            .click();
        await expect(
            page.getByRole('link', { name: `Download ${name}`, exact: true })
        ).toBeVisible();
    }
    async function open(name: string) {
        await page
            .getByRole('button', { name: `Preview ${name}`, exact: true })
            .click();
        const dialog = page.getByRole('dialog', { name, exact: true });
        await expect(dialog).toBeVisible();
        return dialog;
    }
    async function close(dialog: Locator) {
        await dialog
            .getByRole('button', { name: 'Close file preview', exact: true })
            .click();
        await expect(dialog).toHaveCount(0);
    }
    const png = `${prefix}-image.png`;
    await attach(
        png,
        'image/png',
        Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6b2sAAAAASUVORK5CYII=',
            'base64'
        )
    );
    const image = await open(png);
    await expect
        .poll(() =>
            image
                .locator('img')
                .evaluate((node: HTMLImageElement) => node.naturalWidth)
        )
        .toBe(1);
    await close(image);
    const codeName = `${prefix}-example.ts`;
    const code =
        'const example = "<script>literal text</script>";\n// Synthetic attachment';
    await attach(codeName, 'text/plain', Buffer.from(code));
    const codeDialog = await open(codeName);
    await expect(codeDialog.locator('pre')).toHaveText(code);
    await expect(codeDialog.locator('script, iframe, object')).toHaveCount(0);
    await close(codeDialog);
    const pdfName = `${prefix}-pages.pdf`;
    await attach(pdfName, 'application/pdf', samplePdf());
    const pdf = await open(pdfName);
    await expect(pdf.locator('canvas')).toBeVisible({ timeout: 20000 });
    assert.ok(
        await pdf.locator('canvas').evaluate((node: HTMLCanvasElement) => {
            const pixels = node
                .getContext('2d')!
                .getImageData(0, 0, node.width, node.height).data;
            let ink = 0;
            for (let i = 0; i < pixels.length; i += 4)
                if (pixels[i] < 100 && pixels[i + 3] > 0) ink++;
            return ink > 50;
        }),
        'the PDF canvas contains rendered text'
    );
    await pdf.getByRole('button', { name: 'Text view', exact: true }).click();
    await expect(pdf.locator('pre')).toContainText('First synthetic page');
    await pdf
        .getByRole('button', { name: 'Next PDF page', exact: true })
        .click();
    await expect(pdf.locator('pre')).toContainText('Second synthetic page');
    await close(pdf);
    // Reopening starts a fresh document and worker in memory.
    const reopened = await open(pdfName);
    await expect(reopened.locator('canvas')).toBeVisible();
    await expect(reopened).toContainText('Page 1 of 2');
    await close(reopened);
    const svgName = `${prefix}-download-only.svg`;
    await attach(
        svgName,
        'image/svg+xml',
        Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg"><script>throw 1</script></svg>'
        )
    );
    await expect(
        page.getByRole('button', { name: `Preview ${svgName}`, exact: true })
    ).toHaveCount(0);
    const brokenPdf = `${prefix}-broken.pdf`;
    await attach(
        brokenPdf,
        'application/pdf',
        Buffer.from('%PDF-1.4\ninvalid synthetic document')
    );
    const broken = await open(brokenPdf);
    await expect(broken.getByRole('status')).toHaveText(
        'This file can’t be previewed. You can still download it.'
    );
    await close(broken);
    console.log(
        `PASS: ${prefix} settings return path, shortcut help, inline formatting, editing caret, images, code, local PDF pages and download-only SVG`
    );
}

export async function checkPanelGestures(page: Page) {
    const trigger = page.getByRole('button', {
        name: 'Message options',
        exact: true,
    });
    const sheet = page.getByRole('dialog', {
        name: 'Message options',
        exact: true,
    });
    await trigger.click();
    await expect(sheet).toBeVisible();
    assert.match(
        await sheet.evaluate((node) => getComputedStyle(node).animationName),
        /mobile-sheet-in/
    );
    async function drag(handle: Locator, x: number, y: number) {
        const box = await handle.boundingBox();
        assert.ok(box);
        const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x + x, start.y + y, { steps: 8 });
        await page.mouse.up();
    }
    // Wait for entry motion before calculating drag coordinates.
    await expect
        .poll(() => sheet.evaluate((node) => node.getAnimations().length))
        .toBe(0);
    await drag(sheet.locator('.sheet-handle'), 0, 22);
    await expect(sheet).toBeVisible();
    await expect
        .poll(() => sheet.evaluate((node) => node.getAnimations().length))
        .toBe(0);
    await drag(sheet.locator('.sheet-handle'), 0, 150);
    await expect(sheet).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page
        .getByRole('button', { name: 'Open navigation', exact: true })
        .click();
    const drawer = page.locator('.sidebar.mobile-open');
    await expect
        .poll(() => drawer.evaluate((node) => node.getAnimations().length))
        .toBe(0);
    await drag(drawer.locator('.space-heading').first(), -180, 0);
    await expect(drawer).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await trigger.click();
    assert.equal(
        await sheet.evaluate((node) => getComputedStyle(node).animationName),
        'none'
    );
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    console.log(
        'PASS: sheet and drawer animation, short-drag recovery, swipe dismissal, focus return and reduced motion'
    );
}
