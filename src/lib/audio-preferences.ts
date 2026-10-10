export type NoiseReduction = 'browser' | 'enhanced' | 'off';
export type AudioPreferences = {
    sounds: boolean;
    volume: number;
    noiseReduction: NoiseReduction;
    shareAudio: boolean;
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
