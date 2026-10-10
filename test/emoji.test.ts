import test from 'node:test';
import assert from 'node:assert/strict';
import {
    EMOJI,
    EMOJI_GROUPS,
    EMOJI_LIST,
    emojiQuery,
    replaceEmoji,
    searchEmoji,
} from '../src/lib/emoji';

test('the complete catalog has unique entries and usable shortcodes in every category', () => {
    assert.equal(EMOJI_LIST.length, 3953);
    assert.equal(new Set(EMOJI_LIST.map((entry) => entry.emoji)).size, 3953);
    for (const [group] of EMOJI_GROUPS) {
        const entries = searchEmoji('', group);
        assert.ok(entries.length > 0);
        assert.ok(entries.every((entry) => entry.group === group));
    }
    for (const entry of EMOJI_LIST) {
        assert.ok(entry.names.length > 0, entry.label);
        for (const name of entry.names)
            assert.equal(replaceEmoji(`:${name}:`), entry.emoji, name);
    }
});

test('search finds flags, keyword synonyms, skin tones, sequences, and Unicode 17 emoji', () => {
    assert.equal(searchEmoji('lebanon')[0].emoji, '🇱🇧');
    assert.equal(searchEmoji(':flag-lb:')[0].emoji, '🇱🇧');
    assert.equal(searchEmoji('coder')[0].emoji, '🧑‍💻');
    assert.equal(searchEmoji('wave_tone3')[0].emoji, '👋🏽');
    assert.ok(
        searchEmoji('waving hand medium skin').some(
            (entry) => entry.emoji === '👋🏽'
        )
    );
    assert.equal(searchEmoji('🫱🏻‍🫲🏽')[0].names[0], 'handshake_tone1-3');
    assert.equal(searchEmoji('distorted face')[0].emoji, '🫪');
    assert.equal(searchEmoji('🫪')[0].emoji, '🫪');
    assert.equal(searchEmoji('heart')[0].emoji, '❤️');
    assert.equal(searchEmoji('❤')[0].emoji, '❤️');
    assert.equal(searchEmoji('lebanon', 0).length, 0);
    assert.equal(searchEmoji('a-nonexistent-emoji-xyz').length, 0);
});

test('shortcodes preserve familiar aliases, unknown text, and complete Unicode sequences', () => {
    assert.equal(replaceEmoji(':SMILE: :wave: :purple_heart:'), '😄 👋 💜');
    assert.equal(
        replaceEmoji(
            ':lebanon: :wave_tone3: :handshake_tone1-3: :distorted_face:'
        ),
        '🇱🇧 👋🏽 🫱🏻‍🫲🏽 🫪'
    );
    assert.equal(replaceEmoji(':stars: :moon: :ice_cream:'), '🌟 🌙 🍦');
    const unknown = ':not_an_emoji: :constructor: :__proto__: :toString:';
    assert.equal(replaceEmoji(unknown), unknown);
    assert.equal(replaceEmoji('🧑🏽‍💻 🇱🇧'), '🧑🏽‍💻 🇱🇧');
});

test('autocomplete ranks exact aliases first and never repeats the same emoji', () => {
    for (const text of [':smi', 'Hello :heart', ':flag_lb', ':wave_tone3']) {
        const query = emojiQuery(text, text.length)!;
        assert.ok(query.results.length > 0 && query.results.length <= 6);
        const glyphs = query.results.map((name) => EMOJI[name]);
        assert.equal(new Set(glyphs).size, glyphs.length);
        assert.equal(text[query.start], ':');
        assert.equal(query.end, text.length);
    }
    assert.equal(emojiQuery(':smile', 6)!.results[0], 'smile');
    const long = 'smiling_face_with_smiling_eyes_and_hand_covering_mouth';
    assert.equal(emojiQuery(`:${long}`, long.length + 1)!.results[0], long);
    assert.equal(emojiQuery('https://example.com', 19), null);
    assert.equal(emojiQuery(':constructor', 12), null);
    assert.equal(emojiQuery(':not_an_emoji', 13), null);
});
