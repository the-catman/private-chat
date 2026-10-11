import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { Message } from '../types';
import { Icon } from '../Icon';
import { fileSize } from '../lib/content';
import { unb64 } from '../lib/crypto';
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

export function FileAttachment({ content }: { content: FileContent }) {
    const bytes = useMemo(() => unb64(content.data), [content.data]);
    const preview = useMemo(
        () => attachmentPreview(content.name, content.mime, bytes),
        [content.name, content.mime, bytes]
    );
    const [url, setUrl] = useState('');
    const [open, setOpen] = useState(false);
    useEffect(() => {
        const value = URL.createObjectURL(
            new Blob([bytes], { type: 'application/octet-stream' })
        );
        setUrl(value);
        return () => URL.revokeObjectURL(value);
    }, [bytes]);
    const downloadName = content.name.replace(/[\\/\u0000-\u001f\u007f]/g, '_');
    const label = (
        <>
            <span className="file-icon">
                <Icon name="file" size={24} />
            </span>
            <span>
                <strong>{content.name}</strong>
                <small>
                    {fileSize(content.size)}
                    {preview ? ' · Preview' : ''}
                </small>
            </span>
        </>
    );
    return (
        <>
            <div className="file-attachment">
                {preview ? (
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
                        href={url || undefined}
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
                        href={url || undefined}
                        download={downloadName}
                        aria-label={`Download ${content.name}`}
                        title="Download file"
                    >
                        <Icon name="download" size={19} />
                    </a>
                )}
            </div>
            {open && preview && (
                <FilePreview
                    content={content}
                    bytes={bytes}
                    preview={preview}
                    url={url}
                    downloadName={downloadName}
                    close={() => setOpen(false)}
                />
            )}
        </>
    );
}

function FilePreview({
    content,
    bytes,
    preview,
    url,
    downloadName,
    close,
}: {
    content: FileContent;
    bytes: Uint8Array<ArrayBuffer>;
    preview: AttachmentPreview;
    url: string;
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
                    href={url}
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
                            src={`data:${preview.mime};base64,${content.data.replaceAll('-', '+').replaceAll('_', '/')}`}
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
