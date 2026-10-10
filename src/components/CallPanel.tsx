import {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../Icon';
import type { CallState, ChatState } from '../types';
import type { ChatClient } from '../lib/client';
import { Avatar, IconButton, minutes } from './Common';
import { Media } from './Media';
import { installSoundActivation } from '../lib/sounds';
import { AudioSettingsDialog } from './AudioSettings';
import { useCallActivity } from './useCallActivity';
import { ParticipantVolume } from './ParticipantVolume';
import { useParticipantVolumes } from '../lib/participant-volume';

const DEFAULT_HEIGHT = 340;
const readHeight = () => {
    try {
        const value = Number(localStorage.getItem('hush-call-height'));
        return value >= 180 && value <= 2000 ? value : DEFAULT_HEIGHT;
    } catch {
        return DEFAULT_HEIGHT;
    }
};

type Popout = { window: Window; dispose: () => void };

export function CallPanel({
    call,
    state,
    client,
}: {
    call: CallState;
    state: ChatState;
    client: ChatClient;
}) {
    const [now, setNow] = useState(Date.now());
    const volumes = useParticipantVolumes();
    const [height, setHeight] = useState(readHeight);
    const [bounds, setBounds] = useState({ min: 200, max: 580 });
    const [expanded, setExpanded] = useState(false);
    const [audioSettings, setAudioSettings] = useState(false);
    const [container, setContainer] = useState<HTMLElement | null>(null);
    const panel = useRef<HTMLElement>(null);
    const anchor = useRef<HTMLDivElement>(null);
    const popout = useRef<Popout | null>(null);
    const drag = useRef<{ y: number; height: number } | null>(null);
    const visibleHeight = Math.max(bounds.min, Math.min(bounds.max, height));
    const title = call.scope === 'room' ? 'The lounge' : 'Private call';
    const captureDevices = () =>
        panel.current?.ownerDocument.defaultView?.navigator.mediaDevices;

    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);
    useLayoutEffect(() => {
        const conversation = anchor.current?.parentElement;
        if (!conversation) return;
        const measure = () => {
            const header =
                conversation
                    .querySelector('.conversation-header')
                    ?.getBoundingClientRect().height || 77;
            const composer =
                conversation
                    .querySelector('.composer-wrap')
                    ?.getBoundingClientRect().height || 120;
            const max = Math.max(
                160,
                conversation.clientHeight - header - composer - 48
            );
            setBounds({ min: Math.min(220, max), max });
        };
        const observer = new ResizeObserver(measure);
        observer.observe(conversation);
        const composer = conversation.querySelector('.composer-wrap');
        if (composer) observer.observe(composer);
        measure();
        return () => observer.disconnect();
    }, []);
    useEffect(() => {
        if (!expanded) return;
        const previous = document.activeElement as HTMLElement | null;
        panel.current
            ?.querySelector<HTMLButtonElement>(
                '[aria-label="Restore chat view"]'
            )
            ?.focus();
        const escape = (event: KeyboardEvent) => {
            if ((event.target as HTMLElement).closest('dialog')) return;
            if (document.querySelector('[popover]:popover-open')) return;
            if (event.key === 'Tab') {
                const buttons = [
                    ...panel.current!.querySelectorAll<HTMLElement>(
                        'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]'
                    ),
                ];
                const first = buttons[0];
                const last = buttons.at(-1);
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first?.focus();
                }
            }
            if (
                event.key === 'Escape' &&
                !document.fullscreenElement &&
                !(event.target as HTMLElement).closest('dialog')
            ) {
                event.preventDefault();
                setExpanded(false);
            }
        };
        document.addEventListener('keydown', escape);
        return () => {
            document.removeEventListener('keydown', escape);
            if (previous?.isConnected) previous.focus({ preventScroll: true });
        };
    }, [expanded]);
    useEffect(
        () => () => {
            const current = popout.current;
            popout.current = null;
            current?.dispose();
            current?.window.close();
        },
        []
    );

    const resize = (value: number, persist = false) => {
        const next = Math.round(
            Math.max(bounds.min, Math.min(bounds.max, value))
        );
        setHeight(next);
        if (persist)
            try {
                localStorage.setItem('hush-call-height', String(next));
            } catch {}
    };
    const bringBack = () => {
        const current = popout.current;
        popout.current = null;
        current?.dispose();
        setContainer(null);
        current?.window.close();
        window.focus();
    };
    const openPopout = () => {
        if (popout.current && !popout.current.window.closed) {
            popout.current.window.focus();
            return;
        }
        const child = window.open(
            '',
            '_blank',
            'popup,width=1060,height=720,resizable=yes'
        );
        if (!child) {
            client.notify(
                'Allow pop-ups for Hush to open the call in another window.'
            );
            return;
        }
        child.opener = null;
        child.document.title = `${title} · Hush`;
        child.document.documentElement.lang =
            document.documentElement.lang || 'en';
        child.document.body.className = 'call-popout';
        const root = child.document.createElement('div');
        root.id = 'call-popout-root';
        child.document.body.append(root);
        const copyStyles = () => {
            if (child.closed) return;
            child.document.head
                .querySelectorAll('[data-call-style]')
                .forEach((node) => node.remove());
            document.head
                .querySelectorAll('style, link[rel="stylesheet"]')
                .forEach((node) => {
                    const copy = node.cloneNode(true) as HTMLElement;
                    copy.dataset.callStyle = '';
                    if (node instanceof HTMLLinkElement)
                        (copy as HTMLLinkElement).href = node.href;
                    child.document.head.append(copy);
                });
        };
        const copyTheme = () => {
            if (child.closed) return;
            child.document.documentElement.dataset.theme =
                document.documentElement.dataset.theme;
            child.document.documentElement.style.cssText =
                document.documentElement.style.cssText;
        };
        copyStyles();
        copyTheme();
        const removeSoundActivation = installSoundActivation(child.document);
        const styles = new MutationObserver(copyStyles);
        const theme = new MutationObserver(copyTheme);
        styles.observe(document.head, {
            subtree: true,
            childList: true,
            characterData: true,
        });
        theme.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme', 'style'],
        });
        const closed = () => {
            if (popout.current?.window !== child) return;
            bringBack();
        };
        child.addEventListener('pagehide', closed);
        window.addEventListener('pagehide', closed);
        const interval = setInterval(() => {
            if (child.closed) closed();
        }, 500);
        popout.current = {
            window: child,
            dispose: () => {
                styles.disconnect();
                removeSoundActivation();
                theme.disconnect();
                clearInterval(interval);
                child.removeEventListener('pagehide', closed);
                window.removeEventListener('pagehide', closed);
            },
        };
        setExpanded(false);
        setContainer(root);
        child.focus();
    };
    const people = [
        {
            id: state.self!,
            name: state.name,
            state: call,
            streams: call.local,
            status: 'connected',
        },
        ...call.peers.map((person) => ({
            ...person,
            name:
                state.peers.find((peer) => peer.id === person.id)?.name ||
                'Someone',
        })),
    ];
    const sharing = people.filter(
        (person) => person.state.screen && person.streams.screen
    );
    const speakerRef = useCallActivity(
        people.map((person) => ({
            id: person.id,
            stream: person.streams.mic,
            enabled:
                !person.state.muted &&
                !person.state.deafened &&
                person.status === 'connected',
        })),
        container?.ownerDocument.defaultView || window
    );
    const view = (
        <section
            ref={panel}
            role={expanded ? 'dialog' : 'region'}
            aria-modal={expanded || undefined}
            className={`call-panel ${sharing.length ? 'has-share' : ''} ${expanded ? 'call-expanded' : ''} ${container ? 'call-detached' : ''}`}
            aria-label="Active call"
            style={{ '--call-height': `${visibleHeight}px` } as CSSProperties}
        >
            <div className="call-heading">
                <span>
                    <i className="pulse-dot" />
                    <strong>{title}</strong>
                    <span className="call-duration">
                        {minutes((now - call.started) / 1000)}
                    </span>
                </span>
                <div className="call-view-controls">
                    {container ? (
                        <button className="subtle-button" onClick={bringBack}>
                            <Icon name="shrink" size={17} /> Back to chat
                        </button>
                    ) : (
                        <>
                            <IconButton
                                icon={expanded ? 'shrink' : 'expand'}
                                label={
                                    expanded
                                        ? 'Restore chat view'
                                        : 'Expand call'
                                }
                                onClick={() => setExpanded(!expanded)}
                            />
                            <IconButton
                                icon="popout"
                                label="Pop out call"
                                onClick={openPopout}
                            />
                        </>
                    )}
                </div>
            </div>
            <div className="call-stage">
                {sharing.length > 0 && (
                    <div className={`screen-grid screens-${sharing.length}`}>
                        {sharing.map((person) => (
                            <div className="screen-tile" key={person.id}>
                                <Media stream={person.streams.screen} muted />
                                <span>
                                    {person.name}
                                    {person.id === state.self
                                        ? ' (you)'
                                        : ''}{' '}
                                    is sharing
                                </span>
                                <button
                                    className="icon-button"
                                    aria-label="Expand shared screen"
                                    title="Expand shared screen"
                                    onClick={(event) => {
                                        const target =
                                            event.currentTarget.parentElement;
                                        if (
                                            target?.ownerDocument
                                                .fullscreenElement
                                        )
                                            void target.ownerDocument.exitFullscreen();
                                        else if (target?.requestFullscreen)
                                            void target
                                                .requestFullscreen()
                                                .catch(() =>
                                                    client.notify(
                                                        'Fullscreen is unavailable. Use Expand call instead.'
                                                    )
                                                );
                                        else setExpanded(true);
                                    }}
                                >
                                    <Icon name="expand" />
                                </button>
                            </div>
                        ))}
                    </div>
                )}
                <div className={`call-grid people-${people.length}`}>
                    {people.map((person) => (
                        <div
                            ref={(element) => speakerRef(person.id, element)}
                            className={`video-tile ${person.state.camera ? 'has-video' : ''}`}
                            key={person.id}
                        >
                            {person.state.camera && person.streams.camera ? (
                                <Media
                                    stream={person.streams.camera}
                                    muted
                                    className={
                                        person.id === state.self
                                            ? 'mirrored'
                                            : ''
                                    }
                                />
                            ) : (
                                <div className="call-avatar">
                                    <svg
                                        className="voice-ring"
                                        viewBox="0 0 120 120"
                                        aria-hidden="true"
                                    >
                                        <circle
                                            className="voice-halo"
                                            cx="60"
                                            cy="60"
                                            r="39"
                                        />
                                        <path className="voice-wave" />
                                    </svg>
                                    <Avatar
                                        id={person.id}
                                        name={person.name}
                                        size="large"
                                    />
                                </div>
                            )}
                            <span
                                className="speaking-indicator"
                                role="img"
                                aria-label={`${person.name} is speaking`}
                            >
                                <Icon name="volume" size={13} />
                                <span>Speaking</span>
                            </span>
                            <span className="video-name">
                                {person.name}
                                {person.id === state.self ? ' (you)' : ''}
                            </span>
                            {person.id !== state.self && (
                                <ParticipantVolume
                                    id={person.id}
                                    name={person.name}
                                />
                            )}
                            <span className="video-status">
                                <Icon
                                    name={
                                        person.state.muted ||
                                        person.state.deafened
                                            ? 'micOff'
                                            : 'mic'
                                    }
                                    size={14}
                                />
                            </span>
                            {person.status !== 'connected' &&
                                person.id !== state.self && (
                                    <span className="connection-label">
                                        {person.status === 'failed'
                                            ? 'Connection failed'
                                            : 'Connecting…'}
                                    </span>
                                )}
                        </div>
                    ))}
                    {people.length === 1 && (
                        <div className="video-tile waiting-tile">
                            <Icon name="headphones" size={28} />
                            <span>Room for your people</span>
                            <small>They can join whenever they’re ready.</small>
                        </div>
                    )}
                </div>
            </div>
            <div className="call-controls">
                <IconButton
                    icon={call.muted ? 'micOff' : 'mic'}
                    label={call.muted ? 'Unmute microphone' : 'Mute microphone'}
                    active={call.muted}
                    onClick={() => client.rtc?.mute()}
                />
                <IconButton
                    icon="headphones"
                    label={call.deafened ? 'Undeafen' : 'Deafen'}
                    active={call.deafened}
                    onClick={() => client.rtc?.deafen()}
                />
                <IconButton
                    icon="video"
                    label={call.camera ? 'Turn camera off' : 'Turn camera on'}
                    active={call.camera}
                    onClick={() => void client.rtc?.camera()}
                />
                <IconButton
                    icon="screen"
                    label={call.screen ? 'Stop sharing' : 'Share screen'}
                    active={call.screen}
                    onClick={() =>
                        void client.rtc?.screen(
                            undefined,
                            false,
                            captureDevices()
                        )
                    }
                />
                {call.screen && call.screenAudioAvailable && (
                    <IconButton
                        icon={call.screenAudio ? 'volume' : 'volumeOff'}
                        label={
                            call.screenAudio
                                ? 'Mute screen-share audio'
                                : 'Unmute screen-share audio'
                        }
                        active={call.screenAudio}
                        onClick={() =>
                            void client.rtc?.setScreenAudio(
                                !call.screenAudio,
                                captureDevices()
                            )
                        }
                    />
                )}
                <IconButton
                    icon="sliders"
                    label="Audio settings"
                    onClick={() => setAudioSettings(true)}
                />
                <span className="control-separator" />
                <button
                    className="leave-call"
                    aria-label="Leave"
                    title="Leave call"
                    onClick={() => client.leaveCall()}
                >
                    <Icon name="hangup" size={19} />
                    <span>Leave</span>
                </button>
            </div>
            {audioSettings && (
                <AudioSettingsDialog
                    call={call}
                    close={() => setAudioSettings(false)}
                    onScreenAudio={(enabled) =>
                        void client.rtc?.setScreenAudio(
                            enabled,
                            captureDevices()
                        )
                    }
                />
            )}
            {!expanded && !container && (
                <div
                    className="call-resize"
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label="Resize call panel"
                    aria-valuemin={bounds.min}
                    aria-valuemax={bounds.max}
                    aria-valuenow={Math.round(visibleHeight)}
                    tabIndex={0}
                    title="Drag to resize · Double-click to reset"
                    onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        drag.current = {
                            y: event.clientY,
                            height: visibleHeight,
                        };
                        event.currentTarget.setPointerCapture(event.pointerId);
                        event.preventDefault();
                    }}
                    onPointerMove={(event) => {
                        if (drag.current)
                            resize(
                                drag.current.height +
                                    event.clientY -
                                    drag.current.y
                            );
                    }}
                    onPointerUp={(event) => {
                        if (!drag.current) return;
                        resize(
                            drag.current.height +
                                event.clientY -
                                drag.current.y,
                            true
                        );
                        drag.current = null;
                        event.currentTarget.releasePointerCapture(
                            event.pointerId
                        );
                    }}
                    onPointerCancel={() => {
                        drag.current = null;
                    }}
                    onDoubleClick={() => resize(DEFAULT_HEIGHT, true)}
                    onKeyDown={(event) => {
                        const next =
                            event.key === 'ArrowUp'
                                ? visibleHeight - 24
                                : event.key === 'ArrowDown'
                                  ? visibleHeight + 24
                                  : event.key === 'Home'
                                    ? bounds.min
                                    : event.key === 'End'
                                      ? bounds.max
                                      : null;
                        if (next !== null) {
                            event.preventDefault();
                            resize(next, true);
                        }
                    }}
                >
                    <span />
                </div>
            )}
        </section>
    );
    return (
        <>
            <div ref={anchor} className="call-anchor" />
            {container ? (
                <>
                    <div className="call-away">
                        <Icon name="popout" />
                        <span>
                            <strong>Your call is in another window</strong>
                            <small>Keep this tab open during your call.</small>
                        </span>
                        <button
                            className="subtle-button"
                            onClick={() => popout.current?.window.focus()}
                        >
                            Show call
                        </button>
                        <button className="subtle-button" onClick={bringBack}>
                            Bring back
                        </button>
                    </div>
                    {createPortal(view, container)}
                </>
            ) : (
                view
            )}
            <div className="call-audio">
                {call.peers.map((person) => (
                    <div key={person.id} data-peer-audio={person.id}>
                        <Media
                            stream={person.streams.mic}
                            audio
                            muted={call.deafened}
                            volume={(volumes[person.id] ?? 100) / 100}
                        />
                        <Media
                            stream={person.streams.system}
                            audio
                            muted={call.deafened}
                            volume={(volumes[person.id] ?? 100) / 100}
                        />
                    </div>
                ))}
            </div>
        </>
    );
}
