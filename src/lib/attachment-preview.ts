// Preview only a small set of formats. MIME labels and extensions alone do not
// make an attachment safe to embed; HTML and SVG are always download-only.
export type AttachmentPreview =
    { kind: 'image'; mime: string } | { kind: 'text' } | { kind: 'pdf' };

const textExtensions = new Set([
    'txt',
    'md',
    'csv',
    'log',
    'json',
    'js',
    'jsx',
    'ts',
    'tsx',
    'css',
    'py',
    'rs',
    'go',
    'java',
    'c',
    'h',
    'cpp',
    'hpp',
    'sh',
    'yaml',
    'yml',
    'toml',
]);
export const TEXT_PREVIEW_BYTES = 128 * 1024;

export function attachmentPreview(
    name: string,
    mime: string,
    bytes: Uint8Array
): AttachmentPreview | null {
    const extension = name.split('.').at(-1)?.toLowerCase() || '';
    const type = mime.toLowerCase().split(';')[0].trim();
    if (
        ['html', 'htm', 'xhtml', 'svg', 'svgz'].includes(extension) ||
        /html|svg/.test(type)
    )
        return null;
    const starts = (...signature: number[]) =>
        signature.every((byte, i) => bytes[i] === byte);
    if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
        return { kind: 'image', mime: 'image/png' };
    if (starts(0xff, 0xd8, 0xff)) return { kind: 'image', mime: 'image/jpeg' };
    const header = new TextDecoder().decode(bytes.subarray(0, 12));
    if (/^GIF8[79]a/.test(header)) return { kind: 'image', mime: 'image/gif' };
    if (header.startsWith('RIFF') && header.slice(8) === 'WEBP')
        return { kind: 'image', mime: 'image/webp' };
    if (header.startsWith('%PDF-')) return { kind: 'pdf' };
    if (type === 'text/plain' || textExtensions.has(extension))
        return { kind: 'text' };
    return null;
}

export function attachmentText(bytes: Uint8Array) {
    const truncated = bytes.length > TEXT_PREVIEW_BYTES;
    // Streaming avoids turning a multibyte character at the cutoff into an error.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(0, TEXT_PREVIEW_BYTES),
        { stream: truncated }
    );
    if (/[\u0000-\u0008\u000e-\u001f]/.test(text))
        throw new Error('Binary file');
    return { text, truncated };
}
