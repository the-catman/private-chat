import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useMobilePanel } from './useMobilePanel';
import { SheetHandle } from './SheetHandle';
import {
    getAudioPreferences,
    keyName,
    setAudioPreferences,
    subscribeAudioPreferences,
    type NoiseReduction,
} from '../lib/audio-preferences';
import { previewSound } from '../lib/sounds';
import { Icon } from '../Icon';
import type { CallState } from '../types';

export function AudioSettingsFields({
    call,
    onScreenAudio,
}: {
    call?: CallState | null;
    onScreenAudio?: (enabled: boolean) => void;
}) {
    const prefs = useSyncExternalStore(
        subscribeAudioPreferences,
        getAudioPreferences
    );
    return (
        <>
            <fieldset className="preference audio-preference">
                <legend>Sound effects</legend>
                <label className="audio-toggle">
                    <input
                        type="checkbox"
                        checked={prefs.sounds}
                        onChange={(event) =>
                            setAudioPreferences({
                                sounds: event.target.checked,
                            })
                        }
                    />
                    Message and call sounds
                </label>
                <div className="sound-volume">
                    <label>
                        Volume
                        <input
                            type="range"
                            aria-label="Sound effects volume"
                            min="0"
                            max="100"
                            step="5"
                            disabled={!prefs.sounds}
                            value={Math.round(prefs.volume * 100)}
                            onChange={(event) =>
                                setAudioPreferences({
                                    volume: Number(event.target.value) / 100,
                                })
                            }
                        />
                    </label>
                    <span>{Math.round(prefs.volume * 100)}%</span>
                    <button
                        className="subtle-button"
                        disabled={!prefs.sounds || prefs.volume === 0}
                        onClick={() => void previewSound()}
                    >
                        <Icon name="volume" size={17} /> Preview
                    </button>
                </div>
            </fieldset>
            <fieldset className="preference audio-preference">
                <legend>Microphone</legend>
                <label className="audio-select">
                    Noise reduction
                    <select
                        aria-label="Noise reduction"
                        value={prefs.noiseReduction}
                        onChange={(event) =>
                            setAudioPreferences({
                                noiseReduction: event.target
                                    .value as NoiseReduction,
                            })
                        }
                    >
                        <option value="browser">Browser</option>
                        <option value="enhanced">Enhanced (on device)</option>
                        <option value="off">Off</option>
                    </select>
                </label>
                <p>
                    Enhanced filters background noise on your device. It uses
                    more CPU.
                </p>
                <label className="audio-toggle">
                    <input
                        type="checkbox"
                        checked={prefs.pushToTalk}
                        onChange={(event) =>
                            setAudioPreferences({
                                pushToTalk: event.target.checked,
                            })
                        }
                    />
                    Push to talk
                </label>
                {prefs.pushToTalk && (
                    <PushToTalkKey code={prefs.pushToTalkKey} />
                )}
                {call?.noisePending ? (
                    <p role="status">Changing microphone processing…</p>
                ) : (
                    call &&
                    call.noiseReduction !== prefs.noiseReduction && (
                        <p role="status">
                            Using browser noise reduction for this call.
                        </p>
                    )
                )}
            </fieldset>
            <fieldset className="preference audio-preference">
                <legend>Screen sharing</legend>
                <label className="audio-toggle">
                    <input
                        type="checkbox"
                        checked={
                            call?.screen ? call.screenAudio : prefs.shareAudio
                        }
                        onChange={(event) => {
                            setAudioPreferences({
                                shareAudio: event.target.checked,
                            });
                            onScreenAudio?.(event.target.checked);
                        }}
                    />
                    {call?.screen
                        ? 'Share screen audio'
                        : 'Include audio when sharing'}
                </label>
                <p>
                    {call?.screen && !call.screenAudioAvailable
                        ? 'To add sound, choose your screen or tab again. Your browser may only offer audio for certain sources.'
                        : 'Also enable audio in your browser’s sharing picker when it offers it.'}
                </p>
            </fieldset>
        </>
    );
}

// Press the button, then the key to hold while talking.
function PushToTalkKey({ code }: { code: string }) {
    const [listening, setListening] = useState(false);
    const chosen = useRef(false);
    return (
        <div className="push-to-talk-key">
            <span id="push-to-talk-key">Key</span>
            <button
                className="subtle-button"
                aria-labelledby="push-to-talk-key push-to-talk-value"
                aria-pressed={listening}
                onClick={() => {
                    if (chosen.current) chosen.current = false;
                    else setListening(true);
                }}
                onBlur={() => setListening(false)}
                onKeyDown={(event) => {
                    if (!listening) return;
                    event.preventDefault();
                    event.stopPropagation();
                    // These keys keep their usual jobs.
                    if (
                        !['Escape', 'Tab', 'Enter', 'Backspace'].includes(
                            event.key
                        ) &&
                        /^[A-Za-z0-9]{1,24}$/.test(event.code)
                    ) {
                        setAudioPreferences({ pushToTalkKey: event.code });
                        // Space and Enter would press this button again.
                        chosen.current = true;
                    }
                    setListening(false);
                }}
                onKeyUp={() => {
                    setTimeout(() => (chosen.current = false));
                }}
            >
                <span id="push-to-talk-value">
                    {listening ? 'Press a key…' : keyName(code)}
                </span>
            </button>
        </div>
    );
}

export function AudioSettingsDialog({
    call,
    onScreenAudio,
    close,
}: {
    call: CallState;
    onScreenAudio: (enabled: boolean) => void;
    close: () => void;
}) {
    const ref = useRef<HTMLDialogElement>(null);
    const dismiss = useMobilePanel(ref, close);
    useEffect(() => {
        ref.current?.showModal();
    }, []);
    return (
        <dialog
            ref={ref}
            className="modal audio-settings"
            aria-labelledby="audio-title"
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
                    className="icon-button modal-close"
                    aria-label="Close audio settings"
                    onClick={dismiss}
                >
                    <Icon name="close" />
                </button>
                <h2 id="audio-title">Sound & microphone</h2>
                <AudioSettingsFields
                    call={call}
                    onScreenAudio={onScreenAudio}
                />
                <button className="primary" onClick={dismiss}>
                    Done <Icon name="check" size={18} />
                </button>
            </div>
        </dialog>
    );
}
