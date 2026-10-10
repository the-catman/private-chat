import { useSyncExternalStore } from 'react';

const KEY = 'hush-participant-volumes';
const listeners = new Set<() => void>();
let volumes: Record<string, number> = {};
try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        volumes = Object.fromEntries(
            Object.entries(saved)
                .filter(
                    ([id, value]) =>
                        /^[A-Za-z0-9_-]{43}$/.test(id) &&
                        typeof value === 'number' &&
                        Number.isFinite(value) &&
                        value >= 0 &&
                        value <= 100
                )
                .slice(-256)
        );
    }
} catch {}

export function setParticipantVolume(id: string, value: number) {
    if (!Number.isFinite(value)) return;
    // Preferences contain identity IDs and levels only, never chat contents.
    volumes = Object.fromEntries([
        ...Object.entries(volumes)
            .filter(([key]) => key !== id)
            .slice(-255),
        [id, Math.round(Math.max(0, Math.min(100, value)))],
    ]);
    try {
        localStorage.setItem(KEY, JSON.stringify(volumes));
    } catch {}
    for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};
const snapshot = () => volumes;
export const useParticipantVolumes = () =>
    useSyncExternalStore(subscribe, snapshot);
