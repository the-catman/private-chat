import { useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { AudioSettingsFields } from './AudioSettings';
import type { CallState } from '../types';

type Theme = 'dark' | 'light';
type Size = 'compact' | 'comfortable' | 'large';
const sizes: Record<Size, string> = {
    compact: '14px',
    comfortable: '16px',
    large: '18px',
};
const read = (key: string) => {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
};
let theme: Theme = read('hush-theme') === 'light' ? 'light' : 'dark';
let textSize: Size = (
    ['compact', 'comfortable', 'large'].includes(read('hush-text-size') || '')
        ? read('hush-text-size')
        : 'comfortable'
) as Size;
function apply() {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.fontSize = sizes[textSize];
    document.documentElement.style.colorScheme = theme;
}
apply();

export function AppearanceControls({
    onPrivacy,
    onVerify,
    call,
    onScreenAudio,
}: {
    onPrivacy?: () => void;
    onVerify?: () => void;
    call?: CallState | null;
    onScreenAudio?: (enabled: boolean) => void;
}) {
    const [current, setCurrent] = useState(theme);
    const [size, setSize] = useState(textSize);
    const [open, setOpen] = useState(false);
    const [section, setSection] = useState<'appearance' | 'audio'>(
        'appearance'
    );
    const dialog = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        if (open) dialog.current?.showModal();
    }, [open]);
    const change = (nextTheme: Theme, nextSize: Size) => {
        theme = nextTheme;
        textSize = nextSize;
        setCurrent(theme);
        setSize(textSize);
        try {
            localStorage.setItem('hush-theme', theme);
            localStorage.setItem('hush-text-size', textSize);
        } catch {}
        apply();
    };
    return (
        <div className="appearance-controls">
            <button
                className="icon-button"
                aria-label={`Switch to ${current === 'dark' ? 'light' : 'dark'} mode`}
                title={`Switch to ${current === 'dark' ? 'light' : 'dark'} mode`}
                onClick={() =>
                    change(current === 'dark' ? 'light' : 'dark', size)
                }
            >
                <Icon name={current === 'dark' ? 'sun' : 'moon'} />
            </button>
            <button
                className="icon-button"
                aria-label="Settings"
                title="Settings"
                onClick={() => setOpen(true)}
            >
                <Icon name="settings" />
            </button>
            {open && (
                <dialog
                    className="modal"
                    ref={dialog}
                    aria-labelledby="appearance-title"
                    onCancel={() => setOpen(false)}
                    onClick={(event) => {
                        if (event.target === event.currentTarget)
                            setOpen(false);
                    }}
                >
                    <div className="modal-content">
                        <button
                            className="icon-button modal-close"
                            aria-label="Close settings"
                            onClick={() => setOpen(false)}
                        >
                            <Icon name="close" />
                        </button>
                        <h2 id="appearance-title">
                            Make yourself comfortable.
                        </h2>
                        <p>Your preferences stay in this browser.</p>
                        <div
                            className="settings-tabs"
                            role="tablist"
                            aria-label="Settings sections"
                            onKeyDown={(event) => {
                                if (
                                    ![
                                        'ArrowLeft',
                                        'ArrowRight',
                                        'Home',
                                        'End',
                                    ].includes(event.key)
                                )
                                    return;
                                event.preventDefault();
                                const next =
                                    event.key === 'Home'
                                        ? 'appearance'
                                        : event.key === 'End'
                                          ? 'audio'
                                          : section === 'audio'
                                            ? 'appearance'
                                            : 'audio';
                                setSection(next);
                                event.currentTarget
                                    .querySelector<HTMLButtonElement>(
                                        `[data-section="${next}"]`
                                    )
                                    ?.focus();
                            }}
                        >
                            {(['appearance', 'audio'] as const).map((value) => (
                                <button
                                    key={value}
                                    id={`settings-tab-${value}`}
                                    data-section={value}
                                    role="tab"
                                    aria-selected={section === value}
                                    aria-controls="settings-panel"
                                    tabIndex={section === value ? 0 : -1}
                                    onClick={() => setSection(value)}
                                >
                                    <Icon
                                        name={
                                            value === 'audio' ? 'volume' : 'sun'
                                        }
                                        size={17}
                                    />
                                    {value === 'audio' ? 'Audio' : 'Appearance'}
                                </button>
                            ))}
                        </div>
                        <div
                            id="settings-panel"
                            role="tabpanel"
                            aria-labelledby={`settings-tab-${section}`}
                        >
                            {section === 'appearance' ? (
                                <>
                                    <fieldset className="preference">
                                        <legend>Color theme</legend>
                                        {(['dark', 'light'] as const).map(
                                            (value) => (
                                                <label key={value}>
                                                    <input
                                                        type="radio"
                                                        name="theme"
                                                        checked={
                                                            current === value
                                                        }
                                                        onChange={() =>
                                                            change(value, size)
                                                        }
                                                    />
                                                    {value === 'dark'
                                                        ? 'Dark'
                                                        : 'Light'}
                                                </label>
                                            )
                                        )}
                                    </fieldset>
                                    <fieldset className="preference">
                                        <legend>Text size</legend>
                                        {(
                                            [
                                                'compact',
                                                'comfortable',
                                                'large',
                                            ] as const
                                        ).map((value) => (
                                            <label key={value}>
                                                <input
                                                    type="radio"
                                                    name="text-size"
                                                    checked={size === value}
                                                    onChange={() =>
                                                        change(current, value)
                                                    }
                                                />
                                                {value.charAt(0).toUpperCase() +
                                                    value.slice(1)}
                                            </label>
                                        ))}
                                    </fieldset>
                                </>
                            ) : (
                                <AudioSettingsFields
                                    call={call}
                                    onScreenAudio={onScreenAudio}
                                />
                            )}
                        </div>
                        {(onPrivacy || onVerify) && (
                            <div className="settings-links">
                                {onPrivacy && (
                                    <button
                                        className="settings-link"
                                        onClick={() => {
                                            setOpen(false);
                                            onPrivacy();
                                        }}
                                    >
                                        <Icon name="shield" size={19} />
                                        <span>Privacy & encryption</span>
                                        <Icon name="chevron" size={16} />
                                    </button>
                                )}
                                {onVerify && (
                                    <button
                                        className="settings-link"
                                        onClick={() => {
                                            setOpen(false);
                                            onVerify();
                                        }}
                                    >
                                        <Icon name="check" size={19} />
                                        <span>Verify your safety code</span>
                                        <Icon name="chevron" size={16} />
                                    </button>
                                )}
                            </div>
                        )}
                        <button
                            className="primary"
                            onClick={() => setOpen(false)}
                        >
                            Done <Icon name="check" size={18} />
                        </button>
                        <details className="appearance-credits">
                            <summary>Font & emoji credits</summary>
                            <p>
                                <a
                                    href="https://fontsource.org/fonts/dm-sans"
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    DM Sans
                                </a>{' '}
                                by the DM Sans Project Authors, under the{' '}
                                <a
                                    href="https://openfontlicense.org/"
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    SIL Open Font License
                                </a>
                                .
                            </p>
                            <p>
                                <a
                                    href="https://github.com/jdecked/twemoji"
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    Twemoji
                                </a>{' '}
                                artwork by Twitter and contributors, under{' '}
                                <a
                                    href="https://creativecommons.org/licenses/by/4.0/"
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    CC BY 4.0
                                </a>
                                . Adapted to a color font by Mozilla, the
                                community, and{' '}
                                <a
                                    href="https://github.com/SableClient/twemoji-font"
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    SableClient
                                </a>
                                .
                            </p>
                            <p>
                                Emoji names and search data from{' '}
                                <a
                                    href="https://github.com/milesj/emojibase"
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    Emojibase
                                </a>{' '}
                                by Miles Johnson, under the MIT license.
                            </p>
                        </details>
                    </div>
                </dialog>
            )}
        </div>
    );
}
