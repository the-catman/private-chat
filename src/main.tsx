import React, {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    useSyncExternalStore,
} from 'react';
import { createRoot } from 'react-dom/client';
import { ChatClient } from './lib/client';
import { b64, unb64, dmScope, safetyCode } from './lib/crypto';
import { Icon } from './Icon';
import type { Peer, ChatState, Content, Message } from './types';
import { Avatar, IconButton, color, minutes } from './components/Common';
import { CallPanel } from './components/CallPanel';
import { AppearanceControls } from './components/Appearance';
import { EmojiPicker } from './components/EmojiPicker';
import { LogoutDialog } from './components/LogoutDialog';
import { MarkdownMessage, MarkdownHelp } from './components/MarkdownMessage';
import { ParticipantVolume } from './components/ParticipantVolume';
import { ConversationActions } from './components/ConversationActions';
import {
    FileAttachment,
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
                <a className="wordmark" href="/" aria-label="Hush home">
                    <span className="brand-icon">
                        <Icon name="wave" size={24} />
                    </span>
                    hush<span className="wordmark-dot">.</span>
                </a>
                <span className="quiet-label">
                    <Icon name="lock" size={14} /> A private place to connect
                </span>
                <AppearanceControls />
            </div>
            <div className="login-layout">
                <section className="login-story">
                    <div className="eyebrow">
                        <span className="pulse-dot" /> SMALL CIRCLE. GOOD
                        COMPANY.
                    </div>
                    <h1>
                        A little space.
                        <br />
                        <em>Just your people.</em>
                    </h1>
                    <p>
                        Drop a thought. Share your screen. Stay on a call a
                        little longer. Make yourself at home.
                    </p>
                    <div className="orbit-art" aria-hidden="true">
                        <div className="orbit-ring one" />
                        <div className="orbit-ring two" />
                        <div className="orbit-center">
                            <Icon name="wave" size={62} />
                        </div>
                        <div className="orbit-bubble bubble-one">
                            <Icon name="video" size={28} />
                        </div>
                        <div className="orbit-bubble bubble-two">
                            <Icon name="mic" size={25} />
                        </div>
                        <div className="orbit-bubble bubble-three">
                            <Icon name="shield" size={24} />
                        </div>
                        <span className="orbit-caption">
                            <i /> always between us
                        </span>
                    </div>
                    <div className="login-promises">
                        <span>
                            <Icon name="shield" size={16} /> End-to-end
                            encrypted
                        </span>
                        <span>
                            <Icon name="clock" size={16} /> No message files.
                            Ever.
                        </span>
                    </div>
                </section>
                <section className="login-card">
                    <div className="login-card-icon">
                        <Icon name="wave" size={27} />
                    </div>
                    <h2>Come on in.</h2>
                    <p>Your people are one hello away.</p>
                    <form
                        onSubmit={(event) => {
                            event.preventDefault();
                            void client.login(name, password);
                            setPassword('');
                        }}
                    >
                        <label htmlFor="display-name">
                            What should we call you?
                        </label>
                        <input
                            id="display-name"
                            name="name"
                            autoComplete="nickname"
                            placeholder="Your display name"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            minLength={1}
                            maxLength={32}
                            required
                            disabled={joining}
                            autoFocus
                        />
                        <label htmlFor="room-password">
                            Room password <Icon name="lock" size={13} />
                        </label>
                        <input
                            id="room-password"
                            name="password"
                            type="password"
                            autoComplete="current-password"
                            placeholder="The one shared with your circle"
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
                                    <span className="spinner" /> Finding your
                                    people…
                                </>
                            ) : (
                                <>
                                    Enter your space{' '}
                                    <Icon name="arrow" size={19} />
                                </>
                            )}
                        </button>
                    </form>
                    <div className="login-footnote">
                        <Icon name="shield" size={18} />
                        <span>
                            Your browser handles encryption.
                            <br />
                            Your conversations stay between you.
                        </span>
                    </div>
                </section>
            </div>
            <footer className="login-bottom">
                <span>Less noise. More connection.</span>
                <span>
                    Built for a small circle{' '}
                    <span className="tiny-star">✳</span>
                </span>
            </footer>
        </main>
    );
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

