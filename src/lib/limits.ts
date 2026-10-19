// Keep file contents, filenames, and MIME types inside the encrypted payload.
// File bytes travel as separately encrypted binary parts after a signed message.
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
export const PART_BYTES = 1024 * 1024;
export const MAX_PARTS = MAX_FILE_BYTES / PART_BYTES;
// A part frame is a 36-byte message ID, a 4-byte index, then AES-GCM output.
export const PART_HEADER = 40;
export const partCount = (size: number) =>
    Math.max(1, Math.ceil(size / PART_BYTES));
// Larger files download only when someone opens them.
export const AUTO_FETCH_BYTES = 8 * 1024 * 1024;
// Bump when client and relay must be restarted together.
export const PROTOCOL = 5;
export const MAX_ENCRYPTED_LENGTH = 2_800_000;
export const MAX_BATCH = 100;
export const normalizeName = (name: string) =>
    name.normalize('NFKC').trim().replace(/\s+/gu, ' ');
export const nameKey = (name: string) => normalizeName(name).toLowerCase();
export const validName = (name: string) =>
    name.length > 0 && name.length <= 32 && !/[\p{Cc}\p{Cf}]/u.test(name);
