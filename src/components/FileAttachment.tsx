import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { Message } from '../types';
import { Icon } from '../Icon';
import { fileSize } from '../lib/content';
import { b64 } from '../lib/crypto';
import {
    attachmentPreview,
    attachmentText,
    type AttachmentPreview,
} from '../lib/attachment-preview';
import { useMobilePanel } from './useMobilePanel';
import { SheetHandle } from './SheetHandle';

const PdfPreview = lazy(() =>
    import('./PdfPreview').catch(() => ({ default: PreviewUnavailable }))
);
type FileContent = Extract<Message['payload'], { kind: 'file' }>;

// A data URL keeps the decoded image in page memory, never in blob storage.
const imageSource = (mime: string, bytes: Uint8Array) =>
    `data:${mime};base64,${b64(bytes).replaceAll('-', '+').replaceAll('_', '/')}`;

// Build the download Blob only when asked, so large files are not copied
// into browser blob storage just by appearing in the conversation.
function useDownload(bytes: Uint8Array<ArrayBuffer> | undefined, name: string) {
    const url = useRef('');
    useEffect(
        () => () => {
            if (url.current) URL.revokeObjectURL(url.current);
            url.current = '';
        },
        [bytes]
    );
    const link = () =>
        (url.current ||= URL.createObjectURL(
            new Blob([bytes!], { type: 'application/octet-stream' })
        ));
    return {
        click(event: React.MouseEvent<HTMLAnchorElement>) {
            if (!bytes) return event.preventDefault();
            event.currentTarget.href = link();
        },
        // Save once a requested file finishes arriving.
        save() {
            const anchor = document.createElement('a');
            anchor.href = link();
            anchor.download = name;
            anchor.click();
        },
    };
}

export function FileAttachment({
    content,
    bytes,
    progress,
    sending,
    unavailable,
    fetch,
}: {
    content: FileContent;
    bytes?: Uint8Array<ArrayBuffer>;
    progress?: number;
    sending?: boolean;
    unavailable?: boolean;
    fetch: () => void;
}) {
    const preview = useMemo(
        () =>
            bytes ? attachmentPreview(content.name, content.mime, bytes) : null,
        [content.name, content.mime, bytes]
    );
    const image = useMemo(
        () =>
            bytes && preview?.kind === 'image'
                ? imageSource(preview.mime, bytes)
                : '',
        [bytes, preview]
    );
    const [open, setOpen] = useState(false);
    const [broken, setBroken] = useState(false);
    const [wanted, setWanted] = useState(false);
    const downloadName = content.name.replace(/[\\/\u0000-\u001f\u007f]/g, '_');
    const { click: download, save } = useDownload(bytes, downloadName);
    useEffect(() => {
        if (!wanted || !bytes) return;
        setWanted(false);
        save();
    }, [wanted, bytes]);
    const status =
        progress !== undefined
            ? ` · ${sending ? 'Sending' : 'Receiving'} ${Math.floor(progress * 100)}%`
            : unavailable
              ? ' · Unavailable'
              : preview
                ? ' · Preview'
                : '';
    const label = (
        <>
            <span className="file-icon">
                <Icon name="file" size={24} />
            </span>
            <span>
                <strong>{content.name}</strong>
                <small>
                    {fileSize(content.size)}
                    {status}
                </small>
            </span>
        </>
    );
    const viewer = open && preview && bytes && (
        <FilePreview
            content={content}
            bytes={bytes}
            preview={preview}
            image={image}
            download={download}
            downloadName={downloadName}
            close={() => setOpen(false)}
        />
    );
    if (image && !broken)
        return (
            <>
                <div className="image-attachment">
                    <button
                        className="image-thumb"
                        aria-label={`Preview ${content.name}`}
                        title={`${content.name} · ${fileSize(content.size)}`}
                        onClick={() => setOpen(true)}
                    >
                        <img
                            src={image}
                            alt={content.name}
                            draggable={false}
                            onError={() => setBroken(true)}
                        />
                    </button>
                    {progress !== undefined && (
                        <small className="image-status">
                            {sending ? 'Sending' : 'Receiving'}{' '}
                            {Math.floor(progress * 100)}%
                        </small>
                    )}
                    <a
                        className="icon-button file-download"
                        href="#"
                        onClick={download}
                        download={downloadName}
                        aria-label={`Download ${content.name}`}
                        title="Download file"
                    >
                        <Icon name="download" size={19} />
                    </a>
                </div>
                {viewer}
            </>
        );
    return (
        <>
            <div className="file-attachment">
                {!bytes && progress !== undefined ? (
                    <div className="file-open" aria-busy="true">
                        {label}
                    </div>
                ) : !bytes ? (
                    <button
                        className="file-open"
                        aria-label={`Download ${content.name}`}
                        onClick={() => {
                            setWanted(true);
                            fetch();
                        }}
                    >
                        {label}
                        <Icon name="download" size={19} />
                    </button>
                ) : preview ? (
                    <button
                        className="file-open"
                        aria-label={`Preview ${content.name}`}
                        onClick={() => setOpen(true)}
                    >
                        {label}
                    </button>
                ) : (
                    <a
                        className="file-open"
                        href="#"
                        onClick={download}
                        download={downloadName}
                        aria-label={`Download ${content.name}`}
                    >
                        {label}
                        <Icon name="download" size={19} />
                    </a>
                )}
                {preview && (
                    <a
                        className="icon-button file-download"
                        href="#"
                        onClick={download}
                        download={downloadName}
                        aria-label={`Download ${content.name}`}
                        title="Download file"
                    >
                        <Icon name="download" size={19} />
                    </a>
                )}
            </div>
            {viewer}
        </>
    );
}

