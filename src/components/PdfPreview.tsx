import { useEffect, useRef, useState } from 'react';
import {
    getDocument,
    PDFWorker,
    type PDFDocumentLoadingTask,
    type PDFDocumentProxy,
    type RenderTask,
} from 'pdfjs-dist';
import { PreviewUnavailable } from './FileAttachment';

export default function PdfPreview({ bytes }: { bytes: Uint8Array }) {
    const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
    const [page, setPage] = useState(1);
    const [error, setError] = useState(false);
    const [rendering, setRendering] = useState(true);
    const [text, setText] = useState('');
    const [textView, setTextView] = useState(false);
    const canvas = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        let active = true;
        let port: Worker | undefined;
        let worker: PDFWorker | undefined;
        let task: PDFDocumentLoadingTask | undefined;
        const release = () => {
            worker?.destroy();
            port?.terminate();
        };
        try {
            port = new Worker(
                new URL('../lib/pdf-worker.ts', import.meta.url),
                { type: 'module' }
            );
            worker = PDFWorker.create({ port });
            task = getDocument({
                data: bytes.slice(),
                worker,
                useWorkerFetch: false,
                useWasm: false,
                useSystemFonts: true,
                enableXfa: false,
                stopAtErrors: true,
                maxImageSize: 16_000_000,
                canvasMaxAreaInBytes: 16_000_000,
            });
            port.onerror = () => {
                if (active) setError(true);
                release();
            };
            void task.promise.then(
                (value) => {
                    if (active) setDocument(value);
                },
                () => {
                    if (active) setError(true);
                }
            );
        } catch {
            setError(true);
            release();
        }
        return () => {
            active = false;
            if (task)
                void task
                    .destroy()
                    .catch(() => {})
                    .finally(release);
            else release();
        };
    }, [bytes]);
    useEffect(() => {
        if (!document || !canvas.current) return;
        const node = canvas.current;
        let active = true;
        let render: RenderTask | undefined;
        setRendering(true);
        setText('');
        void (async () => {
            try {
                const pdfPage = await document.getPage(page);
                if (!active) return;
                const base = pdfPage.getViewport({ scale: 1 });
                // Bound memory use even for unusually large PDF page dimensions.
                const scale = Math.min(
                    2,
                    1600 / base.width,
                    2200 / base.height
                );
                const viewport = pdfPage.getViewport({ scale });
                node.width = Math.ceil(viewport.width);
                node.height = Math.ceil(viewport.height);
                render = pdfPage.render({ canvas: node, viewport });
                const [, content] = await Promise.all([
                    render.promise,
                    pdfPage.getTextContent(),
                ]);
                if (!active) return;
                setText(
                    content.items
                        .map((item) =>
                            'str' in item
                                ? item.str + (item.hasEOL ? '\n' : ' ')
                                : ''
                        )
                        .join('')
                );
                setRendering(false);
                pdfPage.cleanup();
            } catch {
                if (active) setError(true);
            }
        })();
        return () => {
            active = false;
            render?.cancel();
        };
    }, [document, page]);
    if (error) return <PreviewUnavailable />;
    return (
        <div className="pdf-preview">
            {document && (
                <div className="pdf-controls">
                    <button
                        className="subtle-button"
                        disabled={page === 1 || rendering}
                        onClick={() => setPage(page - 1)}
                        aria-label="Previous PDF page"
                    >
                        Previous
                    </button>
                    <span>
                        Page {page} of {document.numPages}
                    </span>
                    <button
                        className="subtle-button"
                        disabled={page === document.numPages || rendering}
                        onClick={() => setPage(page + 1)}
                        aria-label="Next PDF page"
                    >
                        Next
                    </button>
                    <button
                        className="subtle-button"
                        aria-pressed={textView}
                        onClick={() => setTextView(!textView)}
                    >
                        Text view
                    </button>
                </div>
            )}
            {rendering && (
                <p className="preview-status" role="status">
                    Loading PDF page…
                </p>
            )}
            <canvas
                ref={canvas}
                className="pdf-page"
                hidden={textView || rendering}
                role="img"
                aria-label={`PDF page ${page}`}
            />
            {textView && !rendering && (
                <pre
                    className="text-file-preview"
                    tabIndex={0}
                    aria-label={`Text of PDF page ${page}`}
                >
                    {text || 'No text on this page.'}
                </pre>
            )}
        </div>
    );
}
