import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownMessage } from '../src/components/MarkdownMessage';

const render = (text: string) =>
    renderToStaticMarkup(createElement(MarkdownMessage, { text }));

test('Markdown renders formatting and code without executing HTML or loading embedded content', () => {
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
    assert.doesNotMatch(unsafe, /<(script|img|iframe|svg)|onerror=|href=|src=/);
    assert.match(unsafe, /tracking/);
    const link = render('[docs](https://example.com/docs)');
    assert.match(link, /href="https:\/\/example.com\/docs"/);
    assert.match(link, /rel="noopener noreferrer"/);
    assert.match(link, /referrerPolicy="no-referrer"/i);
});
