// Usage: node --import=tsx scripts/generate-emoji-data.ts /path/to/emojibase-data
// The source is the unpacked emojibase-data@17.0.0 npm package, not a CDN at runtime.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type SourceEmoji = {
    emoji: string;
    label: string;
    hexcode: string;
    group?: number;
    order?: number;
    tags?: string[];
    skins?: SourceEmoji[];
};
type Shortcodes = Record<string, string | string[]>;

const source = process.argv[2];
assert(source, 'Pass the unpacked emojibase-data package directory.');
const root = fileURLToPath(new URL('../', import.meta.url));
const read = async (path: string) =>
    JSON.parse(await readFile(resolve(source, path), 'utf8'));
const metadata = await read('package.json');
assert.equal(metadata.name, 'emojibase-data');
assert.equal(metadata.version, '17.0.0');
const data: SourceEmoji[] = await read('en/data.json');
const messages: {
    groups: { order: number; message: string }[];
} = await read('en/messages.json');
// Keep standalone emoji and all variants; regional-indicator letters without a
// group are building blocks for flags, not separate emoji in Unicode's picker set.
const entries = data
    .filter((entry) => entry.group !== undefined)
    .flatMap((entry) => [
        entry,
        ...(entry.skins || []).map((skin) => ({ ...skin, tags: entry.tags })),
    ])
    .sort((a, b) => a.order! - b.order!);
const aliases = new Map<string, string>();
// Familiar GitHub/Slack names take precedence where preset names overlap.
for (const preset of ['github', 'iamcal', 'emojibase']) {
    const codes: Shortcodes = await read(`en/shortcodes/${preset}.json`);
    for (const entry of entries)
        for (const name of [codes[entry.hexcode] || []].flat()) {
            assert.match(name, /^[a-z0-9_+\-]+$/);
            if (!aliases.has(name)) aliases.set(name, entry.emoji);
        }
}

// Preserve the handful of aliases whose original Hush meanings differ from the
// presets. The catalog itself, including new emoji, comes entirely from Emojibase.
const compatibility: Record<string, string> = {
    upside_down: '🙃',
    crying: '😢',
    mind_blown: '🤯',
    hug: '🫂',
    skull_crossbones: '☠️',
    stars: '🌟',
    thumbs_up: '👍',
    thumbs_down: '👎',
    peace: '✌️',
    moon: '🌙',
    lightning: '⚡',
    earth: '🌍',
    planet: '🪐',
    flower: '🌸',
    burger: '🍔',
    cake: '🎂',
    ice_cream: '🍦',
    ice_cream_bowl: '🍨',
    medal: '🏅',
    train: '🚆',
    phone: '📱',
    pencil: '✏️',
    check: '✅',
    hundred: '💯',
};
const withoutVariation = (emoji: string) => emoji.replaceAll('\ufe0f', '');
for (const [name, emoji] of Object.entries(compatibility)) {
    const entry = entries.find(
        (item) => withoutVariation(item.emoji) === withoutVariation(emoji)
    );
    assert(entry, `Missing compatibility emoji for ${name}.`);
    aliases.set(name, entry.emoji);
}
const namesByEmoji = new Map<string, string[]>();
for (const [name, emoji] of aliases) {
    const names = namesByEmoji.get(emoji) || [];
    names.push(name);
    namesByEmoji.set(emoji, names);
}
const rows = entries.map((entry) => {
    const names = namesByEmoji.get(entry.emoji);
    assert(names?.length, `No shortcode for ${entry.label}.`);
    return [
        entry.emoji,
        entry.label,
        entry.group,
        names.join(' '),
        (entry.tags || []).join(' '),
    ];
});
assert.equal(new Set(entries.map((entry) => entry.emoji)).size, rows.length);
const groups = messages.groups.map(({ order, message }) => [
    order,
    message[0].toUpperCase() + message.slice(1),
]);
const license = await readFile(resolve(source, 'LICENSE'), 'utf8');
await mkdir(resolve(root, 'licenses'), { recursive: true });
await writeFile(resolve(root, 'licenses/Emojibase.txt'), license);
await writeFile(
    resolve(root, 'src/lib/emoji-data.ts'),
    `/*!\n${license.trim()}\n*/
// Generated from emojibase-data@17.0.0; see scripts/generate-emoji-data.ts.
// Unicode 17.0, English labels, search tags, and GitHub/iamcal/Emojibase shortcodes.
type EmojiDataRow = [
    emoji: string,
    label: string,
    group: number,
    names: string,
    tags: string,
];

// prettier-ignore
export const EMOJI_GROUPS: [number, string][] = ${JSON.stringify(groups)};

// prettier-ignore
export const EMOJI_DATA: EmojiDataRow[] = [
${rows.map((row) => `    ${JSON.stringify(row)},`).join('\n')}
];
`
);
console.log(`Generated ${rows.length} emoji and ${aliases.size} shortcodes.`);
