import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownMessage } from '../src/components/MarkdownMessage';

const render = (text: string) =>
    renderToStaticMarkup(createElement(MarkdownMessage, { text }));

test('Markdown renders formatting and code without executing HTML, and loads images only through the proxy', () => {
    const html = render(
        '**bold** *italic* ~~strike~~\n\n> quote\n\n- list\n\n`<script>code</script>`\n\n```js\nconst x = 1;\n```'
    );
    for (const tag of [
        'strong',
        'em',
        'del',
        'blockquote',
        'ul',
        'pre',
        'code',
    ])
        assert.match(html, new RegExp(`<${tag}[ >]`));
    assert.match(html, /&lt;script&gt;code&lt;\/script&gt;/);
    const unsafe = render(
        '<script>alert(1)</script>\n\n<img src="https://tracker.example/pixel" onerror="alert(1)">\n\n![tracking](https://tracker.example/pixel)\n\n[bad](javascript:alert%281%29) [data](data:text/html,hello) [relative](/api/logout)'
    );
    // Raw HTML never renders. A Markdown image loads only through the
    // server's proxy, never straight from the other site.
    assert.doesNotMatch(unsafe, /<(script|iframe|svg)|onerror=|href=/);
    assert.deepEqual(
        [...unsafe.matchAll(/src="([^"]*)"/g)].map((m) => m[1]),
        [
            `/api/image?url=${encodeURIComponent('https://tracker.example/pixel')}`,
        ]
    );
    assert.match(unsafe, /alt="tracking"/);
    const link = render('[docs](https://example.com/docs)');
    assert.match(link, /href="https:\/\/example.com\/docs"/);
    assert.match(link, /rel="noopener noreferrer"/);
    assert.match(link, /referrerPolicy="no-referrer"/i);
});

test('image links embed a few proxied images, outside code only', () => {
    const html = render(
        'Look https://pics.example/cat.png and https://pics.example/dog.JPG?w=2.\n\n`https://pics.example/code.png`\n\n```\nhttps://pics.example/block.gif\n```\n\nhttps://pics.example/page and https://pics.example/cat.png'
    );
    const sources = [...html.matchAll(/src="\/api\/image\?url=([^"]*)"/g)].map(
        (m) => decodeURIComponent(m[1]!)
    );
    assert.deepEqual(sources, [
        'https://pics.example/cat.png',
        'https://pics.example/dog.JPG?w=2',
    ]);
    const many = render(
        Array.from(
            { length: 6 },
            (_, i) => `https://pics.example/${i}.png`
        ).join(' ')
    );
    assert.equal(many.match(/<img/g)?.length, 4);
});
