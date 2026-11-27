import { useEffect, useRef, useState } from 'react';
import type { Channel } from '../types';
import type { ChatClient } from '../lib/client';
import { Icon } from '../Icon';
import { useMobilePanel } from './useMobilePanel';
import { SheetHandle } from './SheetHandle';

export function ChannelDialog({
    client,
    close,
    created,
}: {
    client: ChatClient;
    close: () => void;
    created: (scope: string, kind: Channel['kind']) => void;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const [name, setName] = useState('');
    const [kind, setKind] = useState<Channel['kind']>('text');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const dismiss = useMobilePanel(dialog, close, { blocked: busy });
    useEffect(() => {
        dialog.current?.showModal();
    }, []);
    const create = async () => {
        if (busy) return;
        setBusy(true);
        setError('');
        try {
            const scope = await client.createChannel(kind, name);
            dialog.current?.close();
            close();
            if (scope) created(scope, kind);
        } catch (error) {
            setError(
                error instanceof Error
                    ? error.message
                    : 'Could not create the channel.'
            );
            setBusy(false);
        }
    };
    return (
        <dialog
            ref={dialog}
            className="modal channel-dialog"
            aria-labelledby="channel-title"
            aria-busy={busy}
            onCancel={(event) => {
                event.preventDefault();
                if (!busy) dismiss();
            }}
            onClick={(event) => {
                if (!busy && event.target === event.currentTarget) dismiss();
            }}
        >
            <SheetHandle />
            <form
                className="modal-content"
                onSubmit={(event) => {
                    event.preventDefault();
                    void create();
                }}
            >
                <h2 id="channel-title">New channel</h2>
                <fieldset className="channel-kind">
                    <legend>Type</legend>
                    {(['text', 'voice'] as const).map((value) => (
                        <label key={value}>
                            <input
                                type="radio"
                                name="channel-kind"
                                value={value}
                                checked={kind === value}
                                disabled={busy}
                                onChange={() => setKind(value)}
                            />
                            <Icon
                                name={value === 'text' ? 'hash' : 'volume'}
                                size={18}
                            />
                            {value === 'text' ? 'Text' : 'Voice'}
                        </label>
                    ))}
                </fieldset>
                <label htmlFor="channel-name">Name</label>
                <input
                    id="channel-name"
                    value={name}
                    maxLength={32}
                    required
                    autoFocus
                    autoComplete="off"
                    disabled={busy}
                    onChange={(event) => setName(event.target.value)}
                />
                <p className="small-text">
                    Everyone can see and delete channels. The server sees
                    channel names, not messages.
                </p>
                {error && (
                    <p className="form-error" role="alert">
                        {error}
                    </p>
                )}
                <div className="dialog-actions">
                    <button
                        type="button"
                        className="subtle-button"
                        disabled={busy}
                        onClick={dismiss}
                    >
                        Cancel
                    </button>
                    <button type="submit" className="primary" disabled={busy}>
                        {busy ? 'Creating…' : 'Create'}
                    </button>
                </div>
            </form>
        </dialog>
    );
}
