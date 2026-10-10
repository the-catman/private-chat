import { useEffect, useRef, useState } from 'react';
import type { ChatClient } from '../lib/client';
import { Icon } from '../Icon';
import { MessageMenu } from './MessageActions';

export function ConversationActions({
    client,
    scope,
    title,
    online,
    share,
}: {
    client: ChatClient;
    scope: string;
    title: string;
    online: boolean;
    share?: () => void;
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
                <ClearConversationDialog
                    title={clear.title}
                    close={() => {
                        setClear(null);
                        trigger.current?.focus({ preventScroll: true });
                    }}
                    confirm={() => client.clearConversation(clear.scope)}
                />
            )}
        </>
    );
}

function ClearConversationDialog({
    title,
    close,
    confirm,
}: {
    title: string;
    close: () => void;
    confirm: () => Promise<void>;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => {
        dialog.current?.showModal();
    }, []);
    const clear = async () => {
        if (busy) return;
        setBusy(true);
        try {
            await confirm();
            close();
        } catch (error) {
            setError(
                error instanceof Error
                    ? error.message
                    : 'Could not clear this chat.'
            );
            setBusy(false);
        }
    };
    return (
        <dialog
            ref={dialog}
            className="modal clear-chat-dialog"
            aria-labelledby="clear-chat-title"
            aria-describedby="clear-chat-description"
            aria-busy={busy}
            onCancel={(event) => {
                if (busy) event.preventDefault();
                else close();
            }}
            onClick={(event) => {
                if (!busy && event.target === event.currentTarget) close();
            }}
        >
            <div className="modal-content">
                <h2 id="clear-chat-title">Clear chat for everyone?</h2>
                <p id="clear-chat-description">
                    Delete all messages, files and voice notes in{' '}
                    <strong>{title}</strong> for everyone. This can’t be undone.
                </p>
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
                        onClick={close}
                    >
                        Cancel
                    </button>
                    <button
                        className="destructive-button"
                        disabled={busy}
                        onClick={() => void clear()}
                    >
                        {busy ? 'Clearing…' : 'Clear for everyone'}
                    </button>
                </div>
            </div>
        </dialog>
    );
}
