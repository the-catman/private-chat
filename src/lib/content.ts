import type { Content } from '../types';
import { MAX_FILE_BYTES, MAX_REACTIONS, partCount } from './limits';

const UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export function validateContent(value: unknown): Content {
    if (!value || typeof value !== 'object')
        throw new Error('Invalid message.');
    const payload = value as Content;
    if (
        payload.kind === 'text' &&
        typeof payload.text === 'string' &&
        payload.text.length <= 4000 &&
        (payload.reply === undefined ||
            (typeof payload.reply === 'string' && UUID.test(payload.reply)))
    )
        return payload.reply === undefined
            ? { kind: 'text', text: payload.text }
            : { kind: 'text', text: payload.text, reply: payload.reply };
    if (
        payload.kind === 'voice' &&
        typeof payload.audio === 'string' &&
        payload.audio.length <= 2_000_000 &&
        // A length of 4n+1 is not valid base64 and would throw when played.
        payload.audio.length % 4 !== 1 &&
        /^[A-Za-z0-9_-]+$/.test(payload.audio) &&
        typeof payload.mime === 'string' &&
        /^audio\/(webm|ogg|mp4)(;codecs=opus)?$/.test(payload.mime) &&
        Number.isFinite(payload.duration) &&
        payload.duration >= 0 &&
        payload.duration <= 125
    )
        return payload;
    if (
        payload.kind === 'file' &&
        Number.isSafeInteger(payload.size) &&
        payload.size >= 0 &&
        payload.size <= MAX_FILE_BYTES &&
        Array.isArray(payload.hashes) &&
        payload.hashes.length === partCount(payload.size) &&
        payload.hashes.every(
            (hash) =>
                typeof hash === 'string' && /^[A-Za-z0-9_-]{43}$/.test(hash)
        ) &&
        typeof payload.name === 'string' &&
        payload.name.length > 0 &&
        payload.name.length <= 255 &&
        typeof payload.mime === 'string' &&
        payload.mime.length <= 128
    ) {
        // Direction overrides could make a .exe file name read as a PDF.
        const name = payload.name.replace(BIDI_CONTROLS, '');
        return name === payload.name
            ? payload
            : { ...payload, name: name || 'file' };
    }
    throw new Error('Invalid message or attachment.');
}

export const fileSize = (bytes: number) =>
    bytes >= 1024 * 1024
        ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
        : bytes >= 1024
          ? `${(bytes / 1024).toFixed(1)} KB`
          : `${bytes} B`;

// A reaction is a single emoji: pictographs, flags or keycaps, with their
// modifiers and joiners, and nothing else.
export const validEmoji = (value: unknown): value is string =>
    typeof value === 'string' &&
    value.length <= 32 &&
    /^[\p{Extended_Pictographic}\p{Emoji_Component}\u200d\ufe0f\u20e3]+$/u.test(
        value
    ) &&
    /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value);

export function validateReaction(value: unknown) {
    const reaction = value as { kind?: unknown; emoji?: unknown };
    if (
        !reaction ||
        typeof reaction !== 'object' ||
        reaction.kind !== 'reaction' ||
        !Array.isArray(reaction.emoji) ||
        reaction.emoji.length > MAX_REACTIONS ||
        !reaction.emoji.every(validEmoji) ||
        new Set(reaction.emoji).size !== reaction.emoji.length
    )
        throw new Error('Invalid reaction.');
    return reaction.emoji as string[];
}

export function validatePin(value: unknown) {
    const pin = value as { kind?: unknown; pinned?: unknown };
    if (
        !pin ||
        typeof pin !== 'object' ||
        pin.kind !== 'pin' ||
        typeof pin.pinned !== 'boolean'
    )
        throw new Error('Invalid pin.');
    return pin.pinned;
}
