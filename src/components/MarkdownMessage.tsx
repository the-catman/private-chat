import { memo, useEffect, useMemo, useRef } from 'react';
import Markdown, { type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Icon } from '../Icon';
import { useMobilePanel } from './useMobilePanel';
import { SheetHandle } from './SheetHandle';
import { messageImages, RemoteImage } from './RemoteImage';
import { mentionPattern } from '../lib/mentions';

const nobody: string[] = [];

type MdNode = {
    type: string;
    value?: string;
    children?: MdNode[];
    data?: Record<string, unknown>;
};
// Wrap "@Name" for known people in a span. Code nodes hold their text as a
// value rather than children, so mentions inside code stay literal.
function remarkMentions({ names, self }: { names: string[]; self: string }) {
    const pattern = mentionPattern(names);
    const split = (node: MdNode) => {
        if (!node.children || node.type === 'link') return;
        node.children = node.children.flatMap((child) => {
            if (child.type !== 'text' || !pattern) {
                split(child);
                return [child];
            }
            const value = child.value!;
            const parts: MdNode[] = [];
            let last = 0;
            for (const match of value.matchAll(pattern)) {
                const start = match.index! + match[1]!.length;
                const name = match[2]!;
                if (start > last)
                    parts.push({
                        type: 'text',
                        value: value.slice(last, start),
                    });
                parts.push({
                    type: 'mention',
                    data: {
                        hName: 'span',
                        hProperties: {
                            className:
                                name.toLowerCase() === self.toLowerCase()
                                    ? ['mention', 'me']
                                    : ['mention'],
                        },
                    },
                    children: [{ type: 'text', value: `@${name}` }],
                });
                last = start + name.length + 1;
            }
            if (!parts.length) return [child];
            if (last < value.length)
                parts.push({ type: 'text', value: value.slice(last) });
            return parts;
        });
    };
    return (tree: MdNode) => split(tree);
}
// No raw HTML or executable URLs. Images from links load only through the
// server's image proxy, never directly from another site.
export const MarkdownMessage = memo(function MarkdownMessage({
    text,
    names = nobody,
    self = '',
}: {
    text: string;
    // People who can be mentioned, and this browser's own name.
    names?: string[];
    self?: string;
}) {
    const images = useMemo(() => messageImages(text), [text]);
    const plugins = useMemo<NonNullable<Options['remarkPlugins']>>(
        () => [remarkGfm, [remarkMentions, { names, self }]],
        [names, self]
    );
    return (
        <>
            <div className="message-text markdown">
                <Markdown
                    remarkPlugins={plugins}
                    skipHtml
                    urlTransform={(url) =>
                        /^(https?:\/\/|mailto:)/i.test(url) ? url : ''
                    }
                    components={{
                        a: ({ href, children }) =>
                            href ? (
                                <a
                                    href={href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    referrerPolicy="no-referrer"
                                >
                                    {children}
                                </a>
                            ) : (
                                <span>{children}</span>
                            ),
                        img: ({ src, alt }) =>
                            typeof src === 'string' &&
                            images.inline.has(src) ? (
                                <RemoteImage url={src} alt={alt} inline />
                            ) : (
                                <span className="markdown-image-label">
                                    {alt || 'Image'}
                                </span>
                            ),
                        table: ({ children }) => (
                            <div className="markdown-table">
                                <table>{children}</table>
                            </div>
                        ),
                    }}
                >
                    {text}
                </Markdown>
            </div>
            {images.links.length > 0 && (
                <div className="message-embeds">
                    {images.links.map((url) => (
                        <RemoteImage key={url} url={url} />
                    ))}
                </div>
            )}
        </>
    );
});

const examples = [
    ['Bold', '**bold text**'],
    ['Italic', '*italic text*'],
    ['Strikethrough', '~~crossed out~~'],
    ['Inline code', '`some code`'],
    ['Link', '[a link](https://example.com)'],
    ['Quote', '> A quote'],
    ['List', '- First item\n- Second item'],
    ['Code block', '```js\nconst hello = "world";\n```'],
];

export function MarkdownHelp({ close }: { close: () => void }) {
    const dialog = useRef<HTMLDialogElement>(null);
    const dismiss = useMobilePanel(dialog, close);
    useEffect(() => {
        dialog.current?.showModal();
    }, []);
    return (
        <dialog
            ref={dialog}
            className="modal markdown-help"
            aria-labelledby="markdown-title"
            onCancel={(event) => {
                event.preventDefault();
                dismiss();
            }}
            onClick={(event) => {
                if (event.target === event.currentTarget) dismiss();
            }}
        >
            <SheetHandle />
            <div className="modal-content">
                <button
                    className="modal-close icon-button"
                    aria-label="Close formatting help"
                    onClick={dismiss}
                    autoFocus
                >
                    <Icon name="close" />
                </button>
                <h2 id="markdown-title">Formatting</h2>
                <p>Messages support Markdown.</p>
                <div className="markdown-examples">
                    {examples.map(([name, example]) => (
                        <div className="markdown-example" key={name}>
                            <span>{name}</span>
                            <code>{example}</code>
                            <MarkdownMessage text={example} />
                        </div>
                    ))}
                </div>
                <button className="primary" onClick={dismiss}>
                    Got it
                </button>
            </div>
        </dialog>
    );
}
