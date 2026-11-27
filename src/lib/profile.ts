import type { Status } from '../types';
import { AVATAR_BYTES, AVATAR_SIZE } from './limits';
import { statusText } from './content';
import { b64 } from './crypto';

// This person's own status and profile are preferences kept in this browser,
// and sent again after each server restart.
export type OwnStatus = Exclude<Status, 'idle'>;
export type OwnProfile = { text: string; avatar?: string };

const STATUS_KEY = 'hush-status';
const PROFILE_KEY = 'hush-profile';
const read = (key: string) => {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
};
const write = (key: string, value: string | null) => {
    try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch {}
};

export function storedStatus(): OwnStatus {
    const value = read(STATUS_KEY);
    return value === 'dnd' || value === 'invisible' ? value : 'online';
}
export function storeStatus(status: OwnStatus) {
    write(STATUS_KEY, status);
}

export function storedProfile(): OwnProfile {
    try {
        const value = JSON.parse(read(PROFILE_KEY) || '{}');
        return {
            text: typeof value.text === 'string' ? statusText(value.text) : '',
            ...(typeof value.avatar === 'string' &&
                value.avatar && { avatar: value.avatar }),
        };
    } catch {
        return { text: '' };
    }
}
export function storeProfile(profile: OwnProfile) {
    write(
        PROFILE_KEY,
        profile.text || profile.avatar ? JSON.stringify(profile) : null
    );
}

// Square-crops and shrinks a picture so it fits in an encrypted profile.
export async function resizeAvatar(file: Blob) {
    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(file);
    } catch {
        throw new Error('That file is not an image this browser can open.');
    }
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = AVATAR_SIZE;
    const context = canvas.getContext('2d')!;
    context.imageSmoothingQuality = 'high';
    context.drawImage(
        bitmap,
        (bitmap.width - side) / 2,
        (bitmap.height - side) / 2,
        side,
        side,
        0,
        0,
        AVATAR_SIZE,
        AVATAR_SIZE
    );
    bitmap.close();
    for (const [type, quality] of [
        ['image/webp', 0.9],
        ['image/webp', 0.75],
        ['image/jpeg', 0.85],
        ['image/jpeg', 0.6],
    ] as const) {
        const blob = await new Promise<Blob | null>((done) =>
            canvas.toBlob(done, type, quality)
        );
        // Some browsers fall back to PNG when they cannot write WebP.
        if (blob && blob.type === type && blob.size <= AVATAR_BYTES)
            return b64(new Uint8Array(await blob.arrayBuffer()));
    }
    throw new Error('Could not shrink that picture. Try another one.');
}
