import type { Message } from '../types';
import { mentions } from './mentions';

// A read mark is the server time of the latest message seen in a
// conversation. Marks are kept for one server boot, like session keys, so a
// reload or a reconnect does not count old messages again.
export type Marks = Record<string, number>;
const READ_KEY = 'hush-read';
const MUTED_KEY = 'hush-muted';
const MAX_MUTED = 200;

export function storedMarks(boot: string): Marks {
    try {
        const value = JSON.parse(localStorage.getItem(READ_KEY) || '{}');
        if (value?.boot !== boot || typeof value.marks !== 'object') return {};
        return Object.fromEntries(
            Object.entries(value.marks as Record<string, unknown>).filter(
                (entry): entry is [string, number] =>
                    typeof entry[1] === 'number' && Number.isFinite(entry[1])
            )
        );
    } catch {
        return {};
    }
}
export function storeMarks(boot: string, marks: Marks) {
    try {
        localStorage.setItem(READ_KEY, JSON.stringify({ boot, marks }));
    } catch {}
}

export function storedMuted(): string[] {
    try {
        const value = JSON.parse(localStorage.getItem(MUTED_KEY) || '[]');
        return Array.isArray(value)
            ? value
                  .filter((scope) => typeof scope === 'string')
                  .slice(-MAX_MUTED)
            : [];
    } catch {
        return [];
    }
}
export function storeMuted(scopes: string[]) {
    try {
        if (scopes.length)
            localStorage.setItem(
                MUTED_KEY,
                JSON.stringify(scopes.slice(-MAX_MUTED))
            );
        else localStorage.removeItem(MUTED_KEY);
    } catch {}
}

// The latest server time among a conversation's messages.
export function latest(messages: Message[], scope: string, since = 0) {
    for (const m of messages)
        if (m.scope === scope && (m.received ?? 0) > since) since = m.received!;
    return since;
}

const mentionCache = new WeakMap<Message, [string, boolean]>();
// A mention of you by name, or a reply to one of your messages.
export function mentionsYou(
    message: Message,
    name: string,
    yours: Set<string>
) {
    if (message.payload.kind !== 'text') return false;
    if (message.payload.reply && yours.has(message.payload.reply)) return true;
    const cached = mentionCache.get(message);
    if (cached?.[0] === name) return cached[1];
    const result = mentions(message.payload.text, name);
    mentionCache.set(message, [name, result]);
    return result;
}

// Messages from others after each conversation's read mark.
export function countUnread(
    messages: Message[],
    marks: Marks,
    self: string | null,
    name: string
) {
    const unread: Record<string, number> = {};
    const mentioned: Record<string, number> = {};
    const yours = new Set(
        messages.filter((m) => m.from === self).map((m) => m.id)
    );
    for (const m of messages) {
        if (
            m.from === self ||
            m.status !== 'sent' ||
            (m.received ?? 0) <= (marks[m.scope] ?? 0)
        )
            continue;
        unread[m.scope] = (unread[m.scope] || 0) + 1;
        if (mentionsYou(m, name, yours))
            mentioned[m.scope] = (mentioned[m.scope] || 0) + 1;
    }
    return { unread, mentioned };
}
