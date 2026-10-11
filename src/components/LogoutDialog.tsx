import { useEffect, useRef, useState } from 'react';
import { useMobilePanel } from './useMobilePanel';
import { SheetHandle } from './SheetHandle';

export function LogoutDialog({
    inCall,
    close,
    confirm,
}: {
    inCall: boolean;
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
    const logout = async () => {
        if (busy) return;
        setBusy(true);
        setError('');
        try {
            await confirm();
        } catch {
            setError('Could not log out. Please try again.');
            setBusy(false);
        }
    };
    return (
        <dialog
            ref={dialog}
            className="modal logout-dialog"
            aria-labelledby="logout-title"
            aria-describedby="logout-description"
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
                <h2 id="logout-title">Log out of this space?</h2>
                <p id="logout-description">
                    You’ll need the room password to join again.
                    {inCall && ' You’ll also leave your active call.'}
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
                        onClick={dismiss}
                    >
                        Cancel
                    </button>
                    <button
                        className="primary"
                        disabled={busy}
                        onClick={() => void logout()}
                    >
                        {busy ? 'Logging out…' : 'Log out'}
                    </button>
                </div>
            </div>
        </dialog>
    );
}
