import { memo, useEffect, useRef } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Icon } from '../Icon';

const plugins = [remarkGfm];
// No raw HTML, remote images, or executable URLs. Rendering never fetches content.
export const MarkdownMessage = memo(function MarkdownMessage({
    text,
}: {
    text: string;
}) {
    return (
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
                    img: ({ alt }) => (
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
    useEffect(() => {
        dialog.current?.showModal();
    }, []);
    return (
        <dialog
            ref={dialog}
            className="modal markdown-help"
            aria-labelledby="markdown-title"
            onCancel={close}
            onClick={(event) => {
                if (event.target === event.currentTarget) close();
            }}
        >
            <div className="modal-content">
                <button
                    className="modal-close icon-button"
                    aria-label="Close formatting help"
                    onClick={close}
                    autoFocus
                >
                    <Icon name="close" />
                </button>
                <h2 id="markdown-title">Format your messages</h2>
                <p>
                    Type Markdown in your message. Here’s how it looks when you
                    send it.
                </p>
                <div className="markdown-examples">
                    {examples.map(([name, example]) => (
                        <div className="markdown-example" key={name}>
                            <span>{name}</span>
                            <code>{example}</code>
                            <MarkdownMessage text={example} />
                        </div>
                    ))}
                </div>
                <button className="primary" onClick={close}>
                    Got it
                </button>
            </div>
        </dialog>
    );
}
