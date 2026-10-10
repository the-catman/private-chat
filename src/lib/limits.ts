// Keep file contents, filenames, and MIME types inside the encrypted payload.
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ENCRYPTED_LENGTH = 9_400_000;
export const MAX_BATCH = 100;
export const normalizeName = (name: string) =>
    name.normalize('NFKC').trim().replace(/\s+/gu, ' ');
export const nameKey = (name: string) => normalizeName(name).toLowerCase();
export const validName = (name: string) =>
    name.length > 0 && name.length <= 32 && !/[\p{Cc}\p{Cf}]/u.test(name);
