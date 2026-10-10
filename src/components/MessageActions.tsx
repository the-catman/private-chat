import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatState, Message } from '../types';
import type { ChatClient } from '../lib/client';
import { Icon } from '../Icon';
import { fileSize } from '../lib/content';
import { unb64 } from '../lib/crypto';

export function FileAttachment({
    content,
}: {
    content: Extract<Message['payload'], { kind: 'file' }>;
}) {
    const [url, setUrl] = useState('');
    useEffect(() => {
        // Always download attachments. Never execute or embed untrusted HTML/SVG.
        const value = URL.createObjectURL(
            new Blob([unb64(content.data)], {
                type: 'application/octet-stream',
            })
        );
        setUrl(value);
        return () => URL.revokeObjectURL(value);
    }, [content.data]);
    return (
        <a
            className="file-attachment"
            href={url || undefined}
            download={content.name.replace(/[\\/\u0000-\u001f\u007f]/g, '_')}
            aria-label={`Download ${content.name}`}
        >
            <span className="file-icon">
                <Icon name="file" size={24} />
            </span>
            <span>
                <strong>{content.name}</strong>
                <small>{fileSize(content.size)}</small>
            </span>
            <Icon name="download" size={19} />
        </a>
    );
}

export type MenuAction = {
    label: string;
    icon: string;
    run: () => void;
    danger?: boolean;
    disabled?: boolean;
};
export function MessageMenu({
    x,
    y,
    actions,
    close,
    label = 'Message actions',
}: {
    x: number;
    y: number;
    actions: MenuAction[];
    close: () => void;
    label?: string;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const closeRef = useRef(close);
    closeRef.current = close;
    useLayoutEffect(() => {
        const menu = ref.current!;
        const box = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - box.width - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - box.height - 8))}px`;
        menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    }, [x, y]);
    useEffect(() => {
        const dismiss = (event: PointerEvent) => {
            if (!ref.current?.contains(event.target as Node))
                closeRef.current();
        };
        const resize = () => closeRef.current();
        document.addEventListener('pointerdown', dismiss);
        window.addEventListener('resize', resize);
        return () => {
            document.removeEventListener('pointerdown', dismiss);
            window.removeEventListener('resize', resize);
        };
    }, []);
    return (
        <div
            ref={ref}
            className="message-menu"
            role="menu"
            aria-label={label}
            style={{ left: x, top: y }}
            onContextMenu={(event) => event.preventDefault()}
            onKeyDown={(event) => {
                if (event.key === 'Escape' || event.key === 'Tab') {
                    event.preventDefault();
                    close();
                    return;
                }
                const buttons = [
                    ...ref.current!.querySelectorAll<HTMLButtonElement>(
                        'button:not(:disabled)'
                    ),
                ];
                const index = buttons.indexOf(
                    document.activeElement as HTMLButtonElement
                );
                if (
                    ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
                ) {
                    event.preventDefault();
                    const next =
                        event.key === 'Home'
                            ? 0
                            : event.key === 'End'
                              ? buttons.length - 1
                              : (index +
                                    (event.key === 'ArrowDown' ? 1 : -1) +
                                    buttons.length) %
                                buttons.length;
                    buttons[next]?.focus();
                }
            }}
        >
            {actions.map((action) => (
                <button
                    role="menuitem"
                    key={action.label}
                    className={action.danger ? 'destructive-text' : ''}
                    disabled={action.disabled}
                    onClick={() => {
                        close();
                        action.run();
                    }}
                >
                    <Icon name={action.icon} size={18} />
                    {action.label}
                </button>
            ))}
        </div>
    );
}

export function MessageEditor({
    message,
    client,
    close,
}: {
    message: Message;
    client: ChatClient;
    close: () => void;
}) {
    const [text, setText] = useState(
        message.payload.kind === 'text' ? message.payload.text : ''
    );
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const save = async () => {
        if (busy || !text.trim()) return;
        setBusy(true);
        setError('');
        try {
            await client.edit(message.id, text);
            close();
        } catch (error) {
            setError(
                error instanceof Error
                    ? error.message
                    : 'Could not save this edit.'
            );
        } finally {
            setBusy(false);
        }
    };
    return (
        <div className="message-editor">
            <textarea
                aria-label="Edit message"
                autoFocus
                value={text}
                maxLength={4000}
                disabled={busy}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        close();
                    }
                    if (
                        event.key === 'Enter' &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                    ) {
                        event.preventDefault();
                        void save();
                    }
                }}
            />
            {error && (
                <p className="form-error" role="alert">
                    {error}
                </p>
            )}
            <div>
                <span>Enter to save · Esc to cancel</span>
                <button
                    className="subtle-button"
                    disabled={busy}
                    onClick={close}
                >
                    Cancel
                </button>
                <button
                    className="small-primary"
                    disabled={busy || !text.trim()}
                    onClick={() => void save()}
                >
                    {busy ? 'Saving…' : 'Save'}
                </button>
            </div>
        </div>
    );
}

export type ActionDialog = { type: 'share' | 'delete'; ids: string[] };
export function MessageActionDialog({
    action,
    state,
    client,
    close,
    done,
}: {
    action: ActionDialog;
    state: ChatState;
    client: ChatClient;
    close: () => void;
    done: () => void;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const messages = state.messages.filter((m) => action.ids.includes(m.id));
    const peers = state.peers.filter((p) => p.id !== state.self && p.online);
    const [target, setTarget] = useState(
        () =>
            peers.find((p) => messages.some((m) => !m.audience.includes(p.id)))
                ?.id ||
            peers[0]?.id ||
            ''
    );
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState(0);
    const [error, setError] = useState('');
    useEffect(() => {
        dialog.current?.showModal();
    }, []);
    const sharing = action.type === 'share';
    const missing = messages.length !== action.ids.length;
    const newMessages = messages.filter((m) => !m.audience.includes(target));
    const validTarget = peers.some((p) => p.id === target);
    const submit = async () => {
        if (busy) return;
        setBusy(true);
        setError('');
        try {
            if (sharing)
                await client.shareHistory(action.ids, target, setProgress);
            else await client.deleteMessages(action.ids);
            client.notify(
                sharing
                    ? `Shared history with ${peers.find((p) => p.id === target)?.name || 'your friend'}.`
                    : `Deleted ${action.ids.length} message${action.ids.length === 1 ? '' : 's'}.`
            );
            done();
        } catch (error) {
            setError(
                error instanceof Error
                    ? error.message
                    : 'Could not finish this action.'
            );
        } finally {
            setBusy(false);
        }
    };
    return (
        <dialog
            className="modal"
            ref={dialog}
            aria-labelledby="message-action-title"
            onCancel={(event) => {
                event.preventDefault();
                if (!busy) close();
            }}
            onClick={(event) => {
                if (!busy && event.target === event.currentTarget) close();
            }}
        >
            <div className="modal-content">
                <button
                    className="icon-button modal-close"
                    aria-label="Close message dialog"
                    disabled={busy}
                    onClick={close}
                >
                    <Icon name="close" />
                </button>
                <span className="modal-icon">
                    <Icon name={sharing ? 'share' : 'trash'} size={28} />
                </span>
                <h2 id="message-action-title">
                    {sharing
                        ? 'Share room history'
                        : `Delete ${action.ids.length === 1 ? 'this message' : `${action.ids.length} messages`}?`}
                </h2>
                <p>
                    {sharing
                        ? 'Choose who can read the selected room messages, including any files or voice notes. DMs are never included.'
                        : 'These messages will be removed for everyone who received them. Someone may already have saved a copy.'}
                </p>
                <div className="message-preview-list">
                    {messages.slice(0, 3).map((m) => (
                        <div key={m.id}>
                            <strong>{m.name}</strong>
                            <span>
                                {m.payload.kind === 'text'
                                    ? m.payload.text
                                    : m.payload.kind === 'file'
                                      ? m.payload.name
                                      : 'Voice note'}
                            </span>
                        </div>
                    ))}
                    {messages.length > 3 && (
                        <small>and {messages.length - 3} more</small>
                    )}
                </div>
                {sharing && (
                    <label className="share-recipient">
                        Share with
                        <select
                            aria-label="History recipient"
                            value={target}
                            disabled={busy}
                            onChange={(event) => setTarget(event.target.value)}
                        >
                            <option value="" disabled>
                                Choose someone online
                            </option>
                            {peers.map((p) => (
                                <option value={p.id} key={p.id}>
                                    {p.name}
                                </option>
                            ))}
                        </select>
                    </label>
                )}
                {sharing && (
                    <p className="small-text">
                        {peers.length
                            ? `${newMessages.length} new message${newMessages.length === 1 ? '' : 's'} for this person. Messages they already have are skipped.`
                            : 'Someone else needs to be online to receive history.'}
                    </p>
                )}
                {missing && (
                    <p className="form-error" role="alert">
                        A selected message was deleted. Close this dialog and
                        select again.
                    </p>
                )}
                {error && (
                    <p className="form-error" role="alert">
                        {error}
                    </p>
                )}
                <div className="dialog-actions">
                    <button
                        className="subtle-button"
                        disabled={busy}
                        onClick={close}
                    >
                        Cancel
                    </button>
                    <button
                        className={sharing ? 'primary' : 'destructive-button'}
                        disabled={
                            busy ||
                            missing ||
                            (sharing && (!validTarget || !newMessages.length))
                        }
                        onClick={() => void submit()}
                    >
                        {busy
                            ? sharing
                                ? `Sharing ${progress}/${action.ids.length}…`
                                : 'Deleting…'
                            : sharing
                              ? 'Share encrypted history'
                              : 'Delete for everyone'}
                    </button>
                </div>
            </div>
        </dialog>
    );
}
