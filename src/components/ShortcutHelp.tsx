import { useEffect, useRef } from 'react';
import { Icon } from '../Icon';
import { SheetHandle } from './SheetHandle';
import { useMobilePanel } from './useMobilePanel';

const shortcuts = [
    ['Enter', 'Send a message or save an edit on desktop'],
    ['Shift + Enter', 'Start a new line'],
    ['Ctrl / ⌘ + Enter', 'Send or save with a phone or tablet keyboard'],
    ['↑ in an empty message box', 'Edit your last message'],
    ['Esc', 'Cancel an edit, close a menu, or leave selection mode'],
    ['Right-click · Shift + F10', 'Open a message’s actions'],
    ['Ctrl + right-click', 'Edit your message'],
    ['Ctrl + click', 'Delete your message, with confirmation'],
    [
        'Ctrl + Shift + click',
        'Delete your message immediately, without confirmation',
    ],
    ['Shift + click in selection mode', 'Select a range of messages'],
    ['↑ / ↓ · Tab or Enter', 'Choose and insert an emoji suggestion'],
];

export function ShortcutHelp({ close }: { close: () => void }) {
    const dialog = useRef<HTMLDialogElement>(null);
    const dismiss = useMobilePanel(dialog, close);
    useEffect(() => {
        dialog.current?.showModal();
    }, []);
    return (
        <dialog
            ref={dialog}
            className="modal shortcut-help"
            aria-labelledby="shortcut-title"
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
                    aria-label="Close shortcut help"
                    onClick={dismiss}
                    autoFocus
                >
                    <Icon name="close" />
                </button>
                <h2 id="shortcut-title">Keyboard shortcuts</h2>
                <p>
                    On a phone, Return starts a new line. Tap Send or Save when
                    you’re ready.
                </p>
                <dl className="shortcut-list">
                    {shortcuts.map(([keys, description]) => (
                        <div key={keys}>
                            <dt>
                                <kbd>{keys}</kbd>
                            </dt>
                            <dd>{description}</dd>
                        </div>
                    ))}
                </dl>
                <button className="primary" onClick={dismiss}>
                    Got it
                </button>
            </div>
        </dialog>
    );
}
