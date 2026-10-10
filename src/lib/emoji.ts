import { EMOJI_DATA } from './emoji-data';
export { EMOJI_GROUPS } from './emoji-data';

const normalizeSearch = (text: string) =>
    text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[:_\-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
const withoutVariation = (emoji: string) => emoji.replaceAll('\ufe0f', '');

export const EMOJI_LIST = EMOJI_DATA.map(
    ([emoji, label, group, names, tags]) => ({
        emoji,
        label,
        group,
        names: names.split(' '),
        search: normalizeSearch(`${label} ${names} ${tags}`),
    })
);

// A null prototype also keeps strings like :constructor: as ordinary text.
export const EMOJI: Record<string, string> = Object.assign(
    Object.create(null),
    Object.fromEntries(
        EMOJI_LIST.flatMap(({ emoji, names }) =>
            names.map((name) => [name, emoji])
        )
    )
);
const shortcodeNames = Object.keys(EMOJI);

export const replaceEmoji = (text: string) =>
    text.replace(
        /:([a-z0-9_+\-]+):/gi,
        (match, name: string) => EMOJI[name.toLowerCase()] || match
    );

export function searchEmoji(text: string, group?: number) {
    const query = normalizeSearch(text);
    const shortcode = text.toLowerCase().trim().replaceAll(':', '');
    const glyph = withoutVariation(text.trim());
    const words = query.split(' ');
    const entries =
        group === undefined
            ? EMOJI_LIST
            : EMOJI_LIST.filter((entry) => entry.group === group);
    if (!query) return entries;
    return entries
        .map((entry) => {
            if (
                withoutVariation(entry.emoji) === glyph ||
                entry.names.includes(shortcode)
            )
                return { entry, rank: 0 };
            if (!words.every((word) => entry.search.includes(word)))
                return null;
            return {
                entry,
                rank: entry.names.some((name) => name.startsWith(shortcode))
                    ? 1
                    : 2,
            };
        })
        .filter((match) => match !== null)
        .sort((a, b) => a.rank - b.rank)
        .map(({ entry }) => entry);
}

export function emojiQuery(text: string, cursor: number) {
    const match = /(?:^|\s):([a-z0-9_+\-]{1,80})$/i.exec(text.slice(0, cursor));
    if (!match) return null;
    const query = match[1].toLowerCase();
    const names = shortcodeNames.filter((name) => name.startsWith(query));
    const rest = shortcodeNames.filter(
        (name) => !name.startsWith(query) && name.includes(query)
    );
    const results: string[] = [];
    const seen = new Set<string>();
    // Exact matches come first; aliases of the same emoji only occupy one row.
    for (const name of [...(EMOJI[query] ? [query] : []), ...names, ...rest]) {
        if (seen.has(EMOJI[name])) continue;
        seen.add(EMOJI[name]);
        results.push(name);
        if (results.length === 6) break;
    }
    return results.length
        ? { start: cursor - query.length - 1, end: cursor, results }
        : null;
}