function FilePreview({
    content,
    bytes,
    preview,
    image,
    download,
    downloadName,
    close,
}: {
    content: FileContent;
    bytes: Uint8Array<ArrayBuffer>;
    preview: AttachmentPreview;
    image: string;
    download: (event: React.MouseEvent<HTMLAnchorElement>) => void;
    downloadName: string;
    close: () => void;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const dismiss = useMobilePanel(dialog, close);
    const [failed, setFailed] = useState(false);
    const text = useMemo(() => {
        if (preview.kind !== 'text') return null;
        try {
            return attachmentText(bytes);
        } catch {
            return null;
        }
    }, [bytes, preview.kind]);
    useEffect(() => {
        dialog.current?.showModal();
    }, []);
    return (
        <dialog
            ref={dialog}
            className="modal file-preview"
            aria-labelledby="file-preview-title"
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
                    <h2 id="file-preview-title">{content.name}</h2>
                    <small>{fileSize(content.size)}</small>
                </div>
                <a
                    className="icon-button"
                    href="#"
                    onClick={download}
                    download={downloadName}
                    aria-label={`Download ${content.name}`}
                    title="Download file"
                >
                    <Icon name="download" />
                </a>
                <button
                    className="icon-button"
                    aria-label="Close file preview"
                    onClick={dismiss}
                    autoFocus
                >
                    <Icon name="close" />
                </button>
            </div>
            <div className="file-preview-body">
                {preview.kind === 'image' &&
                    (failed ? (
                        <PreviewUnavailable />
                    ) : (
                        <img
                            className="image-preview"
                            alt={content.name}
                            src={image}
                            onError={() => setFailed(true)}
                        />
                    ))}
                {preview.kind === 'text' &&
                    (text ? (
                        <>
                            {text.truncated && (
                                <p className="preview-status">
                                    Showing the first 128 KB. Download to read
                                    the whole file.
                                </p>
                            )}
                            <pre
                                className="text-file-preview"
                                tabIndex={0}
                                aria-label="File contents"
                            >
                                <code>{text.text || '(Empty file)'}</code>
                            </pre>
                        </>
                    ) : (
                        <PreviewUnavailable />
                    ))}
                {preview.kind === 'pdf' && (
                    <Suspense
                        fallback={
                            <p className="preview-status" role="status">
                                Loading PDF…
                            </p>
                        }
                    >
                        <PdfPreview bytes={bytes} />
                    </Suspense>
                )}
            </div>
        </dialog>
    );
}

export function PreviewUnavailable() {
    return (
        <p className="preview-status" role="status">
            This file can’t be previewed. You can still download it.
        </p>
    );
}
