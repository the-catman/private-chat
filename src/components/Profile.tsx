import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Peer, Profile } from '../types';
import type { ChatClient } from '../lib/client';
import { avatarUrl, statusText } from '../lib/content';
import { MAX_STATUS_TEXT, normalizeName } from '../lib/limits';
import { resizeAvatar, type OwnProfile } from '../lib/profile';
import { Icon } from '../Icon';
import { Avatar, statusLabels, type Shown } from './Common';
import { useMobilePanel } from './useMobilePanel';
import { SheetHandle } from './SheetHandle';

export type Verification = 'verified' | 'changed' | null;

// Someone's name, status and picture, beside whatever opened it.
export function ProfileCard({
    peer,
    profile,
    status,
    self,
    verification,
    anchor,
    message,
    edit,
    close,
}: {
    peer: Peer;
    profile: Profile | undefined;
    status: Shown;
    self: boolean;
    verification: Verification;
    anchor: HTMLElement;
    message?: () => void;
    edit?: () => void;
    close: (restoreFocus?: boolean) => void;
}) {
    const card = useRef<HTMLDivElement>(null);
    const closeRef = useRef(close);
    closeRef.current = close;
    useLayoutEffect(() => {
        const node = card.current!;
        const box = anchor.getBoundingClientRect();
        const { width, height } = node.getBoundingClientRect();
        // Beside the anchor where there is room, otherwise over it.
        const left =
            box.right + 8 + width <= innerWidth - 8
                ? box.right + 8
                : box.left - 8 - width >= 8
                  ? box.left - 8 - width
                  : (innerWidth - width) / 2;
        node.style.left = `${Math.max(8, left)}px`;
        node.style.top = `${Math.max(8, Math.min(box.top, innerHeight - height - 8))}px`;
        node.focus({ preventScroll: true });
    }, [anchor]);
    useEffect(() => {
        const outside = (event: Event) => {
            if (
                !card.current?.contains(event.target as Node) &&
                !anchor.contains(event.target as Node)
            )
                closeRef.current();
        };
        const escape = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            closeRef.current(true);
        };
        const resize = () => closeRef.current();
        document.addEventListener('pointerdown', outside);
        document.addEventListener('keydown', escape, true);
        window.addEventListener('resize', resize);
        return () => {
            document.removeEventListener('pointerdown', outside);
            document.removeEventListener('keydown', escape, true);
            window.removeEventListener('resize', resize);
        };
    }, [anchor]);
    return (
        <div
            ref={card}
            className="profile-card"
            role="dialog"
            aria-label={`Profile: ${peer.name}`}
            tabIndex={-1}
        >
            <Avatar
                id={peer.id}
                name={peer.name}
                image={profile?.avatar}
                status={status}
                size="large"
            />
            <h3>
                {peer.name}
                {self && <small>you</small>}
            </h3>
            <span className="profile-status">
                <i className={`status-dot ${status}`} />
                {statusLabels[status]}
            </span>
            {profile?.text && <p className="profile-text">{profile.text}</p>}
            {verification === 'verified' && (
                <span className="profile-verified">
                    <Icon name="shield" size={14} /> Verified in this browser
                </span>
            )}
            {verification === 'changed' && (
                <span className="key-changed">
                    Encryption key changed — verify again
                </span>
            )}
            {(message || edit) && (
                <div className="profile-actions">
                    {message && (
                        <button className="small-primary" onClick={message}>
                            Message
                        </button>
                    )}
                    {edit && (
                        <button className="subtle-button" onClick={edit}>
                            Edit profile
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

export function ProfileDialog({
    id,
    name,
    profile,
    client,
    close,
}: {
    id: string;
    name: string;
    profile: OwnProfile;
    client: ChatClient;
    close: () => void;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const picker = useRef<HTMLInputElement>(null);
    const [draftName, setDraftName] = useState(name);
    const [text, setText] = useState(profile.text);
    const [avatar, setAvatar] = useState(profile.avatar);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const dismiss = useMobilePanel(dialog, close, { blocked: busy });
    useEffect(() => {
        dialog.current?.showModal();
    }, []);
    const preview = avatar ? avatarUrl(avatar) || undefined : undefined;
    const choose = async (file: File | undefined) => {
        if (!file) return;
        setError('');
        try {
            setAvatar(await resizeAvatar(file));
        } catch (error) {
            setError(
                error instanceof Error
                    ? error.message
                    : 'Could not use that picture.'
            );
        }
    };
    const save = async () => {
        if (busy) return;
        setBusy(true);
        setError('');
        try {
            if (normalizeName(draftName) !== name)
                await client.rename(draftName);
            if (statusText(text) !== profile.text || avatar !== profile.avatar)
                await client.setProfile({ text, avatar });
            dialog.current?.close();
            close();
        } catch (error) {
            setError(
                error instanceof Error
                    ? error.message
                    : 'Could not save your profile.'
            );
            setBusy(false);
        }
    };
    return (
        <dialog
            ref={dialog}
            className="modal profile-dialog"
            aria-labelledby="profile-title"
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
                    void save();
                }}
            >
                <button
                    type="button"
                    className="icon-button modal-close"
                    aria-label="Close profile"
                    disabled={busy}
                    onClick={dismiss}
                >
                    <Icon name="close" />
                </button>
                <h2 id="profile-title">Profile</h2>
                <div className="profile-picture">
                    <Avatar
                        id={id}
                        name={normalizeName(draftName) || name}
                        image={preview}
                        size="large"
                    />
                    <button
                        type="button"
                        className="subtle-button"
                        disabled={busy}
                        onClick={() => picker.current?.click()}
                    >
                        {avatar ? 'Change picture' : 'Add picture'}
                    </button>
                    {avatar && (
                        <button
                            type="button"
                            className="subtle-button"
                            disabled={busy}
                            onClick={() => setAvatar(undefined)}
                        >
                            Remove
                        </button>
                    )}
                    <input
                        ref={picker}
                        type="file"
                        accept="image/*"
                        hidden
                        aria-label="Choose profile picture"
                        onChange={(event) => {
                            void choose(event.target.files?.[0]);
                            event.target.value = '';
                        }}
                    />
                </div>
                <label htmlFor="profile-name">Name</label>
                <input
                    id="profile-name"
                    autoComplete="nickname"
                    value={draftName}
                    maxLength={32}
                    required
                    disabled={busy}
                    onChange={(event) => setDraftName(event.target.value)}
                />
                <label htmlFor="profile-status">Status</label>
                <input
                    id="profile-status"
                    value={text}
                    maxLength={MAX_STATUS_TEXT}
                    disabled={busy}
                    onChange={(event) => setText(event.target.value)}
                />
                <p className="small-text">
                    Your picture and status are end-to-end encrypted.
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
                        {busy ? 'Saving…' : 'Save'}
                    </button>
                </div>
            </form>
        </dialog>
    );
}
