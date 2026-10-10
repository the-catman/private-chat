import type { Content } from '../types';
import { MAX_FILE_BYTES } from './limits';

export function validateContent(value: unknown): Content {
    if (!value || typeof value !== 'object')
        throw new Error('Invalid message.');
    const payload = value as Content;
    if (
        payload.kind === 'text' &&
        typeof payload.text === 'string' &&
        payload.text.length <= 4000
    )
        return payload;
    if (
        payload.kind === 'voice' &&
        typeof payload.audio === 'string' &&
        payload.audio.length <= 2_000_000 &&
        /^[A-Za-z0-9_-]+$/.test(payload.audio) &&
        /^audio\/(webm|ogg|mp4)(;codecs=opus)?$/.test(payload.mime) &&
        Number.isFinite(payload.duration) &&
        payload.duration >= 0 &&
        payload.duration <= 125
    )
        return payload;
    if (
        payload.kind === 'file' &&
        typeof payload.data === 'string' &&
        Number.isSafeInteger(payload.size) &&
        payload.size >= 0 &&
        payload.size <= MAX_FILE_BYTES &&
        payload.data.length === Math.ceil((payload.size * 4) / 3) &&
        /^[A-Za-z0-9_-]*$/.test(payload.data) &&
        typeof payload.name === 'string' &&
        payload.name.length > 0 &&
        payload.name.length <= 255 &&
        typeof payload.mime === 'string' &&
        payload.mime.length <= 128
    )
        return payload;
    throw new Error('Invalid message or attachment.');
}

export const fileSize = (bytes: number) =>
    bytes >= 1024 * 1024
        ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
        : bytes >= 1024
          ? `${(bytes / 1024).toFixed(1)} KB`
          : `${bytes} B`;