function ChatMessage({
    message,
    self,
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
    self: string;
    selectionMode: boolean;
    selected: boolean;
    toggle: (id: string, range?: boolean) => void;
    menu: (message: Message, x: number, y: number, source: HTMLElement) => void;
    edit: (message: Message) => void;
    remove: (message: Message, immediate?: boolean) => void;
    editing: boolean;
    closeEditor: () => void;
}) {
    const mine = message.from === self;
    return (
        <article
            className={`message ${mine ? 'mine' : ''} ${selected ? 'is-selected' : ''}`}
            data-testid="chat-message"
            data-message-id={message.id}
            tabIndex={0}
            onContextMenu={(event) => {
                if (editing) return;
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
            <Avatar id={message.from} name={message.name} />
            <div className="message-main">
                <div className="message-meta">
                    <strong
                        className="author-name"
                        style={
                            {
                                '--name-color': color(message.from),
                            } as React.CSSProperties
                        }
                    >
                        {message.name}
                    </strong>
                    {mine && <span className="you-label">you</span>}
                    <time dateTime={new Date(message.time).toISOString()}>
                        {new Date(message.time).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                        })}
                    </time>
                    {mine && (
                        <span
                            className="message-delivery"
                            title={
                                message.status === 'sent'
                                    ? 'Received by the server, encrypted'
                                    : 'Waiting for confirmation'
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
                </div>
                {message.edited && <span className="message-note">edited</span>}
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
                ) : message.payload.kind === 'voice' ? (
                    <VoiceNote content={message.payload} />
                ) : message.payload.kind === 'file' ? (
                    <FileAttachment content={message.payload} />
                ) : (
                    <MarkdownMessage text={message.payload.text} />
                )}
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
            )}
        </article>
    );
}

