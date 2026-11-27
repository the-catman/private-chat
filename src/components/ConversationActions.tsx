import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import type { ChatClient } from '../lib/client';
import { Icon } from '../Icon';
import { MessageMenu, type MenuAction } from './MessageActions';
import { useMobilePanel } from './useMobilePanel';
import { SheetHandle } from './SheetHandle';

export function ConversationActions({
    client,
    scope,
    title,
    online,
    muted,
    share,
    actions = [],
}: {
    client: ChatClient;
    scope: string;
    title: string;
    online: boolean;
    muted: boolean;
    share?: () => void;
    actions?: MenuAction[];
}) {
    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
    const [clear, setClear] = useState<{ scope: string; title: string } | null>(
        null
    );
    const trigger = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        setMenu(null);
    }, [scope]);
    const closeMenu = () => {
        setMenu(null);
        trigger.current?.focus({ preventScroll: true });
    };
    return (
        <>
            <button
                ref={trigger}
                className="icon-button"
                aria-label="Conversation actions"
                title="Conversation actions"
                aria-haspopup="menu"
                aria-expanded={Boolean(menu)}
                onClick={(event) => {
                    if (menu) return closeMenu();
                    const box = event.currentTarget.getBoundingClientRect();
                    setMenu({ x: box.right, y: box.bottom + 6 });
                }}
            >
                <Icon name="more" />
            </button>
            {menu && (
                <MessageMenu
                    {...menu}
                    label="Conversation actions"
                    close={closeMenu}
                    actions={[
                        ...actions,
                        {
                            label: muted
                                ? 'Unmute conversation'
                                : 'Mute conversation',
                            icon: muted ? 'bell' : 'bellOff',
                            hint: muted ? undefined : 'Only mentions',
                            run: () => client.setMuted(scope, !muted),
                        },
                        ...(share
                            ? [
                                  {
                                      label: 'Share room history',
                                      icon: 'share',
                                      run: share,
                                      disabled: !online,
                                  },
                              ]
                            : []),
                        {
                            label: 'Clear chat for everyone',
                            icon: 'trash',
                            danger: true,
                            disabled: !online,
                            run: () => setClear({ scope, title }),
                        },
                    ]}
                />
            )}
            {clear && (
                <ConfirmDialog
                    heading="Clear chat for everyone?"
                    action="Clear for everyone"
                    busyAction="Clearing…"
                    close={() => {
                        setClear(null);
                        trigger.current?.focus({ preventScroll: true });
                    }}
                    confirm={() => client.clearConversation(clear.scope)}
                >
                    Delete all messages, files and voice notes in{' '}
                    <strong>{clear.title}</strong> for everyone. This can’t be
                    undone.
                </ConfirmDialog>
            )}
        </>
    );
}

// A destructive action that waits for an explicit confirmation.
export function ConfirmDialog({
    heading,
    children,
    action,
    busyAction,
    close,
    confirm,
}: {
    heading: string;
    children: React.ReactNode;
    action: string;
    busyAction: string;
    close: () => void;
    confirm: () => Promise<void>;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const dismiss = useMobilePanel(dialog, close, { blocked: busy });
    useEffect(() => {
        dialog.current?.showModal();
    }, []);
    const run = async () => {
        if (busy) return;
        setBusy(true);
        try {
            await confirm();
            close();
        } catch (error) {
            setError(
                error instanceof Error
                    ? error.message
                    : 'Something went wrong. Please try again.'
            );
            setBusy(false);
        }
    };
    return (
        <dialog
            ref={dialog}
            className="modal clear-chat-dialog"
            aria-labelledby="confirm-title"
            aria-describedby="confirm-description"
            aria-busy={busy}
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
                <h2 id="confirm-title">{heading}</h2>
                <p id="confirm-description">{children}</p>
                {error && (
                    <p className="form-error" role="alert">
                        {error}
                    </p>
                )}
                <div className="dialog-actions">
                    <button
                        className="subtle-button"
                        autoFocus
                        disabled={busy}
                        onClick={dismiss}
                    >
                        Cancel
                    </button>
                    <button
                        className="destructive-button"
                        disabled={busy}
                        onClick={() => void run()}
                    >
                        {busy ? busyAction : action}
                    </button>
                </div>
            </div>
        </dialog>
    );
}
