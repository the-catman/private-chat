export type NoiseReduction = 'browser' | 'enhanced' | 'off';
export type AudioPreferences = {
    sounds: boolean;
    volume: number;
    noiseReduction: NoiseReduction;
    shareAudio: boolean;
    pushToTalk: boolean;
    // A KeyboardEvent code, so it does not depend on the keyboard layout.
    pushToTalkKey: string;
};
const read = (): Partial<AudioPreferences> => {
    try {
        const value: unknown = JSON.parse(
            localStorage.getItem('hush-audio') || '{}'
        );
        return value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Partial<AudioPreferences>)
            : {};
    } catch {
        return {};
    }
};
const saved = read();
let preferences: AudioPreferences = {
    sounds: saved.sounds !== false,
    volume:
        typeof saved.volume === 'number' && Number.isFinite(saved.volume)
            ? Math.max(0, Math.min(1, saved.volume))
            : 0.3,
    noiseReduction:
        saved.noiseReduction === 'enhanced' || saved.noiseReduction === 'off'
            ? saved.noiseReduction
            : 'browser',
    shareAudio: saved.shareAudio !== false,
    pushToTalk: saved.pushToTalk === true,
    pushToTalkKey:
        typeof saved.pushToTalkKey === 'string' &&
        /^[A-Za-z0-9]{1,24}$/.test(saved.pushToTalkKey)
            ? saved.pushToTalkKey
            : 'Backquote',
};
const listeners = new Set<() => void>();
export const getAudioPreferences = () => preferences;
export const subscribeAudioPreferences = (listener: () => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};
export function setAudioPreferences(patch: Partial<AudioPreferences>) {
    preferences = { ...preferences, ...patch };
    preferences.volume = Number.isFinite(preferences.volume)
        ? Math.max(0, Math.min(1, preferences.volume))
        : 0.3;
    try {
        localStorage.setItem('hush-audio', JSON.stringify(preferences));
    } catch {}
    for (const listener of listeners) listener();
}

// A short name for a push-to-talk key code.
const keyNames: Record<string, string> = {
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    ControlLeft: 'Left Ctrl',
    ControlRight: 'Right Ctrl',
    ShiftLeft: 'Left Shift',
    ShiftRight: 'Right Shift',
    AltLeft: 'Left Alt',
    AltRight: 'Right Alt',
    CapsLock: 'Caps Lock',
};
export const keyName = (code: string) =>
    keyNames[code] ??
    code
        .replace(/^Key(?=[A-Z]$)|^Digit(?=\d$)/, '')
        .replace(/^Numpad/, 'Numpad ');
