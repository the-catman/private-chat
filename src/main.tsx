import React, {
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from 'react';
import { createRoot } from 'react-dom/client';
import { ChatClient } from './lib/client';
import { b64, unb64, dmScope, safetyCode, partHashes } from './lib/crypto';
import { Icon } from './Icon';
import type { Peer, ChatState, Content, Message, Reaction } from './types';
import {
    Avatar,
    IconButton,
    color,
    minutes,
    shownStatus,
    statusLabels,
    type Shown,
} from './components/Common';
import {
    ProfileCard,
    ProfileDialog,
    type Verification,
} from './components/Profile';
import { storedProfile } from './lib/profile';
import { CallPanel } from './components/CallPanel';
import { AppearanceControls } from './components/Appearance';
import { EmojiPicker } from './components/EmojiPicker';
import {
    PinnedPanel,
    ReactionPicker,
    Reactions,
    ReplyQuote,
    snippet,
} from './components/MessageExtras';
import { mentionQuery, mentions } from './lib/mentions';
import { LogoutDialog } from './components/LogoutDialog';
import { MarkdownMessage, MarkdownHelp } from './components/MarkdownMessage';
import {
    MessageInput,
    type MessageInputHandle,
} from './components/MessageInput';
import { ShortcutHelp } from './components/ShortcutHelp';
import { FileAttachment } from './components/FileAttachment';
import { ParticipantVolume } from './components/ParticipantVolume';
import { ConversationActions } from './components/ConversationActions';
import { useChatViewport, useMobileLayout } from './components/useMobileLayout';
import { useMobilePanel } from './components/useMobilePanel';
import { SheetHandle } from './components/SheetHandle';
import {
    MessageMenu,
    MessageEditor,
    MessageActionDialog,
    type ActionDialog,
    type MenuAction,
} from './components/MessageActions';
import { EMOJI, emojiQuery, replaceEmoji } from './lib/emoji';
import { MAX_FILE_BYTES, MAX_BATCH } from './lib/limits';
import { fileSize } from './lib/content';
import './fonts.css';
import './style.css';
import './components/call.css';
import './components/chat-qol.css';
import './components/message-tools.css';
import './components/mobile.css';
import './components/profile.css';
import { installSoundActivation, playSound } from './lib/sounds';
import { captureMicrophone } from './lib/microphone';

const client = new ChatClient(playSound);
type Modal = { type: 'privacy' } | { type: 'safety'; peer: Peer } | null;

function Login({ state }: { state: ChatState }) {
    const [name, setName] = useState(
        () => localStorage.getItem('hush-name') || ''
    );
    const [password, setPassword] = useState('');
    const joining = state.phase === 'joining';
    return (
        <main className="login-page">
            <div className="login-top">
                <AppearanceControls />
            </div>
            <section className="login-card">
                <h1>Hush</h1>
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        void client.login(name, password);
                        setPassword('');
                    }}
                >
                    <label htmlFor="display-name">Name</label>
                    <input
                        id="display-name"
                        name="name"
                        autoComplete="nickname"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        minLength={1}
                        maxLength={32}
                        required
                        disabled={joining}
                        autoFocus
                    />
                    <label htmlFor="room-password">Password</label>
                    <input
                        id="room-password"
                        name="password"
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        disabled={joining}
                    />
                    {state.error && (
                        <div className="form-error" role="alert">
                            {state.error}
                        </div>
                    )}
                    <button
                        className="primary login-submit"
                        disabled={joining || !name.trim()}
                    >
                        {joining ? (
                            <>
                                <span className="spinner" /> Logging in…
                            </>
                        ) : (
                            'Log in'
                        )}
                    </button>
                </form>
            </section>
        </main>
    );
}

// Verified identity ids by lowercased name. No prototype, so names such as
// "constructor" or "__proto__" behave like any other name.
function verifiedIds() {
    const ids: Record<string, string> = Object.create(null);
    try {
        const stored = JSON.parse(
            localStorage.getItem('hush-verified') || '{}'
        );
        if (stored && typeof stored === 'object' && !Array.isArray(stored))
            for (const [name, id] of Object.entries(stored))
                if (typeof id === 'string') ids[name] = id;
    } catch {}
    return ids;
}
// A verified person stays verified after a rename. Someone else using a
// verified name gets a warning, whoever had it first.
function verification(
    verified: Record<string, string>,
    peer: Peer
): Verification {
    const holder = verified[peer.name.toLowerCase()];
    if (holder) return holder === peer.id ? 'verified' : 'changed';
    return Object.values(verified).includes(peer.id) ? 'verified' : null;
}

// One malformed message must not take down the whole conversation.
class MessageBoundary extends React.Component<
    { children: React.ReactNode },
    { failed: boolean }
> {
    state = { failed: false };
    static getDerivedStateFromError() {
        return { failed: true };
    }
    render() {
        return this.state.failed ? (
            <span className="message-note">This message can’t be shown.</span>
        ) : (
            this.props.children
        );
    }
}

function VoiceNote({
    content,
}: {
    content: Extract<Content, { kind: 'voice' }>;
}) {
    const [url, setUrl] = useState('');
    useEffect(() => {
        const objectUrl = URL.createObjectURL(
            new Blob([unb64(content.audio)], { type: content.mime })
        );
        setUrl(objectUrl);
        return () => URL.revokeObjectURL(objectUrl);
    }, [content.audio, content.mime]);
    return (
        <div className="voice-note">
            <span className="voice-note-icon">
                <Icon name="wave" size={21} />
            </span>
            <div>
                <span className="voice-note-label">
                    Voice note <small>{minutes(content.duration)}</small>
                </span>
                <audio
                    controls
                    controlsList="nodownload"
                    src={url || undefined}
                    preload="metadata"
                    aria-label="Play voice note"
                />
            </div>
        </div>
    );
}

const clock = (time: number) =>
    new Date(time).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
    });

function dayLabel(time: number) {
    const date = new Date(time);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return date.toLocaleDateString([], {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        ...(date.getFullYear() !== today.getFullYear() && {
            year: 'numeric',
        }),
    });
}

// Previews open as dialogs inside their message; events there are theirs.
const inDialog = (event: React.SyntheticEvent) =>
    Boolean((event.target as HTMLElement).closest('dialog'));

// Messages from one person within a few minutes share a single header.
const GROUP_MS = 5 * 60_000;

// What a message needs from the conversation around it.
type MessageContext = {
    self: string;
    selfName: string;
    names: string[];
    online: boolean;
    nameOf: (id: string) => string;
    avatarOf: (id: string) => string | undefined;
    profile: (id: string, anchor: HTMLElement) => void;
    react: (message: Message, trigger: HTMLElement) => void;
    reply: (message: Message) => void;
    jump: (id: string) => void;
};

function ChatMessage({
    message,
    context,
    continued,
    reactions,
    pinned,
    parent,
    mentioned,
    selectionMode,
    selected,
    toggle,
    menu,
    edit,
    remove,
    editing,
    closeEditor,
}: {
    message: Message;
    context: MessageContext;
    continued: boolean;
    reactions: Record<string, Reaction> | undefined;
    pinned: boolean;
    parent: Message | undefined;
    mentioned: boolean;
    selectionMode: boolean;
    selected: boolean;
    toggle: (id: string, range?: boolean) => void;
    menu: (message: Message, x: number, y: number, source: HTMLElement) => void;
    edit: (message: Message) => void;
    remove: (message: Message, immediate?: boolean) => void;
    editing: boolean;
    closeEditor: () => void;
}) {
    const { self } = context;
    const mine = message.from === self;
    const reply =
        message.payload.kind === 'text' ? message.payload.reply : undefined;
    const ready = message.status === 'sent' && context.online;
    return (
        <article
            className={`message ${mine ? 'mine' : ''} ${continued ? 'continued' : ''} ${mentioned ? 'mentioned' : ''} ${selected ? 'is-selected' : ''}`}
            data-testid="chat-message"
            data-message-id={message.id}
            tabIndex={0}
            onContextMenu={(event) => {
                if (editing || inDialog(event)) return;
                if (event.ctrlKey && !event.altKey && !event.metaKey) {
                    if (
                        (event.target as HTMLElement).closest(
                            'button, input, a, audio, textarea, select, [contenteditable]'
                        )
                    )
                        return;
                    event.preventDefault();
                    edit(message);
                    return;
                }
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                menu(
                    message,
                    event.clientX || rect.left + 20,
                    event.clientY || rect.top + 20,
                    event.currentTarget
                );
            }}
            onKeyDown={(event) => {
                if (
                    !editing &&
                    !inDialog(event) &&
                    (event.key === 'ContextMenu' ||
                        (event.shiftKey && event.key === 'F10'))
                ) {
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    menu(
                        message,
                        rect.left + 24,
                        rect.top + 24,
                        event.currentTarget
                    );
                }
            }}
            onClick={(event) => {
                if (
                    editing ||
                    inDialog(event) ||
                    (event.target as HTMLElement).closest(
                        'button, input, a, audio, textarea, select, [contenteditable]'
                    )
                )
                    return;
                if (event.ctrlKey && !event.altKey && !event.metaKey) {
                    event.preventDefault();
                    remove(message, event.shiftKey);
                    return;
                }
                if (selectionMode) toggle(message.id, event.shiftKey);
            }}
        >
            {selectionMode && (
                <input
                    className="message-checkbox"
                    type="checkbox"
                    aria-label={`Select message from ${message.name}`}
                    checked={selected}
                    disabled={message.status !== 'sent'}
                    onClick={(event) => toggle(message.id, event.shiftKey)}
                    onChange={() => {}}
                />
            )}
            {continued ? (
                <span className="message-gutter" aria-hidden="true">
                    {mine && message.status === 'sending' ? (
                        <Icon name="clock" size={13} />
                    ) : (
                        clock(message.time)
                    )}
                </span>
            ) : (
                <button
                    type="button"
                    className="avatar-button"
                    aria-label={`Profile: ${message.name}`}
                    tabIndex={-1}
                    onClick={(event) =>
                        context.profile(message.from, event.currentTarget)
                    }
                >
                    <Avatar
                        id={message.from}
                        name={message.name}
                        image={context.avatarOf(message.from)}
                    />
                </button>
            )}
            <div className="message-main">
                {reply && <ReplyQuote parent={parent} jump={context.jump} />}
                <div
                    className={`message-meta ${continued ? 'visually-hidden' : ''}`}
                >
                    <strong
                        className="author-name"
                        style={
                            {
                                '--name-color': color(message.from),
                            } as React.CSSProperties
                        }
                    >
                        <button
                            type="button"
                            onClick={(event) =>
                                context.profile(
                                    message.from,
                                    event.currentTarget
                                )
                            }
                        >
                            {message.name}
                        </button>
                    </strong>
                    <time dateTime={new Date(message.time).toISOString()}>
                        {clock(message.time)}
                    </time>
                    {mine && (
                        <span
                            className="message-delivery"
                            title={
                                message.status === 'sent' ? 'Sent' : 'Sending…'
                            }
                        >
                            <Icon
                                name={
                                    message.status === 'sent'
                                        ? 'checkDouble'
                                        : 'clock'
                                }
                                size={13}
                            />
                        </span>
                    )}
                    {pinned && !continued && (
                        <span className="message-note pinned-note">
                            <Icon name="pin" size={12} /> Pinned
                        </span>
                    )}
                </div>
                {message.edited && <span className="message-note">edited</span>}
                {pinned && continued && (
                    <span className="message-note pinned-note">
                        <Icon name="pin" size={12} /> Pinned
                    </span>
                )}
                {message.sharedBy && (
                    <span className="message-note">
                        History shared by {message.sharedBy}
                    </span>
                )}
                {editing ? (
                    <MessageEditor
                        message={message}
                        client={client}
                        close={closeEditor}
                        remove={() => remove(message)}
                    />
                ) : (
                    <MessageBoundary key={message.envelope.id}>
                        {message.payload.kind === 'voice' ? (
                            <VoiceNote content={message.payload} />
                        ) : message.payload.kind === 'file' ? (
                            <FileAttachment
                                content={message.payload}
                                bytes={message.bytes}
                                progress={message.progress}
                                sending={message.status === 'sending'}
                                unavailable={message.unavailable}
                                fetch={() => client.fetchFile(message.id)}
                            />
                        ) : (
                            <MarkdownMessage
                                text={message.payload.text}
                                names={context.names}
                                self={context.selfName}
                            />
                        )}
                    </MessageBoundary>
                )}
                <Reactions
                    reactions={reactions}
                    scope={message.scope}
                    self={self}
                    name={context.nameOf}
                    disabled={!ready}
                    toggle={(emoji) =>
                        void client
                            .react(message.id, emoji)
                            .catch((error: Error) =>
                                client.notify(error.message)
                            )
                    }
                    add={(trigger) => context.react(message, trigger)}
                />
                {message.status === 'failed' && (
                    <button
                        className="retry-message"
                        onClick={() => client.retry(message.id)}
                    >
                        Not sent · Retry
                    </button>
                )}
            </div>
            {!editing && (
                <div className="message-actions">
                    {ready && (
                        <>
                            <button
                                className="icon-button quick-action"
                                aria-label="Add reaction"
                                title="Add reaction"
                                onClick={(event) =>
                                    context.react(message, event.currentTarget)
                                }
                            >
                                <Icon name="smile" size={18} />
                            </button>
                            <button
                                className="icon-button quick-action"
                                aria-label="Reply"
                                title="Reply"
                                onClick={() => context.reply(message)}
                            >
                                <Icon name="reply" size={18} />
                            </button>
                        </>
                    )}
                    <button
                        className="icon-button message-more"
                        aria-label={`Actions for message from ${message.name}`}
                        title="Message actions"
                        onClick={(event) => {
                            const rect =
                                event.currentTarget.getBoundingClientRect();
                            menu(
                                message,
                                rect.right,
                                rect.bottom,
                                event.currentTarget
                            );
                        }}
                    >
                        <Icon name="more" />
                    </button>
                </div>
            )}
        </article>
    );
}

