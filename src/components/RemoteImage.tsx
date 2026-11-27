import { useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { useMobilePanel } from './useMobilePanel';
import { SheetHandle } from './SheetHandle';
import { withoutCode } from '../lib/mentions';

// Images from links load through the server, so the sites hosting them never
// see readers' addresses. Only the server fetches them.
export const proxied = (url: string) =>
    `/api/image?url=${encodeURIComponent(url)}`;

// Each message embeds a few images at most.
export const MAX_EMBEDS = 4;
const LINK = /\bhttps?:\/\/[^\s<>()[\]"'`]+/gi;
const MARKDOWN_IMAGE = /!\[[^\]\n]*\]\(\s*<?(https?:\/\/[^\s)>]+)/gi;
// Like GFM autolinks, trailing punctuation is not part of the address.
function imageLink(match: string) {
    const url = match.replace(/[.,!?;:*_~]+$/, '');
    try {
        return /\.(png|jpe?g|gif|webp|avif)$/i.test(new URL(url).pathname)
            ? url
            : null;
    } catch {
        return null;
    }
}

// Explicit Markdown images, then bare links whose path ends in an image
// extension. Code is never scanned.
export function messageImages(text: string) {
    const prose = withoutCode(text);
    const inline = [...prose.matchAll(MARKDOWN_IMAGE)].map((m) => m[1]!);
    const allowed = new Set(inline.slice(0, MAX_EMBEDS));
    const links = (prose.replace(MARKDOWN_IMAGE, ' ').match(LINK) || [])
        .map(imageLink)
        .filter((url): url is string => url !== null && !allowed.has(url));
    return {
        inline: allowed,
        links: [...new Set(links)].slice(0, MAX_EMBEDS - allowed.size),
    };
}

export function RemoteImage({
    url,
    alt = '',
    inline = false,
}: {
    url: string;
    alt?: string;
    inline?: boolean;
}) {
    const [state, setState] = useState<'loading' | 'ready' | 'failed'>(
        'loading'
    );
    const [open, setOpen] = useState(false);
    if (state === 'failed')
        return inline ? (
            <span className="markdown-image-label">{alt || 'Image'}</span>
        ) : null;
    return (
        <>
            <button
                type="button"
                className={`remote-image ${state}`}
                aria-label={alt ? `Open image: ${alt}` : 'Open image'}
                onClick={() => setOpen(true)}
            >
                <img
                    src={proxied(url)}
                    alt={alt}
                    loading="lazy"
                    decoding="async"
                    referrerPolicy="no-referrer"
                    draggable={false}
                    onLoad={() => setState('ready')}
                    onError={() => setState('failed')}
                />
            </button>
            {open && (
                <ImageViewer url={url} alt={alt} close={() => setOpen(false)} />
            )}
        </>
    );
}

function ImageViewer({
    url,
    alt,
    close,
}: {
    url: string;
    alt: string;
    close: () => void;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const dismiss = useMobilePanel(dialog, close);
    useEffect(() => {
        dialog.current?.showModal();
    }, []);
    const host = new URL(url).host;
    return (
        <dialog
            ref={dialog}
            className="modal file-preview"
            aria-labelledby="image-viewer-title"
            onCancel={(event) => {
                event.preventDefault();
                dismiss();
            }}
            onClick={(event) => {
                if (event.target === event.currentTarget) dismiss();
            }}
        >
            <SheetHandle />
            <div className="file-preview-header" data-panel-handle>
                <div>
                    <h2 id="image-viewer-title">{alt || 'Image'}</h2>
                    <small>{host}</small>
                </div>
                <a
                    className="icon-button"
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    referrerPolicy="no-referrer"
                    aria-label="Open original"
                    title="Open original"
                >
                    <Icon name="popout" />
                </a>
                <button
                    className="icon-button"
                    aria-label="Close image"
                    onClick={dismiss}
                    autoFocus
                >
                    <Icon name="close" />
                </button>
            </div>
            <div className="file-preview-body">
                <img
                    className="image-preview"
                    src={proxied(url)}
                    alt={alt}
                    referrerPolicy="no-referrer"
                />
            </div>
        </dialog>
    );
}
