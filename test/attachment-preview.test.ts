import test from 'node:test';
import assert from 'node:assert/strict';
import {
    attachmentPreview,
    attachmentText,
    TEXT_PREVIEW_BYTES,
} from '../src/lib/attachment-preview';

test('attachment previews require raster signatures and never embed HTML or SVG', () => {
    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    assert.deepEqual(attachmentPreview('image.png', 'image/png', png), {
        kind: 'image',
        mime: 'image/png',
    });
    const encode = (text: string) => new TextEncoder().encode(text);
    assert.equal(
        attachmentPreview('fake.png', 'image/png', encode('<svg/>')),
        null
    );
    assert.equal(attachmentPreview('image.svg', 'image/svg+xml', png), null);
    assert.equal(
        attachmentPreview('page.html', 'text/plain', encode('<h1>hello</h1>')),
        null
    );
    assert.deepEqual(
        attachmentPreview('page.pdf', 'application/pdf', encode('%PDF-1.4\n')),
        { kind: 'pdf' }
    );
    assert.deepEqual(
        attachmentPreview('example.ts', '', encode('const x = 1;')),
        { kind: 'text' }
    );
    assert.equal(
        attachmentPreview('archive.zip', 'application/zip', encode('PK')),
        null
    );
});

test('text previews are bounded UTF-8 text, including a split character at the limit', () => {
    assert.deepEqual(
        attachmentText(
            new TextEncoder().encode('<script>literal text</script>')
        ),
        { text: '<script>literal text</script>', truncated: false }
    );
    const long = new TextEncoder().encode(
        'a'.repeat(TEXT_PREVIEW_BYTES - 1) + '🙂'
    );
    const result = attachmentText(long);
    assert.equal(result.truncated, true);
    assert.equal(result.text.length, TEXT_PREVIEW_BYTES - 1);
    assert.throws(() => attachmentText(Uint8Array.of(0xff, 0x00)));
    assert.throws(() => attachmentText(Uint8Array.of(0x61, 0x00)));
});