function Composer({
    state,
    recipient,
    mentionNames,
    reply,
    cancelReply,
    editLast,
}: {
    state: ChatState;
    recipient?: Peer;
    mentionNames: string[];
    reply?: Message;
    cancelReply: () => void;
    editLast: () => void;
}) {
    const mobile = useMobileLayout();
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [options, setOptions] = useState<{ x: number; y: number } | null>(
        null
    );
    const optionsTrigger = useRef<HTMLButtonElement>(null);
    const [emojis, setEmojis] = useState(false);
    const [formatting, setFormatting] = useState(false);
    const [shortcuts, setShortcuts] = useState(false);
    const emojiTrigger = useRef<HTMLSpanElement>(null);
    const suggestionPanel = useRef<HTMLDivElement>(null);
    const [cursor, setCursor] = useState(0);
    const [emojiIndex, setEmojiIndex] = useState(0);
    const [emojiDismissed, setEmojiDismissed] = useState(false);
    const [file, setFile] = useState<File | null>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const [sending, setSending] = useState(false);
    const sendInFlight = useRef(false);
    const [completedSend, setCompletedSend] = useState<{
        scope: string;
    } | null>(null);
    const [recording, setRecording] = useState(false);
    const [seconds, setSeconds] = useState(0);
    const [voice, setVoice] = useState<Extract<
        Content,
        { kind: 'voice' }
    > | null>(null);
    const recorder = useRef<MediaRecorder | null>(null);
    const recordingMicrophone = useRef<Awaited<
        ReturnType<typeof captureMicrophone>
    > | null>(null);
    const currentScope = useRef(state.scope);
    currentScope.current = state.scope;
    const mounted = useRef(true);
    const requestingMic = useRef(false);
    const cancelled = useRef(false);
    const text = drafts[state.scope] || '';
    const input = useRef<MessageInputHandle>(null);
    useLayoutEffect(() => {
        // File and voice previews disable the editor until React removes them.
        // Text sends keep focus throughout and need no completion-time refocus.
        if (completedSend?.scope === currentScope.current)
            input.current?.focus({ preventScroll: true });
    }, [completedSend]);
    const suggesting = !emojiDismissed && !emojis && !file && !voice;
    const mention = suggesting
        ? mentionQuery(
              text,
              cursor,
              mentionNames.filter((name) => name !== state.name)
          )
        : null;
    const suggestions =
        suggesting && !mention ? emojiQuery(text, cursor) : null;
    const insertMention = (name: string) => {
        if (!mention) return;
        const value = `${text.slice(0, mention.start)}@${name} ${text.slice(mention.end)}`;
        if (value.length > 4000) return;
        const caret = mention.start + name.length + 2;
        setDrafts((values) => ({ ...values, [state.scope]: value }));
        setCursor(caret);
        setEmojiDismissed(true);
        setEmojiIndex(0);
        requestAnimationFrame(() => {
            input.current?.focus();
            input.current?.setSelectionRange(caret, caret);
        });
    };
    const chooseEmoji = (emoji: string) => {
        const start = input.current?.selectionStart ?? text.length;
        const end = input.current?.selectionEnd ?? start;
        const value = text.slice(0, start) + emoji + text.slice(end);
        if (value.length > 4000) {
            client.notify('Messages can be up to 4,000 characters.');
            return;
        }
        setDrafts((values) => ({ ...values, [state.scope]: value }));
        setCursor(start + emoji.length);
        setEmojis(false);
        setEmojiDismissed(true);
        requestAnimationFrame(() => {
            input.current?.focus();
            input.current?.setSelectionRange(
                start + emoji.length,
                start + emoji.length
            );
        });
    };
    const insertEmoji = (name: string) => {
        if (!suggestions) return;
        const start = suggestions.start;
        const end = suggestions.end + (text[suggestions.end] === ':' ? 1 : 0);
        const value =
            text.slice(0, start) + EMOJI[name] + ' ' + text.slice(end);
        setDrafts((values) => ({ ...values, [state.scope]: value }));
        setEmojiDismissed(true);
        setEmojiIndex(0);
        requestAnimationFrame(() => {
            input.current?.focus();
            input.current?.setSelectionRange(
                start + EMOJI[name].length + 1,
                start + EMOJI[name].length + 1
            );
        });
    };
    const attach = (picked?: File) => {
        if (!picked) return;
        if (picked.size > MAX_FILE_BYTES) {
            client.notify('Files can be up to 256 MB. Choose a smaller file.');
            return;
        }
        setFile(picked);
        setEmojis(false);
    };
    // DMs to someone offline wait on the server until they return.
    const offline =
        state.phase !== 'online' || (state.scope !== 'room' && !recipient);
    useEffect(() => {
        if (!suggestions && !mention) return;
        const dismiss = (event: PointerEvent) => {
            if (
                !suggestionPanel.current?.contains(event.target as Node) &&
                !input.current?.element?.contains(event.target as Node)
            )
                setEmojiDismissed(true);
        };
        document.addEventListener('pointerdown', dismiss);
        return () => document.removeEventListener('pointerdown', dismiss);
    }, [Boolean(suggestions || mention)]);
    useEffect(() => {
        if (offline || recording) {
            setEmojis(false);
            setOptions(null);
        }
    }, [offline, recording]);
    useEffect(
        () => () => {
            mounted.current = false;
            cancelled.current = true;
            if (recorder.current?.state === 'recording')
                recorder.current.stop();
            recorder.current?.stream.getTracks().forEach((t) => t.stop());
            recordingMicrophone.current?.close();
        },
        []
    );
    useEffect(() => {
        setVoice(null);
        setFile(null);
        setEmojiDismissed(true);
        setEmojis(false);
        setOptions(null);
        if (recorder.current?.state === 'recording') {
            cancelled.current = true;
            recorder.current.stop();
        }
    }, [state.scope]);
    useEffect(() => {
        if (!recording) return;
        const timer = setInterval(() => setSeconds((value) => value + 1), 1000);
        return () => clearInterval(timer);
    }, [recording]);
    useEffect(() => {
        if (seconds >= 120 && recorder.current?.state === 'recording')
            recorder.current.stop();
    }, [seconds]);
    async function record() {
        if (requestingMic.current || recording) return;
        requestingMic.current = true;
        try {
            if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
                throw new Error(
                    'Voice recording is unavailable in this browser.'
                );
            const scope = state.scope;
            const microphone = await captureMicrophone(() =>
                client.notify(
                    'Enhanced noise reduction is unavailable. Using browser noise reduction.'
                )
            );
            const stream = microphone.stream;
            if (!mounted.current || currentScope.current !== scope) {
                microphone.close();
                return;
            }
            recordingMicrophone.current = microphone;
            const mime = [
                'audio/webm;codecs=opus',
                'audio/ogg;codecs=opus',
                'audio/mp4',
            ].find((type) => MediaRecorder.isTypeSupported(type));
            if (!mime) {
                microphone.close();
                throw new Error(
                    'This browser does not support voice recording.'
                );
            }
            const mediaRecorder = new MediaRecorder(stream, {
                mimeType: mime,
                audioBitsPerSecond: 32_000,
            });
            recorder.current = mediaRecorder;
            cancelled.current = false;
            const chunks: BlobPart[] = [];
            let bytes = 0;
            const started = Date.now();
            mediaRecorder.ondataavailable = (event) => {
                bytes += event.data.size;
                chunks.push(event.data);
                if (bytes > 1_400_000 && mediaRecorder.state === 'recording')
                    mediaRecorder.stop();
            };
            mediaRecorder.onstop = () => {
                microphone.close();
                setRecording(false);
                if (cancelled.current) return;
                const blob = new Blob(chunks, { type: mime });
                void blob.arrayBuffer().then((buffer) => {
                    if (
                        !mounted.current ||
                        cancelled.current ||
                        currentScope.current !== scope ||
                        recorder.current !== mediaRecorder
                    )
                        return;
                    setVoice({
                        kind: 'voice',
                        mime,
                        audio: b64(buffer),
                        duration: Math.min(120, (Date.now() - started) / 1000),
                    });
                });
            };
            mediaRecorder.onerror = () => {
                cancelled.current = true;
                microphone.close();
                setRecording(false);
                client.notify(
                    'Voice recording stopped unexpectedly. Please try again.'
                );
            };
            mediaRecorder.start(1000);
            setSeconds(0);
            setRecording(true);
        } catch (error) {
            recordingMicrophone.current?.close();
            client.notify(
                error instanceof Error && error.name !== 'NotAllowedError'
                    ? error.message
                    : 'Allow microphone access to record a voice note.'
            );
        } finally {
            requestingMic.current = false;
        }
    }
    async function send() {
        if (
            offline ||
            sendInFlight.current ||
            (!text.trim() && !voice && !file)
        )
            return;
        const scope = state.scope;
        const isText = !file && !voice;
        sendInFlight.current = true;
        setSending(true);
        setEmojis(false);
        setEmojiDismissed(true);
        const replying = isText ? reply?.id : undefined;
        if (isText) {
            // Keep the editor live while encryption runs. Completion must not
            // clear anything the user has already typed for their next message.
            if (replying) cancelReply();
            setDrafts((values) => ({ ...values, [scope]: '' }));
            setCursor(0);
            input.current?.focus({ preventScroll: true });
        }
        try {
            const bytes = file
                ? new Uint8Array(await file.arrayBuffer())
                : undefined;
            const payload: Content = bytes
                ? {
                      kind: 'file',
                      name: file!.name.slice(0, 255) || 'attachment',
                      mime: file!.type.slice(0, 128),
                      size: bytes.length,
                      hashes: await partHashes(bytes),
                  }
                : voice || {
                      kind: 'text',
                      text: replaceEmoji(text.trim()),
                      ...(replying && { reply: replying }),
                  };
            await client.send(payload, scope, bytes);
            if (file) setFile((current) => (current === file ? null : current));
            else if (voice)
                setVoice((current) => (current === voice ? null : current));
        } catch (error) {
            if (isText)
                setDrafts((values) => ({
                    ...values,
                    [scope]: values[scope] ? `${text}\n${values[scope]}` : text,
                }));
            client.notify(
                error instanceof Error
                    ? error.message
                    : 'Message could not be sent.'
            );
        } finally {
            sendInFlight.current = false;
            setSending(false);
            if (!isText) setCompletedSend({ scope });
        }
    }
    const typing = state.peers.filter(
        (p) =>
            p.id !== state.self &&
            (state.typing[`${state.scope}:${p.id}`] || 0) > Date.now()
    );
    return (
        <div
            className="composer-wrap"
            onDragOver={(event) => {
                if (!offline && !recording && !voice && !(sending && file))
                    event.preventDefault();
            }}
            onDrop={(event) => {
                event.preventDefault();
                if (!offline && !recording && !voice && !(sending && file))
                    attach(event.dataTransfer.files[0]);
            }}
        >
            <input
                ref={fileInput}
                type="file"
                className="visually-hidden"
                aria-label="Choose attachment"
                tabIndex={-1}
                onChange={(event) => {
                    attach(event.target.files?.[0]);
                    event.target.value = '';
                }}
            />
            {file && (
                <div className="attachment-preview">
                    <Icon name="file" />
                    <span>
                        <strong>{file.name}</strong>
                        <small>{fileSize(file.size)} · Ready to send</small>
                    </span>
                    <IconButton
                        icon="close"
                        label="Remove attachment"
                        disabled={sending}
                        onClick={() => setFile(null)}
                    />
                </div>
            )}
            <div className="typing-line" aria-live="polite">
                {typing.length > 0 && (
                    <>
                        <span className="typing-dots">•••</span>{' '}
                        {typing.map((p) => p.name).join(', ')}{' '}
                        {typing.length > 1 ? 'are' : 'is'} typing
                    </>
                )}
            </div>
            {reply && (
                <div className="reply-bar">
                    <Icon name="reply" size={15} />
                    <span>
                        Replying to <strong>{reply.name}</strong>
                        <small>{snippet(reply)}</small>
                    </span>
                    <IconButton
                        icon="close"
                        label="Cancel reply"
                        onClick={() => {
                            cancelReply();
                            input.current?.focus();
                        }}
                    />
                </div>
            )}
            {voice && (
                <div className="voice-preview">
                    <VoiceNote content={voice} />
                    <IconButton
                        icon="trash"
                        label="Discard voice note"
                        onClick={() => setVoice(null)}
                    />
                </div>
            )}
            <div className={`composer ${offline ? 'disabled' : ''}`}>
                <div className="composer-input-row">
                    {recording ? (
                        <>
                            <span className="recording-dot" />
                            <span className="recording-label">
                                Recording <b>{minutes(seconds)}</b>
                                <small>2 min maximum</small>
                            </span>
                            <IconButton
                                icon="trash"
                                label="Cancel recording"
                                onClick={() => {
                                    cancelled.current = true;
                                    recorder.current?.stop();
                                }}
                            />
                            <button
                                className="record-stop"
                                onClick={() => recorder.current?.stop()}
                            >
                                <Icon name="stop" size={18} /> Finish
                            </button>
                        </>
                    ) : (
                        <>
                            {mobile && (
                                <span
                                    ref={emojiTrigger}
                                    className="composer-options"
                                >
                                    <button
                                        ref={optionsTrigger}
                                        className="icon-button"
                                        aria-label="Message options"
                                        aria-haspopup="dialog"
                                        aria-expanded={Boolean(options)}
                                        disabled={offline}
                                        onClick={(event) => {
                                            setEmojis(false);
                                            setEmojiDismissed(true);
                                            const box =
                                                event.currentTarget.getBoundingClientRect();
                                            setOptions({
                                                x: box.left,
                                                y: box.top,
                                            });
                                        }}
                                    >
                                        <Icon name="plus" />
                                    </button>
                                </span>
                            )}
                            <MessageInput
                                key={state.scope}
                                ref={input}
                                suggestions={
                                    mention
                                        ? {
                                              controls: 'mention-suggestions',
                                              active: `mention-option-${Math.min(emojiIndex, mention.results.length - 1)}`,
                                          }
                                        : suggestions
                                          ? {
                                                controls: 'emoji-suggestions',
                                                active: `emoji-option-${Math.min(emojiIndex, suggestions.results.length - 1)}`,
                                            }
                                          : undefined
                                }
                                label={
                                    recipient
                                        ? `Message ${recipient.name}`
                                        : 'Message #general'
                                }
                                placeholder={
                                    offline
                                        ? mobile
                                            ? 'Waiting to connect…'
                                            : 'Waiting for a connection…'
                                        : file
                                          ? mobile
                                              ? 'File ready to send'
                                              : 'Your file is ready to send'
                                          : voice
                                            ? mobile
                                                ? 'Voice note ready'
                                                : 'Your voice note is ready to send'
                                            : mobile
                                              ? 'Message…'
                                              : recipient
                                                ? `Message ${recipient.name}`
                                                : 'Message #general'
                                }
                                value={text}
                                onChange={(value, cursor) => {
                                    setDrafts((values) => ({
                                        ...values,
                                        [state.scope]: value,
                                    }));
                                    setCursor(cursor);
                                    setEmojiIndex(0);
                                    setEmojiDismissed(false);
                                    void client.typing();
                                }}
                                onSelect={setCursor}
                                onLimit={() =>
                                    client.notify(
                                        'Messages can be up to 4,000 characters.'
                                    )
                                }
                                onPaste={(event) => {
                                    if (event.clipboardData?.files[0]) {
                                        event.preventDefault();
                                        attach(event.clipboardData.files[0]);
                                    }
                                }}
                                enterKeyHint={mobile ? 'enter' : 'send'}
                                disabled={
                                    offline || Boolean(voice) || Boolean(file)
                                }
                                onKeyDown={(event) => {
                                    if (event.isComposing) return;
                                    const list = mention ?? suggestions;
                                    if (
                                        list &&
                                        [
                                            'ArrowDown',
                                            'ArrowUp',
                                            'Enter',
                                            'Tab',
                                            'Escape',
                                        ].includes(event.key)
                                    ) {
                                        event.preventDefault();
                                        if (event.key === 'Escape')
                                            setEmojiDismissed(true);
                                        else if (
                                            event.key === 'ArrowDown' ||
                                            event.key === 'ArrowUp'
                                        )
                                            setEmojiIndex(
                                                (value) =>
                                                    (value +
                                                        (event.key ===
                                                        'ArrowDown'
                                                            ? 1
                                                            : -1) +
                                                        list.results.length) %
                                                    list.results.length
                                            );
                                        else {
                                            const index = Math.min(
                                                emojiIndex,
                                                list.results.length - 1
                                            );
                                            if (mention)
                                                insertMention(
                                                    mention.results[index]!
                                                );
                                            else
                                                insertEmoji(
                                                    suggestions!.results[index]
                                                );
                                        }
                                        return;
                                    }
                                    if (event.key === 'Escape' && reply) {
                                        event.preventDefault();
                                        cancelReply();
                                        return;
                                    }
                                    if (
                                        event.key === 'ArrowUp' &&
                                        !event.ctrlKey &&
                                        !event.shiftKey &&
                                        !event.altKey &&
                                        !event.metaKey &&
                                        !text &&
                                        !voice &&
                                        !file &&
                                        !sending
                                    ) {
                                        event.preventDefault();
                                        editLast();
                                        return;
                                    }
                                    if (
                                        event.key === 'Enter' &&
                                        !event.shiftKey &&
                                        !event.isComposing &&
                                        (!mobile ||
                                            !window.matchMedia(
                                                '(pointer: coarse)'
                                            ).matches ||
                                            event.ctrlKey ||
                                            event.metaKey)
                                    ) {
                                        event.preventDefault();
                                        void send();
                                    }
                                }}
                            />
                            <div className="composer-tools">
                                {!mobile && (
                                    <>
                                        <IconButton
                                            icon="attach"
                                            label="Attach file (up to 256 MB)"
                                            disabled={
                                                offline ||
                                                Boolean(voice) ||
                                                (sending && Boolean(file))
                                            }
                                            onClick={() =>
                                                fileInput.current?.click()
                                            }
                                        />
                                        <span ref={emojiTrigger}>
                                            <button
                                                className={`icon-button ${emojis ? 'active' : ''}`}
                                                aria-label="Add emoji"
                                                title="Add emoji"
                                                aria-expanded={emojis}
                                                aria-haspopup="dialog"
                                                disabled={
                                                    offline ||
                                                    Boolean(voice) ||
                                                    Boolean(file)
                                                }
                                                onClick={() => {
                                                    setEmojis(!emojis);
                                                    setEmojiDismissed(true);
                                                }}
                                            >
                                                <Icon name="smile" />
                                            </button>
                                        </span>
                                        <IconButton
                                            icon="mic"
                                            label="Record voice note"
                                            disabled={
                                                offline ||
                                                Boolean(voice) ||
                                                Boolean(file)
                                            }
                                            onClick={() => void record()}
                                        />
                                    </>
                                )}
                                {mobile &&
                                !text.trim() &&
                                !voice &&
                                !file &&
                                !sending ? (
                                    <IconButton
                                        icon="mic"
                                        label="Record voice note"
                                        disabled={offline}
                                        onClick={() => void record()}
                                    />
                                ) : (
                                    <button
                                        className="send-button"
                                        aria-label="Send message"
                                        disabled={
                                            offline ||
                                            sending ||
                                            (!text.trim() && !voice && !file)
                                        }
                                        onMouseDown={(event) => {
                                            if (event.button === 0)
                                                event.preventDefault();
                                        }}
                                        onClick={() => void send()}
                                    >
                                        <Icon name="send" size={20} />
                                    </button>
                                )}
                            </div>
                        </>
                    )}
                </div>
                {mention && (
                    <div
                        ref={suggestionPanel}
                        className="emoji-suggestions mention-suggestions"
                        id="mention-suggestions"
                        role="listbox"
                        aria-label="Mention suggestions"
                    >
                        {mention.results.map((name, index) => (
                            <button
                                key={name}
                                id={`mention-option-${index}`}
                                type="button"
                                role="option"
                                aria-selected={
                                    index ===
                                    Math.min(
                                        emojiIndex,
                                        mention.results.length - 1
                                    )
                                }
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => insertMention(name)}
                            >
                                <span>@{name}</span>
                            </button>
                        ))}
                    </div>
                )}
                {suggestions && (
                    <div
                        ref={suggestionPanel}
                        className="emoji-suggestions"
                        id="emoji-suggestions"
                        role="listbox"
                        aria-label="Emoji suggestions"
                    >
                        <div className="emoji-suggestion-hint">
                            Emoji · ↑ ↓ to choose · Tab to insert
                        </div>
                        {suggestions.results.map((name, index) => (
                            <button
                                key={name}
                                id={`emoji-option-${index}`}
                                type="button"
                                role="option"
                                aria-selected={
                                    index ===
                                    Math.min(
                                        emojiIndex,
                                        suggestions.results.length - 1
                                    )
                                }
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => insertEmoji(name)}
                            >
                                <span>{EMOJI[name]}</span>
                                <span>:{name}:</span>
                            </button>
                        ))}
                    </div>
                )}
                {emojis && (
                    <EmojiPicker
                        trigger={emojiTrigger}
                        choose={chooseEmoji}
                        close={(restoreFocus) => {
                            setEmojis(false);
                            if (restoreFocus) input.current?.focus();
                        }}
                    />
                )}
            </div>
            {options && (
                <MessageMenu
                    {...options}
                    label="Message options"
                    close={() => {
                        setOptions(null);
                        optionsTrigger.current?.focus({ preventScroll: true });
                    }}
                    actions={[
                        {
                            label: 'Attach file (up to 256 MB)',
                            icon: 'attach',
                            disabled:
                                Boolean(voice) || (sending && Boolean(file)),
                            run: () => fileInput.current?.click(),
                        },
                        {
                            label: 'Add emoji',
                            icon: 'smile',
                            disabled: Boolean(voice) || Boolean(file),
                            run: () => setEmojis(true),
                        },
                        {
                            label: 'Record voice note',
                            icon: 'mic',
                            disabled: Boolean(voice) || Boolean(file),
                            run: () => void record(),
                        },
                        {
                            label: 'Formatting help',
                            icon: 'markdown',
                            run: () => setFormatting(true),
                        },
                        {
                            label: 'Shortcut help',
                            icon: 'keyboard',
                            run: () => setShortcuts(true),
                        },
                    ]}
                />
            )}
            <div className="composer-foot">
                <button
                    className="formatting-help-button"
                    onClick={() => setFormatting(true)}
                >
                    <Icon name="markdown" size={18} /> Formatting help
                </button>
                <button
                    className="formatting-help-button"
                    onClick={() => setShortcuts(true)}
                >
                    <Icon name="keyboard" size={18} /> Shortcut help
                </button>
            </div>
            {formatting && (
                <MarkdownHelp
                    close={() => {
                        setFormatting(false);
                        requestAnimationFrame(() => input.current?.focus());
                    }}
                />
            )}
            {shortcuts && (
                <ShortcutHelp
                    close={() => {
                        setShortcuts(false);
                        requestAnimationFrame(() => input.current?.focus());
                    }}
                />
            )}
        </div>
    );
}

