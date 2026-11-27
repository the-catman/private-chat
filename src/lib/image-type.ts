// Raster formats browsers decode safely as images, recognized by their bytes
// rather than by a file name or a server's Content-Type. SVG never qualifies.
export type ImageMime =
    'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/avif';

export function imageType(bytes: Uint8Array): ImageMime | null {
    const starts = (...signature: number[]) =>
        signature.every((byte, i) => bytes[i] === byte);
    if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
        return 'image/png';
    if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
    const header = String.fromCharCode(...bytes.subarray(0, 12));
    if (/^GIF8[79]a/.test(header)) return 'image/gif';
    if (header.startsWith('RIFF') && header.slice(8) === 'WEBP')
        return 'image/webp';
    if (/^ftypavi[fs]$/.test(header.slice(4))) return 'image/avif';
    return null;
}