function Composer({
    state,
    recipient,
    editLast,
}: {
    state: ChatState;
    recipient?: Peer;
    editLast: () => void;
}) {
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [emojis, setEmojis] = useState(false);
    const [formatting, setFormatting] = useState(false);
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
    const input = useRef<HTMLTextAreaElement>(null);
    useLayoutEffect(() => {
        // File and voice previews disable the editor until React removes them.
        // Text sends keep focus throughout and need no completion-time refocus.
        if (completedSend?.scope === currentScope.current)
            input.current?.focus({ preventScroll: true });
    }, [completedSend]);
    const suggestions =
        !emojiDismissed && !emojis && !file && !voice
            ? emojiQuery(text, cursor)
            : null;
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
            client.notify('Files can be up to 5 MB. Choose a smaller file.');
            return;
        }
        setFile(picked);
        setEmojis(false);
    };
    const offline =
        state.phase !== 'online' ||
        (state.scope !== 'room' && !recipient?.online);
    useEffect(() => {
        if (!suggestions) return;
        const dismiss = (event: PointerEvent) => {
            if (
                !suggestionPanel.current?.contains(event.target as Node) &&
                event.target !== input.current
            )
                setEmojiDismissed(true);
        };
        document.addEventListener('pointerdown', dismiss);
        return () => document.removeEventListener('pointerdown', dismiss);
    }, [Boolean(suggestions)]);
    useEffect(() => {
        if (offline || recording) setEmojis(false);
    }, [offline, recording]);
    useLayoutEffect(() => {
        const element = input.current;
        if (!element) return;
        element.style.height = 'auto';
        element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
    }, [text, state.scope, recording, file, voice]);
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
        if (isText) {
            // Keep the editor live while encryption runs. Completion must not
            // clear anything the user has already typed for their next message.
            setDrafts((values) => ({ ...values, [scope]: '' }));
            setCursor(0);
            input.current?.focus({ preventScroll: true });
        }
        try {
            const payload: Content = file
                ? {
                      kind: 'file',
                      data: b64(await file.arrayBuffer()),
                      name: file.name.slice(0, 255) || 'attachment',
                      mime: file.type.slice(0, 128),
                      size: file.size,
                  }
                : voice || { kind: 'text', text: replaceEmoji(text.trim()) };
            await client.send(payload, scope);
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
                        <textarea
                            ref={input}
                            aria-autocomplete="list"
                            aria-controls={
                                suggestions ? 'emoji-suggestions' : undefined
                            }
                            aria-activedescendant={
                                suggestions
                                    ? `emoji-option-${Math.min(emojiIndex, suggestions.results.length - 1)}`
                                    : undefined
                            }
                            aria-label={
                                recipient
                                    ? `Message ${recipient.name}`
                                    : 'Message the living room'
                            }
                            placeholder={
                                offline
                                    ? 'Waiting for a connection…'
                                    : file
                                      ? 'Your file is ready to send'
                                      : voice
                                        ? 'Your voice note is ready to send'
                                        : recipient
                                          ? `Message ${recipient.name}`
                                          : 'Message the living room'
                            }
                            value={text}
                            onChange={(event) => {
                                setDrafts((values) => ({
                                    ...values,
                                    [state.scope]: event.target.value,
                                }));
                                setCursor(event.target.selectionStart);
                                setEmojiIndex(0);
                                setEmojiDismissed(false);
                                void client.typing();
                            }}
                            onSelect={(event) =>
                                setCursor(event.currentTarget.selectionStart)
                            }
                            onPaste={(event) => {
                                if (event.clipboardData.files[0]) {
                                    event.preventDefault();
                                    attach(event.clipboardData.files[0]);
                                }
                            }}
                            rows={1}
                            maxLength={4000}
                            disabled={
                                offline || Boolean(voice) || Boolean(file)
                            }
                            onKeyDown={(event) => {
                                if (event.nativeEvent.isComposing) return;
                                if (
                                    suggestions &&
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
                                                    (event.key === 'ArrowDown'
                                                        ? 1
                                                        : -1) +
                                                    suggestions.results
                                                        .length) %
                                                suggestions.results.length
                                        );
                                    else
                                        insertEmoji(
                                            suggestions.results[
                                                Math.min(
                                                    emojiIndex,
                                                    suggestions.results.length -
                                                        1
                                                )
                                            ]
                                        );
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
                                    !event.nativeEvent.isComposing
                                ) {
                                    event.preventDefault();
                                    void send();
                                }
                            }}
                        />
                        <div className="composer-tools">
                            <IconButton
                                icon="attach"
                                label="Attach file (up to 5 MB)"
                                disabled={
                                    offline ||
                                    Boolean(voice) ||
                                    (sending && Boolean(file))
                                }
                                onClick={() => fileInput.current?.click()}
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
                                    offline || Boolean(voice) || Boolean(file)
                                }
                                onClick={() => void record()}
                            />
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
                        </div>
                    </>
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
            <div className="composer-foot">
                <button
                    className="formatting-help-button"
                    onClick={() => setFormatting(true)}
                >
                    <Icon name="markdown" size={18} /> Formatting help
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
            onCancel={close}
            onClick={(event) => {
                if (event.target === event.currentTarget) close();
            }}
        >
            <div className="modal-content">
                <IconButton
                    icon="close"
                    label="Close dialog"
                    onClick={close}
                    className="modal-close"
                />
                <span className="modal-icon">
                    <Icon name="shield" size={29} />
                </span>
                {modal.type === 'privacy' ? (
                    <>
                        <div className="eyebrow">BETWEEN YOUR PEOPLE</div>
                        <h2>Private by design.</h2>
                        <p>
                            Your browser encrypts each message before it leaves
                            your device. The server relays encrypted messages
                            and keeps them in memory until it shuts down.
                        </p>
                        <div className="privacy-row">
                            <Icon name="lock" />
                            <div>
                                <strong>Your conversations, your keys.</strong>
                                <p>
                                    Only intended recipients can decrypt
                                    messages. A new arrival can read messages
                                    sent after they join, plus any room history
                                    an existing member explicitly shares with
                                    them.
                                </p>
                            </div>
                        </div>
                        <div className="privacy-row">
                            <Icon name="clock" />
                            <div>
                                <strong>Here for now. Gone on restart.</strong>
                                <p>
                                    No message files, database, or message logs.
                                    Encryption keys are stored in your browser
                                    so refreshing can recover your messages.
                                </p>
                            </div>
                        </div>
                        <div className="privacy-row">
                            <Icon name="video" />
                            <div>
                                <strong>Calls between browsers.</strong>
                                <p>
                                    Voice, video, and screen sharing are
                                    encrypted. Calls aren’t recorded. A relay,
                                    if configured, only forwards encrypted
                                    media.
                                </p>
                            </div>
                        </div>
                        <div className="privacy-note">
                            Display names and connection information are visible
                            to the server. For extra assurance, compare a safety
                            code with each friend using another trusted channel.
                        </div>
                        <button className="primary" onClick={close}>
                            Sounds good <Icon name="check" size={18} />
                        </button>
                    </>
                ) : (
                    <>
                        <div className="eyebrow">VERIFY YOUR CONNECTION</div>
                        <h2>You & {modal.peer.name}</h2>
                        <p>
                            Compare this code with {modal.peer.name} in person
                            or using another trusted channel. Both browsers
                            should show the same code.
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
                            The code changes if either person clears their
                            browser’s encryption keys. A matching name alone
                            does not verify someone’s identity.
                        </p>
                        <button
                            className="primary"
                            disabled={!code}
                            onClick={() => {
                                const stored = JSON.parse(
                                    localStorage.getItem('hush-verified') ||
                                        '{}'
                                );
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
                                : 'We compared these codes'}
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
    const [modal, setModal] = useState<Modal>(null);
    const [mobileNav, setMobileNav] = useState(false);
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
    const [menu, setMenu] = useState<{
        id: string;
        x: number;
        y: number;
    } | null>(null);
    const menuOrigin = useRef<HTMLElement | null>(null);
    const selectionAnchor = useRef<string | null>(null);
    const deleting = useRef(new Set<string>());
    const bottom = useRef<HTMLDivElement>(null);
    const scroll = useRef<HTMLDivElement>(null);
    const nearBottom = useRef(true);
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
    useEffect(() => {
        nearBottom.current = true;
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
                setMobileNav(false);
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
    }, [mobileNav, selectionMode, actionDialog, menu, editing, modal]);
    useEffect(() => {
        setSelected((ids) => {
            const next = ids.filter((id) =>
                state.messages.some((m) => m.id === id)
            );
            return next.length === ids.length ? ids : next;
        });
    }, [state.messages]);
    useEffect(() => {
        if (nearBottom.current)
            bottom.current?.scrollIntoView({
                behavior: 'instant',
                block: 'end',
            });
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
    const recipient =
        state.scope !== 'room'
            ? state.peers.find(
                  (p) => p.id !== self && dmScope(self, p.id) === state.scope
              )
            : undefined;
    const title = recipient?.name || 'The living room';
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
                        .querySelector<HTMLTextAreaElement>(
                            '.composer textarea'
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
    const menuMessage = state.messages.find((m) => m.id === menu?.id);
    const menuActions: MenuAction[] = menuMessage
        ? [
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
            p.online ||
            state.messages.some((m) => m.scope === dmScope(self, p.id))
    );
    const select = (scope: string) => {
        client.select(scope);
        setMobileNav(false);
    };
    const verified = (() => {
        try {
            return JSON.parse(
                localStorage.getItem('hush-verified') || '{}'
            ) as Record<string, string>;
        } catch {
            return {};
        }
    })();
    return (
        <main className="app-shell">
            {mobileNav && (
                <button
                    className="nav-backdrop"
                    aria-label="Close navigation"
                    onClick={() => setMobileNav(false)}
                />
            )}
            <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}>
                <div className="space-heading">
                    <div>
                        <h1>
                            Our little space
                            <span className="wordmark-dot">.</span>
                        </h1>
                        <span>
                            <i className="online-dot" /> {online.length} of{' '}
                            {state.config?.maxClients} here
                        </span>
                    </div>
                    <IconButton
                        icon="copy"
                        label="Copy invite link"
                        onClick={() => {
                            void navigator.clipboard
                                .writeText(location.origin)
                                .then(() =>
                                    client.notify(
                                        'Invite link copied. Share the password separately.'
                                    )
                                )
                                .catch(() => client.notify(location.origin));
                        }}
                    />
                </div>
                <div className="sidebar-content">
                    <div className="section-caption">YOUR SPACE</div>
                    <button
                        className={`channel-row ${state.scope === 'room' ? 'selected' : ''}`}
                        onClick={() => select('room')}
                    >
                        <Icon name="hash" />
                        <span>The living room</span>
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
                        <span>The lounge</span>
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
                                        size="tiny"
                                    />
                                    {p.name}
                                </span>
                            ))}
                        </div>
                    )}
                    <div className="section-caption dm-caption">
                        DIRECT MESSAGES
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
                                        online={p.online}
                                    />
                                    <span>
                                        {p.name}
                                        <small>
                                            {p.call === scope
                                                ? 'In a private call'
                                                : p.online
                                                  ? 'Online'
                                                  : 'Offline'}
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
                        <p className="sidebar-empty">
                            Your people will appear here
                            <br />
                            when they join.
                        </p>
                    )}
                </div>
                {state.call && (
                    <div className="sidebar-call">
                        <Icon name="volume" size={17} />
                        <div>
                            <strong>In a call</strong>
                            <small>
                                {state.call.scope === 'room'
                                    ? 'The lounge'
                                    : 'Private conversation'}
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
                    <Avatar
                        name={state.name}
                        id={self}
                        online={state.phase === 'online'}
                    />
                    <div>
                        <strong>{state.name}</strong>
                        {state.phase !== 'online' && (
                            <small>Reconnecting…</small>
                        )}
                    </div>
                    <IconButton
                        icon="logout"
                        label="Leave this space"
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
                        {recipient && !recipient.online && <span>Offline</span>}
                    </div>
                    <div className="header-actions">
                        <IconButton
                            icon="phone"
                            label="Start voice call"
                            disabled={
                                state.phase !== 'online' ||
                                Boolean(recipient && !recipient.online)
                            }
                            onClick={() => void client.joinCall(state.scope)}
                        />
                        <IconButton
                            icon="video"
                            label="Start video call"
                            disabled={
                                state.phase !== 'online' ||
                                Boolean(recipient && !recipient.online)
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
                        <ConversationActions
                            client={client}
                            scope={state.scope}
                            title={title}
                            online={state.phase === 'online'}
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
                        <span className="spinner" /> Reconnecting… Your draft
                        stays in this tab.
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
                                        .querySelector<HTMLTextAreaElement>(
                                            '.composer textarea'
                                        )
                                        ?.focus();
                                }
                            }}
                            placeholder="Find something in this conversation…"
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
                        if (el)
                            nearBottom.current =
                                el.scrollHeight -
                                    el.scrollTop -
                                    el.clientHeight <
                                100;
                    }}
                >
                    {conversationMessages.length === 0 && !search && (
                        <div className="conversation-intro">
                            <div className="intro-icon">
                                {recipient ? (
                                    <Avatar
                                        id={recipient.id}
                                        name={recipient.name}
                                        size="large"
                                    />
                                ) : (
                                    <Icon name="hash" size={34} />
                                )}
                            </div>
                            <div className="eyebrow">
                                {recipient
                                    ? 'JUST THE TWO OF YOU'
                                    : 'YOUR EVERYDAY HANGOUT'}
                            </div>
                            <h2>
                                {recipient
                                    ? `Hey, ${recipient.name}.`
                                    : 'Make yourself at home.'}
                            </h2>
                            <p>
                                {recipient
                                    ? 'A private little corner for your conversation.'
                                    : 'For the small updates, the big ideas, and everything in between.'}
                            </p>
                        </div>
                    )}
                    <div
                        className="messages"
                        role="log"
                        aria-label="Conversation messages"
                        aria-live="polite"
                    >
                        {timeline.map((item) =>
                            item.type === 'message' ? (
                                <ChatMessage
                                    message={item.message}
                                    self={self}
                                    key={item.id}
                                    selected={selected.includes(item.id)}
                                    selectionMode={selectionMode}
                                    toggle={toggle}
                                    menu={openMenu}
                                    edit={editMessage}
                                    remove={deleteMessage}
                                    editing={editing === item.id}
                                    closeEditor={() => {
                                        setEditing(null);
                                        document
                                            .querySelector<HTMLTextAreaElement>(
                                                '.composer textarea'
                                            )
                                            ?.focus();
                                    }}
                                />
                            ) : (
                                <div
                                    className={`presence-event ${item.event.action}`}
                                    key={item.id}
                                >
                                    <Icon
                                        name={
                                            item.event.action === 'joined'
                                                ? 'arrow'
                                                : 'logout'
                                        }
                                        size={15}
                                    />
                                    <span>
                                        <strong>{item.event.name}</strong>{' '}
                                        {item.event.action} the room
                                    </span>
                                    <time
                                        dateTime={new Date(
                                            item.time
                                        ).toISOString()}
                                    >
                                        {new Date(item.time).toLocaleTimeString(
                                            [],
                                            {
                                                hour: '2-digit',
                                                minute: '2-digit',
                                            }
                                        )}
                                    </time>
                                </div>
                            )
                        )}
                    </div>
                    {messages.length === 0 && search && (
                        <div className="empty-conversation">
                            <Icon name="search" size={28} />
                            <p>No messages match your search.</p>
                            <small>Try another word or phrase.</small>
                        </div>
                    )}
                    <div ref={bottom} />
                </div>
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
                        <h2>Your people</h2>
                        <span>{online.length}</span>
                    </div>
                    <div className="section-caption">
                        HERE NOW — {online.length}
                    </div>
                    {online.map((p) => (
                        <div className="member-item" key={p.id}>
                            <button
                                className="member-main"
                                onClick={() => {
                                    if (p.id !== self)
                                        select(dmScope(self, p.id));
                                }}
                                disabled={p.id === self}
                            >
                                <Avatar name={p.name} id={p.id} online />
                                <span>
                                    <strong>
                                        {p.name}
                                        {p.id === self && <small>you</small>}
                                    </strong>
                                    <small>
                                        {p.call ? 'In a call' : 'Online'}
                                    </small>
                                </span>
                            </button>
                            {p.id !== self && (
                                <ParticipantVolume id={p.id} name={p.name} />
                            )}
                            {p.id !== self && (
                                <IconButton
                                    icon="shield"
                                    label={`Verify ${p.name}`}
                                    active={
                                        verified[p.name.toLowerCase()] === p.id
                                    }
                                    onClick={() =>
                                        setModal({ type: 'safety', peer: p })
                                    }
                                />
                            )}
                            {p.id !== self &&
                                verified[p.name.toLowerCase()] &&
                                verified[p.name.toLowerCase()] !== p.id && (
                                    <span className="key-changed">
                                        Encryption key changed — verify again
                                    </span>
                                )}
                        </div>
                    ))}
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
                                .querySelector<HTMLTextAreaElement>(
                                    '.composer textarea'
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