function ModalView({
    modal,
    self,
    close,
}: {
    modal: NonNullable<Modal>;
    self: string;
    close: () => void;
}) {
    const [code, setCode] = useState('');
    const [verified, setVerified] = useState(false);
    const ref = useRef<HTMLDialogElement>(null);
    const dismiss = useMobilePanel(ref, close);
    useEffect(() => {
        ref.current?.showModal();
    }, []);
    useEffect(() => {
        if (modal.type === 'safety')
            void safetyCode(self, modal.peer.id).then(setCode);
    }, [modal, self]);
    return (
        <dialog
            ref={ref}
            className="modal"
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
                <IconButton
                    icon="close"
                    label="Close dialog"
                    onClick={dismiss}
                    className="modal-close"
                />
                <span className="modal-icon">
                    <Icon name="shield" size={29} />
                </span>
                {modal.type === 'privacy' ? (
                    <>
                        <h2>Privacy & encryption</h2>
                        <p>
                            Messages are encrypted in your browser before they
                            are sent. The server relays the encrypted copies and
                            keeps them in memory until it restarts.
                        </p>
                        <div className="privacy-row">
                            <Icon name="lock" />
                            <div>
                                <strong>Messages</strong>
                                <p>
                                    Signal protocol: each message has its own
                                    key and only its recipients can decrypt it.
                                    People who join later see new messages, plus
                                    any history someone shares with them.
                                </p>
                            </div>
                        </div>
                        <div className="privacy-row">
                            <Icon name="clock" />
                            <div>
                                <strong>Storage</strong>
                                <p>
                                    Nothing is written to disk on the server.
                                    Messages and files are gone when it
                                    restarts. Your browser keeps its encryption
                                    keys, so a refresh restores your messages.
                                </p>
                            </div>
                        </div>
                        <div className="privacy-row">
                            <Icon name="video" />
                            <div>
                                <strong>Calls</strong>
                                <p>
                                    Voice, video and screen sharing are
                                    encrypted with keys only the people in the
                                    call hold. The server forwards media it
                                    cannot decrypt. Calls are not recorded.
                                </p>
                            </div>
                        </div>
                        <div className="privacy-row">
                            <Icon name="globe" />
                            <div>
                                <strong>Image links</strong>
                                <p>
                                    The server fetches images from links, so the
                                    sites hosting them don’t see your IP
                                    address. The server does see those links.
                                </p>
                            </div>
                        </div>
                        <div className="privacy-note">
                            The server sees display names, statuses and
                            connection details, but not profile pictures or
                            status text. To be sure who you are talking to,
                            compare safety codes over another trusted channel.
                        </div>
                        <button className="primary" onClick={dismiss}>
                            OK
                        </button>
                    </>
                ) : (
                    <>
                        <h2>Safety code with {modal.peer.name}</h2>
                        <p>
                            Compare this code with {modal.peer.name} in person
                            or over another trusted channel. You should both see
                            the same code.
                        </p>
                        <div className="safety-code">
                            {code
                                ? code
                                      .split(' ')
                                      .map((group, i) => (
                                          <span key={i}>{group}</span>
                                      ))
                                : 'Calculating…'}
                        </div>
                        <p className="small-text">
                            The code changes if either of you clears this
                            browser’s encryption keys. A matching name alone
                            does not prove who someone is.
                        </p>
                        <button
                            className="primary"
                            disabled={!code}
                            onClick={() => {
                                const stored = verifiedIds();
                                stored[modal.peer.name.toLowerCase()] =
                                    modal.peer.id;
                                localStorage.setItem(
                                    'hush-verified',
                                    JSON.stringify(stored)
                                );
                                setVerified(true);
                            }}
                        >
                            {verified
                                ? 'Verified in this browser'
                                : 'Codes match'}
                            <Icon name="check" size={18} />
                        </button>
                    </>
                )}
            </div>
        </dialog>
    );
}

