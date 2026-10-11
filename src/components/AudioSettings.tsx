import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useMobilePanel } from './useMobilePanel';
import { SheetHandle } from './SheetHandle';
import {
    getAudioPreferences,
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
                    Soft sounds for messages and calls
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
                        <option value="enhanced">Enhanced · local AI</option>
                        <option value="off">Off</option>
                    </select>
                </label>
                <p>
                    Enhanced filters background noise on your device. It uses
                    more CPU.
                </p>
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
