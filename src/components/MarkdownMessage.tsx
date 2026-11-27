import { memo, useEffect, useMemo, useRef } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Icon } from '../Icon';
import { useMobilePanel } from './useMobilePanel';
import { SheetHandle } from './SheetHandle';
import { messageImages, RemoteImage } from './RemoteImage';

const plugins = [remarkGfm];
// No raw HTML or executable URLs. Images from links load only through the
// server's image proxy, never directly from another site.
export const MarkdownMessage = memo(function MarkdownMessage({
    text,
}: {
    text: string;
}) {
    const images = useMemo(() => messageImages(text), [text]);
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