function App() {
    const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
    const mobile = useMobileLayout();
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [modal, setModal] = useState<Modal>(null);
    const [mobileNav, setMobileNav] = useState(false);
    const navigation = useRef<HTMLElement>(null);
    const dismissNavigation = useMobilePanel(
        navigation,
        () => setMobileNav(false),
        { open: mobileNav, direction: 'left' }
    );
    const [logoutOpen, setLogoutOpen] = useState(false);
    const [showMembers, setShowMembers] = useState(() => {
        try {
            return localStorage.getItem('hush-show-members') === 'true';
        } catch {
            return false;
        }
    });
    const [search, setSearch] = useState('');
    const [searchOpen, setSearchOpen] = useState(false);
    const [dismissedCall, setDismissedCall] = useState('');
    const [selectionMode, setSelectionMode] = useState(false);
    const [selected, setSelected] = useState<string[]>([]);
    const [editing, setEditing] = useState<string | null>(null);
    const [actionDialog, setActionDialog] = useState<ActionDialog | null>(null);
    // The message each conversation's next message replies to.
    const [replyTo, setReplyTo] = useState<Record<string, string>>({});
    const [reacting, setReacting] = useState<{
        id: string;
        anchor: HTMLElement;
    } | null>(null);
    const [pinsOpen, setPinsOpen] = useState(false);
    const pinTrigger = useRef<HTMLSpanElement>(null);
    const [profileCard, setProfileCard] = useState<{
        id: string;
        anchor: HTMLElement;
    } | null>(null);
    const [profileOpen, setProfileOpen] = useState(false);
    const [statusMenu, setStatusMenu] = useState<{
        x: number;
        y: number;
    } | null>(null);
    const statusTrigger = useRef<HTMLButtonElement>(null);
    // The people who can be mentioned here, stable while they stay the same.
    const mentionKey = state.peers
        .filter(
            (p) =>
                state.scope === 'room' ||
                p.id === state.self ||
                (state.self !== null &&
                    dmScope(state.self, p.id) === state.scope)
        )
        .map((p) => p.name)
        .join('\n');
    const mentionNames = useMemo(
        () => (mentionKey ? mentionKey.split('\n') : []),
        [mentionKey]
    );
    const [menu, setMenu] = useState<{
        id: string;
        x: number;
        y: number;
    } | null>(null);
    const menuOrigin = useRef<HTMLElement | null>(null);
    const selectionAnchor = useRef<string | null>(null);
    const deleting = useRef(new Set<string>());
    const scroll = useRef<HTMLDivElement>(null);
    const nearBottom = useRef(true);
    const [atLatest, setAtLatest] = useState(true);
    // The first message that arrived while this conversation was not open.
    const [newSince, setNewSince] = useState<{
        scope: string;
        id: string;
    } | null>(null);
    const shownScope = useRef('');
    const sentLast = useRef('');
    useChatViewport(
        mobile && (state.phase === 'online' || state.phase === 'reconnecting'),
        scroll,
        nearBottom
    );
    useEffect(() => {
        if (
            dismissedCall &&
            !state.peers.some((peer) => peer.call === dismissedCall)
        )
            setDismissedCall('');
    }, [dismissedCall, state.peers]);
    useEffect(() => {
        const removeSoundActivation = installSoundActivation();
        void client.resume();
        const clear = () => client.rtc?.stop();
        window.addEventListener('pagehide', clear);
        return () => {
            removeSoundActivation();
            window.removeEventListener('pagehide', clear);
        };
    }, []);
    // Any input here counts as activity; none for a while shows as idle.
    useEffect(() => {
        const active = () => client.active();
        const events = [
            'pointerdown',
            'pointermove',
            'keydown',
            'wheel',
            'focus',
        ] as const;
        for (const name of events)
            window.addEventListener(name, active, {
                capture: true,
                passive: true,
            });
        active();
        return () => {
            for (const name of events)
                window.removeEventListener(name, active, { capture: true });
        };
    }, []);
    useEffect(() => {
        nearBottom.current = true;
        setAtLatest(true);
        setPinsOpen(false);
        setReacting(null);
        setProfileCard(null);
        setSearch('');
        setSearchOpen(false);
        setSelected([]);
        setSelectionMode(false);
        setEditing(null);
        setMenu(null);
        setActionDialog(null);
        selectionAnchor.current = null;
    }, [state.scope]);
    useEffect(() => {
        const escape = (event: KeyboardEvent) => {
            if (
                event.key !== 'Escape' ||
                event.defaultPrevented ||
                (event.target as HTMLElement).closest('dialog')
            )
                return;
            if (mobileNav) {
                dismissNavigation();
                event.preventDefault();
            } else if (
                selectionMode &&
                !actionDialog &&
                !menu &&
                !editing &&
                !modal
            ) {
                setSelected([]);
                setSelectionMode(false);
                selectionAnchor.current = null;
                event.preventDefault();
            }
        };
        document.addEventListener('keydown', escape);
        return () => document.removeEventListener('keydown', escape);
    }, [
        mobileNav,
        selectionMode,
        actionDialog,
        menu,
        editing,
        modal,
        dismissNavigation,
    ]);
    useEffect(() => {
        setSelected((ids) => {
            const next = ids.filter((id) =>
                state.messages.some((m) => m.id === id)
            );
            return next.length === ids.length ? ids : next;
        });
    }, [state.messages]);
    // Images and previews change height after they load; stay at the end.
    const connected =
        state.phase === 'online' || state.phase === 'reconnecting';
    useEffect(() => {
        const el = scroll.current;
        const content = el?.querySelector('.messages');
        if (!el || !content) return;
        const observer = new ResizeObserver(() => {
            if (nearBottom.current) el.scrollTop = el.scrollHeight;
        });
        observer.observe(content);
        return () => observer.disconnect();
    }, [connected]);
    useEffect(() => {
        const el = scroll.current;
        if (!el) return;
        if (shownScope.current !== state.scope) {
            shownScope.current = state.scope;
            // Open at the first unread message when there is more to read
            // than fits on screen.
            const line = el.querySelector('.new-divider');
            if (line) {
                const top =
                    line.getBoundingClientRect().top -
                    el.getBoundingClientRect().top;
                if (top > el.clientHeight - 80) {
                    el.scrollTop += top - 48;
                    nearBottom.current = false;
                    setAtLatest(false);
                    return;
                }
            }
        }
        // Sending a message always brings the conversation back to the end.
        const last = state.messages.at(-1);
        if (
            last?.status === 'sending' &&
            last.from === state.self &&
            last.scope === state.scope &&
            last.id !== sentLast.current
        ) {
            sentLast.current = last.id;
            nearBottom.current = true;
            setAtLatest(true);
        }
        if (nearBottom.current) el.scrollTop = el.scrollHeight;
    }, [state.messages.length, state.presence.length, state.scope]);
    if (state.phase === 'loading')
        return (
            <div className="loading-screen">
                <span className="brand-icon">
                    <Icon name="wave" size={30} />
                </span>
                <span className="spinner" />
            </div>
        );
    if (state.phase === 'login' || state.phase === 'joining')
        return <Login state={state} />;
    const self = state.self!;
    const online = state.peers.filter((p) => p.online);
    const others = state.peers.filter((p) => p.id !== self);
    const ownStatus: Shown =
        state.phase !== 'online'
            ? 'offline'
            : state.status === 'online' && state.idle
              ? 'idle'
              : state.status;
    const shown = (peer: Peer | undefined) =>
        peer?.id === self ? ownStatus : shownStatus(peer, self);
    const avatarOf = (id: string) => state.profiles[id]?.avatar;
    // A status text, or how available someone is when that is not obvious.
    const statusLine = (peer: Peer) =>
        state.profiles[peer.id]?.text || statusLabels[shown(peer)];
    const visible = state.peers.filter((p) => shown(p) !== 'offline');
    const away = others.filter((p) => shown(p) === 'offline');
    const recipient =
        state.scope !== 'room'
            ? state.peers.find(
                  (p) => p.id !== self && dmScope(self, p.id) === state.scope
              )
            : undefined;
    const title = recipient?.name || 'general';
    const conversationMessages = state.messages.filter(
        (m) => m.scope === state.scope
    );
    const messages = conversationMessages.filter(
        (m) =>
            m.scope === state.scope &&
            (!search ||
                ((m.payload.kind === 'text' || m.payload.kind === 'file') &&
                    (m.payload.kind === 'text'
                        ? m.payload.text
                        : m.payload.name
                    )
                        .toLowerCase()
                        .includes(search.toLowerCase())))
    );
    const selectedMessages = messages.filter((m) => selected.includes(m.id));
    const canDelete =
        selectedMessages.length > 0 &&
        selectedMessages.every((m) => m.from === self && m.status === 'sent');
    const canShare =
        selectedMessages.length > 0 &&
        selectedMessages.every(
            (m) => m.scope === 'room' && m.status === 'sent'
        );
    const toggle = (id: string, range = false) => {
        const message = state.messages.find((m) => m.id === id);
        if (message?.status !== 'sent') return;
        const start = messages.findIndex(
            (m) => m.id === selectionAnchor.current
        );
        const end = messages.findIndex((m) => m.id === id);
        const rangeIds =
            range && start >= 0 && end >= 0
                ? messages
                      .slice(Math.min(start, end), Math.max(start, end) + 1)
                      .filter((m) => m.status === 'sent')
                      .map((m) => m.id)
                : [];
        const next = rangeIds.length
            ? [...new Set([...selected, ...rangeIds])]
            : selected.includes(id)
              ? selected.filter((value) => value !== id)
              : [...selected, id];
        if (next.length > MAX_BATCH) {
            client.notify('Select up to 100 messages at a time.');
            return;
        }
        setSelectionMode(true);
        setSelected(next);
        selectionAnchor.current = id;
    };
    const openMenu = (
        message: Message,
        x: number,
        y: number,
        source: HTMLElement
    ) => {
        menuOrigin.current = source;
        setMenu({ id: message.id, x, y });
    };
    const closeMenu = () => {
        setMenu(null);
        menuOrigin.current?.focus({ preventScroll: true });
    };
    const canManage = (message: Message) =>
        state.phase === 'online' &&
        message.scope === state.scope &&
        message.from === self &&
        message.status === 'sent';
    const editMessage = (message: Message) => {
        if (!canManage(message) || message.payload.kind !== 'text') return;
        setMenu(null);
        setEditing(message.id);
    };
    const deleteMessage = (message: Message, immediate = false) => {
        if (!canManage(message) || deleting.current.has(message.id)) return;
        setMenu(null);
        if (!immediate) {
            setActionDialog({ type: 'delete', ids: [message.id] });
            return;
        }
        deleting.current.add(message.id);
        void client
            .deleteMessages([message.id])
            .then(() => {
                setEditing((id) => (id === message.id ? null : id));
                client.notify('Message deleted.');
                if (
                    client.getSnapshot().scope === message.scope &&
                    document.activeElement === document.body
                )
                    document
                        .querySelector<HTMLElement>(
                            '.composer [role="textbox"]'
                        )
                        ?.focus({ preventScroll: true });
            })
            .catch((error: unknown) =>
                client.notify(
                    error instanceof Error
                        ? error.message
                        : 'Could not delete this message.'
                )
            )
            .finally(() => deleting.current.delete(message.id));
    };
    const byId = new Map(state.messages.map((m) => [m.id, m]));
    const nameOf = (id: string) =>
        state.peers.find((p) => p.id === id)?.name ?? 'Someone';
    const isPinned = (message: Message) =>
        state.pins[message.id]?.pinned === true &&
        state.pins[message.id]!.scope === message.scope;
    const pinnedMessages = conversationMessages
        .filter(isPinned)
        .sort((a, b) => state.pins[b.id]!.time - state.pins[a.id]!.time);
    const replyMessage = byId.get(replyTo[state.scope] ?? '');
    const focusComposer = () =>
        document
            .querySelector<HTMLElement>('.composer [role="textbox"]')
            ?.focus();
    // Bring a message into view and briefly highlight it.
    const jumpTo = (id: string) => {
        setPinsOpen(false);
        setSearch('');
        requestAnimationFrame(() => {
            const element = scroll.current?.querySelector<HTMLElement>(
                `[data-message-id="${CSS.escape(id)}"]`
            );
            if (!element) {
                client.notify('That message is no longer available.');
                return;
            }
            element.scrollIntoView({
                block: 'center',
                behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
                    ? 'auto'
                    : 'smooth',
            });
            element.focus({ preventScroll: true });
            element.classList.remove('flash');
            void element.offsetWidth;
            element.classList.add('flash');
            setTimeout(() => element.classList.remove('flash'), 1600);
        });
    };
    const startReply = (message: Message) => {
        setMenu(null);
        setReplyTo((values) => ({ ...values, [message.scope]: message.id }));
        requestAnimationFrame(focusComposer);
    };
    const togglePin = (message: Message) =>
        void client
            .pin(message.id, !isPinned(message))
            .catch((error: Error) => client.notify(error.message));
    const messageContext: MessageContext = {
        self,
        selfName: state.name,
        names: mentionNames,
        online: state.phase === 'online',
        nameOf,
        avatarOf,
        profile: (id, anchor) =>
            setProfileCard((open) =>
                open?.anchor === anchor ? null : { id, anchor }
            ),
        react: (message, anchor) => setReacting({ id: message.id, anchor }),
        reply: startReply,
        jump: jumpTo,
    };
    const statusActions: MenuAction[] = [
        ...(['online', 'dnd', 'invisible'] as const).map((status) => ({
            label: statusLabels[status],
            icon: 'status',
            className: `status-choice ${status}`,
            checked: state.status === status,
            hint:
                status === 'dnd'
                    ? 'Silences message and call sounds'
                    : status === 'invisible'
                      ? 'You appear offline but can still chat'
                      : undefined,
            run: () => client.setStatus(status),
        })),
        {
            label: 'Edit profile',
            icon: 'edit',
            run: () => setProfileOpen(true),
        },
    ];
    const cardPeer =
        profileCard && state.peers.find((p) => p.id === profileCard.id);
    const menuMessage = state.messages.find((m) => m.id === menu?.id);
    const menuReady =
        menuMessage?.status === 'sent' && state.phase === 'online';
    const menuActions: MenuAction[] = menuMessage
        ? [
              {
                  label: 'Reply',
                  icon: 'reply',
                  disabled: !menuReady,
                  run: () => startReply(menuMessage),
              },
              {
                  label: 'Add reaction',
                  icon: 'smile',
                  disabled: !menuReady,
                  run: () => {
                      const anchor =
                          scroll.current?.querySelector<HTMLElement>(
                              `[data-message-id="${CSS.escape(menuMessage.id)}"]`
                          ) ?? menuOrigin.current;
                      setMenu(null);
                      if (anchor) setReacting({ id: menuMessage.id, anchor });
                  },
              },
              {
                  label: isPinned(menuMessage)
                      ? 'Unpin message'
                      : 'Pin message',
                  icon: 'pin',
                  disabled: !menuReady,
                  run: () => {
                      setMenu(null);
                      togglePin(menuMessage);
                  },
              },
              ...(menuMessage.payload.kind === 'text'
                  ? [
                        {
                            label: 'Copy text',
                            icon: 'copy',
                            run: () => {
                                void navigator.clipboard
                                    .writeText(
                                        menuMessage.payload.kind === 'text'
                                            ? menuMessage.payload.text
                                            : ''
                                    )
                                    .then(() =>
                                        client.notify('Message copied.')
                                    )
                                    .catch(() =>
                                        client.notify(
                                            'Clipboard access is unavailable. Select the text to copy it.'
                                        )
                                    );
                            },
                        },
                    ]
                  : []),
              ...(menuMessage.from === self &&
              menuMessage.payload.kind === 'text'
                  ? [
                        {
                            label: 'Edit message',
                            icon: 'edit',
                            hint: 'Ctrl + right-click · Up Arrow from an empty message box edits your latest message',
                            disabled:
                                menuMessage.status !== 'sent' ||
                                state.phase !== 'online',
                            run: () => editMessage(menuMessage),
                        },
                    ]
                  : []),
              {
                  label: selected.includes(menuMessage.id)
                      ? 'Deselect message'
                      : 'Select message',
                  icon: 'check',
                  disabled: menuMessage.status !== 'sent',
                  run: () => toggle(menuMessage.id),
              },
              ...(menuMessage.scope === 'room'
                  ? [
                        {
                            label: 'Share message',
                            icon: 'share',
                            disabled:
                                menuMessage.status !== 'sent' ||
                                state.phase !== 'online',
                            run: () =>
                                setActionDialog({
                                    type: 'share',
                                    ids: [menuMessage.id],
                                }),
                        },
                    ]
                  : []),
              ...(menuMessage.from === self
                  ? [
                        {
                            label: 'Delete message',
                            icon: 'trash',
                            hint: 'Ctrl + click · Add Shift to skip confirmation',
                            danger: true,
                            disabled:
                                menuMessage.status !== 'sent' ||
                                state.phase !== 'online',
                            run: () => deleteMessage(menuMessage),
                        },
                    ]
                  : []),
          ]
        : [];
    const timeline = [
        ...messages.map((message) => ({
            type: 'message' as const,
            id: message.id,
            time: message.time,
            message,
        })),
        ...(state.scope === 'room' && !search
            ? state.presence.map((event) => ({
                  type: 'presence' as const,
                  id: event.id,
                  time: event.time,
                  event,
              }))
            : []),
    ].sort((a, b) => a.time - b.time);
    const roomCall = online.filter((p) => p.call === 'room');
    const incoming = others.find(
        (p) =>
            p.online &&
            p.call === dmScope(self, p.id) &&
            p.call !== state.call?.scope &&
            p.call !== dismissedCall
    );
    const dmPeers = others.filter(
        (p) =>
            shown(p) !== 'offline' ||
            dmScope(self, p.id) === state.scope ||
            state.messages.some((m) => m.scope === dmScope(self, p.id))
    );
    const select = (scope: string) => {
        const count = state.unread[scope] || 0;
        const unseen = state.messages.filter(
            (m) => m.scope === scope && m.from !== self
        );
        const first = count ? unseen[Math.max(0, unseen.length - count)] : null;
        setNewSince(first ? { scope, id: first.id } : null);
        client.select(scope);
        setMobileNav(false);
    };
    const verified = verifiedIds();
    return (
        <main className="app-shell">
            {mobileNav && (
                <button
                    className="nav-backdrop"
                    aria-label="Close navigation"
                    onClick={dismissNavigation}
                />
            )}
            <aside
                ref={navigation}
                className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}
            >
                <div className="space-heading">
                    <div>
                        <h1>Hush</h1>
                        <span>
                            <i className="online-dot" /> {visible.length} online
                        </span>
                    </div>
                    <IconButton
                        icon="copy"
                        label="Copy invite link"
                        onClick={() => {
                            const link =
                                state.config?.origin || location.origin;
                            void navigator.clipboard
                                .writeText(link)
                                .then(() =>
                                    client.notify(
                                        'Link copied. Share the password separately.'
                                    )
                                )
                                .catch(() => client.notify(link));
                        }}
                    />
                </div>
                <div className="sidebar-content">
                    <div className="section-caption">Channels</div>
                    <button
                        className={`channel-row ${state.scope === 'room' ? 'selected' : ''}`}
                        onClick={() => select('room')}
                    >
                        <Icon name="hash" />
                        <span>general</span>
                        {Boolean(state.unread.room) && (
                            <b className="unread-badge">{state.unread.room}</b>
                        )}
                    </button>
                    <button
                        className={`channel-row voice-channel ${state.call?.scope === 'room' ? 'in-voice' : ''}`}
                        onClick={() => {
                            select('room');
                            if (state.call?.scope !== 'room')
                                void client.joinCall('room');
                        }}
                        disabled={state.phase !== 'online'}
                    >
                        <Icon name="volume" />
                        <span>voice</span>
                        {roomCall.length > 0 && (
                            <span className="voice-count">
                                {roomCall.length}
                            </span>
                        )}
                    </button>
                    {roomCall.length > 0 && (
                        <div className="lounge-people">
                            {roomCall.map((p) => (
                                <span key={p.id}>
                                    <Avatar
                                        name={p.name}
                                        id={p.id}
                                        image={avatarOf(p.id)}
                                        size="tiny"
                                    />
                                    {p.name}
                                </span>
                            ))}
                        </div>
                    )}
                    <div className="section-caption dm-caption">
                        Direct messages
                    </div>
                    {dmPeers.length ? (
                        dmPeers.map((p) => {
                            const scope = dmScope(self, p.id);
                            return (
                                <button
                                    className={`dm-row ${scope === state.scope ? 'selected' : ''}`}
                                    key={p.id}
                                    onClick={() => select(scope)}
                                >
                                    <Avatar
                                        id={p.id}
                                        name={p.name}
                                        image={avatarOf(p.id)}
                                        status={shown(p)}
                                    />
                                    <span>
                                        {p.name}
                                        <small>
                                            {p.call === scope
                                                ? 'In a call'
                                                : statusLine(p)}
                                        </small>
                                    </span>
                                    {Boolean(state.unread[scope]) && (
                                        <b className="unread-badge">
                                            {state.unread[scope]}
                                        </b>
                                    )}
                                </button>
                            );
                        })
                    ) : (
                        <p className="sidebar-empty">No one else yet.</p>
                    )}
                </div>
                {state.call && (
                    <div className="sidebar-call">
                        <Icon name="volume" size={17} />
                        <div>
                            <strong>Voice connected</strong>
                            <small>
                                {state.call.scope === 'room'
                                    ? 'voice'
                                    : state.peers.find(
                                          (p) =>
                                              p.id !== self &&
                                              state.call!.scope ===
                                                  dmScope(self, p.id)
                                      )?.name || 'Private call'}
                            </small>
                        </div>
                        <IconButton
                            icon="hangup"
                            label="Leave call"
                            onClick={() => client.leaveCall()}
                        />
                    </div>
                )}
                <div className="self-row">
                    <button
                        ref={statusTrigger}
                        className="self-status"
                        aria-label={`Status: ${statusLabels[ownStatus]}. Change status or profile`}
                        aria-haspopup="menu"
                        aria-expanded={Boolean(statusMenu)}
                        onClick={(event) => {
                            const box =
                                event.currentTarget.getBoundingClientRect();
                            setStatusMenu((open) =>
                                open ? null : { x: box.left, y: box.top }
                            );
                        }}
                    >
                        <Avatar
                            name={state.name}
                            id={self}
                            image={avatarOf(self)}
                            status={ownStatus}
                        />
                        <span>
                            <strong>{state.name}</strong>
                            <small>
                                {state.phase !== 'online'
                                    ? 'Reconnecting…'
                                    : state.profiles[self]?.text ||
                                      statusLabels[ownStatus]}
                            </small>
                        </span>
                    </button>
                    <IconButton
                        icon="logout"
                        label="Log out"
                        onClick={() => setLogoutOpen(true)}
                    />
                </div>
            </aside>
            <section className="conversation">
                <header className="conversation-header">
                    <IconButton
                        icon="menu"
                        label="Open navigation"
                        className="mobile-menu"
                        onClick={() => setMobileNav(true)}
                    />
                    <span className="header-channel-icon">
                        <Icon name={recipient ? 'at' : 'hash'} size={25} />
                    </span>
                    <div className="conversation-title">
                        <h2>{title}</h2>
                        {recipient &&
                            (state.profiles[recipient.id]?.text ||
                                shown(recipient) !== 'online') && (
                                <span>{statusLine(recipient)}</span>
                            )}
                    </div>
                    <div className="header-actions">
                        <IconButton
                            icon="phone"
                            label="Start voice call"
                            disabled={
                                state.phase !== 'online' ||
                                Boolean(
                                    recipient && shown(recipient) === 'offline'
                                )
                            }
                            onClick={() => void client.joinCall(state.scope)}
                        />
                        {!mobile && (
                            <>
                                <IconButton
                                    icon="video"
                                    label="Start video call"
                                    disabled={
                                        state.phase !== 'online' ||
                                        Boolean(
                                            recipient &&
                                            shown(recipient) === 'offline'
                                        )
                                    }
                                    onClick={() =>
                                        void client.joinCall(state.scope, true)
                                    }
                                />
                                <IconButton
                                    icon="search"
                                    label="Search this conversation"
                                    active={searchOpen}
                                    onClick={() => {
                                        setSearchOpen(!searchOpen);
                                        if (searchOpen) setSearch('');
                                    }}
                                />
                            </>
                        )}
                        {pinnedMessages.length > 0 && (
                            <span className="pinned-trigger" ref={pinTrigger}>
                                <IconButton
                                    icon="pin"
                                    label="Pinned messages"
                                    active={pinsOpen}
                                    onClick={() => setPinsOpen(!pinsOpen)}
                                />
                                <b className="pinned-count" aria-hidden="true">
                                    {pinnedMessages.length}
                                </b>
                                {pinsOpen && (
                                    <PinnedPanel
                                        messages={pinnedMessages}
                                        trigger={pinTrigger}
                                        jump={jumpTo}
                                        unpin={(id) => {
                                            const message = byId.get(id);
                                            if (message) togglePin(message);
                                        }}
                                        close={(restoreFocus) => {
                                            setPinsOpen(false);
                                            if (restoreFocus)
                                                pinTrigger.current
                                                    ?.querySelector('button')
                                                    ?.focus();
                                        }}
                                    />
                                )}
                            </span>
                        )}
                        <ConversationActions
                            client={client}
                            scope={state.scope}
                            title={title}
                            online={state.phase === 'online'}
                            actions={
                                mobile
                                    ? [
                                          {
                                              label: 'Start video call',
                                              icon: 'video',
                                              disabled:
                                                  state.phase !== 'online' ||
                                                  Boolean(
                                                      recipient &&
                                                      shown(recipient) ===
                                                          'offline'
                                                  ),
                                              run: () =>
                                                  void client.joinCall(
                                                      state.scope,
                                                      true
                                                  ),
                                          },
                                          {
                                              label: searchOpen
                                                  ? 'Close search'
                                                  : 'Search this conversation',
                                              icon: 'search',
                                              run: () => {
                                                  setSearchOpen(!searchOpen);
                                                  if (searchOpen) setSearch('');
                                              },
                                          },
                                          {
                                              label: 'Settings',
                                              icon: 'settings',
                                              run: () => setSettingsOpen(true),
                                          },
                                      ]
                                    : []
                            }
                            share={
                                state.scope === 'room' && messages.length > 0
                                    ? () => {
                                          setSelectionMode(true);
                                          client.notify(
                                              'Select room messages, then choose Share selected.'
                                          );
                                      }
                                    : undefined
                            }
                        />
                        <AppearanceControls
                            open={settingsOpen}
                            onOpenChange={setSettingsOpen}
                            hideControls={mobile}
                            call={state.call}
                            onScreenAudio={(enabled) =>
                                void client.rtc?.setScreenAudio(enabled)
                            }
                            onPrivacy={() => setModal({ type: 'privacy' })}
                            onVerify={
                                recipient
                                    ? () =>
                                          setModal({
                                              type: 'safety',
                                              peer: recipient,
                                          })
                                    : undefined
                            }
                        />
                        <IconButton
                            icon="people"
                            label="Toggle people list"
                            active={showMembers}
                            onClick={() => {
                                const next = !showMembers;
                                setShowMembers(next);
                                try {
                                    localStorage.setItem(
                                        'hush-show-members',
                                        String(next)
                                    );
                                } catch {}
                            }}
                        />
                    </div>
                </header>
                {state.phase === 'reconnecting' && (
                    <div className="connection-banner" role="status">
                        <span className="spinner" /> Reconnecting…
                    </div>
                )}
                {incoming && (
                    <div className="incoming-call">
                        <Icon name="phone" size={18} />
                        <span>
                            <strong>{incoming.name}</strong> is calling you
                        </span>
                        <button
                            className="small-primary"
                            onClick={() => {
                                select(incoming.call!);
                                void client.joinCall(incoming.call!);
                            }}
                        >
                            Join call
                        </button>
                        <IconButton
                            icon="close"
                            label="Dismiss call"
                            onClick={() => setDismissedCall(incoming.call!)}
                        />
                    </div>
                )}
                {state.call && (
                    <CallPanel
                        call={state.call}
                        state={state}
                        client={client}
                    />
                )}
                {searchOpen && (
                    <div className="search-bar">
                        <Icon name="search" size={17} />
                        <input
                            aria-label="Search messages"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Escape') {
                                    event.preventDefault();
                                    setSearchOpen(false);
                                    setSearch('');
                                    document
                                        .querySelector<HTMLElement>(
                                            '.composer [role="textbox"]'
                                        )
                                        ?.focus();
                                }
                            }}
                            placeholder="Search this conversation"
                            autoFocus
                        />
                        <span>{search && `${messages.length} found`}</span>
                        <IconButton
                            icon="close"
                            label="Close search"
                            onClick={() => {
                                setSearchOpen(false);
                                setSearch('');
                            }}
                        />
                    </div>
                )}
                <div
                    className="message-scroll"
                    ref={scroll}
                    onScroll={() => {
                        const el = scroll.current;
                        if (!el) return;
                        nearBottom.current =
                            el.scrollHeight - el.scrollTop - el.clientHeight <
                            100;
                        setAtLatest(nearBottom.current);
                    }}
                >
                    <div
                        className="messages"
                        role="log"
                        aria-label="Conversation messages"
                        aria-live="polite"
                    >
                        {timeline.map((item, index) => {
                            const previous = timeline[index - 1];
                            const newDay =
                                !previous ||
                                new Date(previous.time).toDateString() !==
                                    new Date(item.time).toDateString();
                            const firstNew =
                                !search &&
                                newSince?.scope === state.scope &&
                                newSince.id === item.id;
                            return (
                                <React.Fragment key={item.id}>
                                    {newDay && (
                                        <div className="date-divider">
                                            <span>{dayLabel(item.time)}</span>
                                        </div>
                                    )}
                                    {firstNew && (
                                        <div className="new-divider">
                                            <span>New</span>
                                        </div>
                                    )}
                                    {item.type === 'message' ? (
                                        <ChatMessage
                                            message={item.message}
                                            context={messageContext}
                                            reactions={state.reactions[item.id]}
                                            pinned={isPinned(item.message)}
                                            parent={
                                                item.message.payload.kind ===
                                                    'text' &&
                                                item.message.payload.reply
                                                    ? byId.get(
                                                          item.message.payload
                                                              .reply
                                                      )
                                                    : undefined
                                            }
                                            mentioned={
                                                item.message.from !== self &&
                                                item.message.payload.kind ===
                                                    'text' &&
                                                (mentions(
                                                    item.message.payload.text,
                                                    state.name
                                                ) ||
                                                    byId.get(
                                                        item.message.payload
                                                            .reply ?? ''
                                                    )?.from === self)
                                            }
                                            continued={
                                                !newDay &&
                                                !firstNew &&
                                                !(
                                                    item.message.payload
                                                        .kind === 'text' &&
                                                    item.message.payload.reply
                                                ) &&
                                                previous.type === 'message' &&
                                                previous.message.from ===
                                                    item.message.from &&
                                                previous.message.sharedBy ===
                                                    item.message.sharedBy &&
                                                item.time - previous.time <
                                                    GROUP_MS
                                            }
                                            selected={selected.includes(
                                                item.id
                                            )}
                                            selectionMode={selectionMode}
                                            toggle={toggle}
                                            menu={openMenu}
                                            edit={editMessage}
                                            remove={deleteMessage}
                                            editing={editing === item.id}
                                            closeEditor={() => {
                                                setEditing(null);
                                                document
                                                    .querySelector<HTMLElement>(
                                                        '.composer [role="textbox"]'
                                                    )
                                                    ?.focus();
                                            }}
                                        />
                                    ) : (
                                        <div
                                            className={`presence-event ${item.event.action}`}
                                        >
                                            <Icon
                                                name={
                                                    item.event.action ===
                                                    'joined'
                                                        ? 'arrow'
                                                        : item.event.action ===
                                                            'renamed'
                                                          ? 'edit'
                                                          : 'logout'
                                                }
                                                size={15}
                                            />
                                            {item.event.action === 'renamed' ? (
                                                <span>
                                                    <strong>
                                                        {item.event.previous}
                                                    </strong>{' '}
                                                    is now{' '}
                                                    <strong>
                                                        {item.event.name}
                                                    </strong>
                                                </span>
                                            ) : (
                                                <span>
                                                    <strong>
                                                        {item.event.name}
                                                    </strong>{' '}
                                                    {item.event.action}
                                                </span>
                                            )}
                                            <time
                                                dateTime={new Date(
                                                    item.time
                                                ).toISOString()}
                                            >
                                                {clock(item.time)}
                                            </time>
                                        </div>
                                    )}
                                </React.Fragment>
                            );
                        })}
                    </div>
                    {messages.length === 0 && search && (
                        <div className="empty-conversation">
                            <Icon name="search" size={28} />
                            <p>No results.</p>
                        </div>
                    )}
                </div>
                {!atLatest && (
                    <div className="jump-latest-anchor">
                        <button
                            className="jump-latest"
                            onClick={() => {
                                const el = scroll.current;
                                el?.scrollTo({
                                    top: el.scrollHeight,
                                    behavior: matchMedia(
                                        '(prefers-reduced-motion: reduce)'
                                    ).matches
                                        ? 'auto'
                                        : 'smooth',
                                });
                            }}
                        >
                            <Icon name="arrowDown" size={15} />
                            Jump to latest
                        </button>
                    </div>
                )}
                {selectionMode && (
                    <div
                        className="selection-bar"
                        role="region"
                        aria-label="Selected messages"
                    >
                        <strong>
                            {selectedMessages.length
                                ? `${selectedMessages.length} selected`
                                : 'Select messages'}
                        </strong>
                        <button
                            className="subtle-button"
                            onClick={() =>
                                setSelected(
                                    messages
                                        .filter((m) => m.status === 'sent')
                                        .slice(0, MAX_BATCH)
                                        .map((m) => m.id)
                                )
                            }
                        >
                            Select all
                            {messages.length > MAX_BATCH ? ' (first 100)' : ''}
                        </button>
                        <button
                            className="subtle-button"
                            onClick={() =>
                                setSelected(
                                    messages
                                        .filter(
                                            (m) =>
                                                m.from === self &&
                                                m.status === 'sent'
                                        )
                                        .slice(0, MAX_BATCH)
                                        .map((m) => m.id)
                                )
                            }
                        >
                            Select mine
                        </button>
                        {state.scope === 'room' && (
                            <button
                                className="small-primary"
                                disabled={!canShare || state.phase !== 'online'}
                                onClick={() =>
                                    setActionDialog({
                                        type: 'share',
                                        ids: selectedMessages.map((m) => m.id),
                                    })
                                }
                            >
                                <Icon name="share" size={16} />
                                Share selected
                            </button>
                        )}
                        <button
                            className="destructive-button"
                            disabled={!canDelete || state.phase !== 'online'}
                            title={
                                canDelete
                                    ? 'Delete your selected messages'
                                    : 'Only your own messages can be deleted'
                            }
                            onClick={() =>
                                setActionDialog({
                                    type: 'delete',
                                    ids: selectedMessages.map((m) => m.id),
                                })
                            }
                        >
                            <Icon name="trash" size={16} />
                            Delete selected
                        </button>
                        <IconButton
                            icon="close"
                            label="Cancel selection"
                            onClick={() => {
                                setSelected([]);
                                setSelectionMode(false);
                                selectionAnchor.current = null;
                            }}
                        />
                    </div>
                )}
                <Composer
                    state={state}
                    recipient={recipient}
                    mentionNames={mentionNames}
                    reply={replyMessage}
                    cancelReply={() =>
                        setReplyTo((values) => {
                            const next = { ...values };
                            delete next[state.scope];
                            return next;
                        })
                    }
                    editLast={() => {
                        const latest = [...messages]
                            .reverse()
                            .find(
                                (m) =>
                                    m.from === self &&
                                    m.payload.kind === 'text' &&
                                    m.status === 'sent'
                            );
                        if (latest) editMessage(latest);
                    }}
                />
            </section>
            {showMembers && (
                <aside className="members-panel">
                    <div className="members-header">
                        <Icon name="people" size={17} />
                        <h2>Members</h2>
                        <span>{visible.length}</span>
                    </div>
                    {[
                        ['Online', visible],
                        ['Offline', away],
                    ].map(
                        ([caption, people]) =>
                            people.length > 0 && (
                                <React.Fragment key={caption as string}>
                                    <div className="section-caption">
                                        {caption as string} — {people.length}
                                    </div>
                                    {(people as Peer[]).map((p) => (
                                        <div
                                            className={`member-item ${shown(p) === 'offline' ? 'away' : ''}`}
                                            key={p.id}
                                        >
                                            <button
                                                className="member-main"
                                                aria-haspopup="dialog"
                                                onClick={(event) =>
                                                    setProfileCard({
                                                        id: p.id,
                                                        anchor: event.currentTarget,
                                                    })
                                                }
                                            >
                                                <Avatar
                                                    name={p.name}
                                                    id={p.id}
                                                    image={avatarOf(p.id)}
                                                    status={shown(p)}
                                                />
                                                <span>
                                                    <strong>
                                                        {p.name}
                                                        {p.id === self && (
                                                            <small>you</small>
                                                        )}
                                                    </strong>
                                                    <small>
                                                        {p.call &&
                                                        shown(p) !== 'offline'
                                                            ? 'In a call'
                                                            : statusLine(p)}
                                                    </small>
                                                </span>
                                            </button>
                                            {p.id !== self && p.online && (
                                                <ParticipantVolume
                                                    id={p.id}
                                                    name={p.name}
                                                />
                                            )}
                                            {p.id !== self && (
                                                <IconButton
                                                    icon="shield"
                                                    label={`Verify ${p.name}`}
                                                    active={
                                                        verification(
                                                            verified,
                                                            p
                                                        ) === 'verified'
                                                    }
                                                    onClick={() =>
                                                        setModal({
                                                            type: 'safety',
                                                            peer: p,
                                                        })
                                                    }
                                                />
                                            )}
                                            {p.id !== self &&
                                                verification(verified, p) ===
                                                    'changed' && (
                                                    <span className="key-changed">
                                                        Encryption key changed —
                                                        verify again
                                                    </span>
                                                )}
                                        </div>
                                    ))}
                                </React.Fragment>
                            )
                    )}
                </aside>
            )}
            {modal && (
                <ModalView
                    modal={modal}
                    self={self}
                    close={() => setModal(null)}
                />
            )}
            {menu && menuMessage && (
                <MessageMenu
                    x={menu.x}
                    y={menu.y}
                    actions={menuActions}
                    close={closeMenu}
                />
            )}
            {statusMenu && (
                <MessageMenu
                    x={statusMenu.x}
                    y={statusMenu.y}
                    above
                    label="Status"
                    actions={statusActions}
                    close={() => {
                        setStatusMenu(null);
                        statusTrigger.current?.focus({ preventScroll: true });
                    }}
                />
            )}
            {profileCard && cardPeer && (
                <ProfileCard
                    peer={cardPeer}
                    profile={state.profiles[cardPeer.id]}
                    status={shown(cardPeer)}
                    self={cardPeer.id === self}
                    verification={
                        cardPeer.id === self
                            ? null
                            : verification(verifiedIds(), cardPeer)
                    }
                    anchor={profileCard.anchor}
                    message={
                        cardPeer.id === self
                            ? undefined
                            : () => {
                                  setProfileCard(null);
                                  select(dmScope(self, cardPeer.id));
                              }
                    }
                    edit={
                        cardPeer.id === self
                            ? () => {
                                  setProfileCard(null);
                                  setProfileOpen(true);
                              }
                            : undefined
                    }
                    close={(restoreFocus) => {
                        setProfileCard(null);
                        if (restoreFocus)
                            profileCard.anchor.focus({ preventScroll: true });
                    }}
                />
            )}
            {profileOpen && (
                <ProfileDialog
                    id={self}
                    name={state.name}
                    profile={storedProfile()}
                    client={client}
                    close={() => setProfileOpen(false)}
                />
            )}
            {reacting && (
                <ReactionPicker
                    anchor={reacting.anchor}
                    choose={(emoji) => {
                        void client
                            .react(reacting.id, emoji)
                            .catch((error: Error) =>
                                client.notify(error.message)
                            );
                        setReacting(null);
                        reacting.anchor.focus({ preventScroll: true });
                    }}
                    close={(restoreFocus) => {
                        setReacting(null);
                        if (restoreFocus)
                            reacting.anchor.focus({ preventScroll: true });
                    }}
                />
            )}
            {actionDialog && (
                <MessageActionDialog
                    action={actionDialog}
                    state={state}
                    client={client}
                    close={() => setActionDialog(null)}
                    done={() => {
                        setActionDialog(null);
                        setSelected([]);
                        setSelectionMode(false);
                        if (actionDialog.type === 'delete') {
                            setEditing((id) =>
                                id && actionDialog.ids.includes(id) ? null : id
                            );
                            document
                                .querySelector<HTMLElement>(
                                    '.composer [role="textbox"]'
                                )
                                ?.focus({ preventScroll: true });
                        }
                    }}
                />
            )}
            {logoutOpen && (
                <LogoutDialog
                    inCall={Boolean(state.call)}
                    close={() => setLogoutOpen(false)}
                    confirm={async () => {
                        await client.logout();
                        setLogoutOpen(false);
                    }}
                />
            )}
            {state.notice && (
                <div className="toast" role="status">
                    <Icon name="info" size={18} />
                    <span>{state.notice}</span>
                    <IconButton
                        icon="close"
                        label="Dismiss notification"
                        onClick={() => client.update({ notice: '' })}
                    />
                </div>
            )}
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<App />);
