import {
    getAudioPreferences,
    subscribeAudioPreferences,
} from './audio-preferences';

export type SoundCue =
    | 'sent'
    | 'received'
    | 'join'
    | 'leave'
    | 'call-join'
    | 'call-leave'
    | 'on'
    | 'off'
    | 'ring';
// Original, quiet bell/pluck tones. No audio files or network requests.
const melodies: Record<
    SoundCue,
    [frequency: number, offset: number, duration: number][]
> = {
    sent: [
        [392, 0, 0.12],
        [523.25, 0.05, 0.16],
    ],
    received: [
        [659.25, 0, 0.2],
        [783.99, 0.09, 0.25],
    ],
    join: [
        [392, 0, 0.16],
        [523.25, 0.08, 0.2],
    ],
    leave: [
        [440, 0, 0.18],
        [329.63, 0.08, 0.24],
    ],
    'call-join': [
        [392, 0, 0.22],
        [523.25, 0.08, 0.26],
        [659.25, 0.16, 0.3],
    ],
    'call-leave': [
        [523.25, 0, 0.18],
        [392, 0.09, 0.28],
    ],
    on: [
        [523.25, 0, 0.12],
        [659.25, 0.06, 0.16],
    ],
    off: [
        [440, 0, 0.12],
        [329.63, 0.06, 0.18],
    ],
    ring: [
        [523.25, 0, 0.26],
        [659.25, 0.13, 0.28],
        [783.99, 0.28, 0.36],
    ],
};
let context: AudioContext | undefined;
let master: GainNode | undefined;
let lastCue = -Infinity;
const active = new Set<OscillatorNode>();

function syncVolume() {
    const prefs = getAudioPreferences();
    if (master && context)
        master.gain.setTargetAtTime(
            prefs.sounds ? prefs.volume : 0,
            context.currentTime,
            0.01
        );
    if (!prefs.sounds || prefs.volume === 0) {
        for (const oscillator of active)
            try {
                oscillator.stop();
            } catch {}
        active.clear();
    }
}
subscribeAudioPreferences(syncVolume);

export async function unlockSounds() {
    if (!getAudioPreferences().sounds || typeof AudioContext === 'undefined')
        return;
    try {
        if (!context || context.state === 'closed') {
            context = new AudioContext();
            master = context.createGain();
            master.connect(context.destination);
            syncVolume();
        }
        if (context.state === 'suspended') await context.resume();
    } catch {
        /* Sound effects are optional; never interrupt a call or message. */
    }
}
export function installSoundActivation(doc: Document = document) {
    const activate = () => {
        void unlockSounds();
    };
    doc.addEventListener('pointerdown', activate, true);
    doc.addEventListener('keydown', activate, true);
    return () => {
        doc.removeEventListener('pointerdown', activate, true);
        doc.removeEventListener('keydown', activate, true);
    };
}
export function playSound(cue: SoundCue, preview = false) {
    const prefs = getAudioPreferences();
    if (
        !prefs.sounds ||
        prefs.volume === 0 ||
        !context ||
        !master ||
        context.state !== 'running'
    )
        return;
    const now = context.currentTime;
    // Suppress notification piles during bursts; never replay blocked sounds later.
    if (!preview && now - lastCue < 0.18) return;
    lastCue = now;
    for (const [frequency, offset, duration] of melodies[cue]) {
        const envelope = context.createGain();
        envelope.connect(master);
        const start = now + offset;
        envelope.gain.setValueAtTime(0, start);
        envelope.gain.linearRampToValueAtTime(0.15, start + 0.012);
        envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        const oscillator = context.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency * 1.015, start);
        oscillator.frequency.exponentialRampToValueAtTime(
            frequency,
            start + 0.04
        );
        oscillator.connect(envelope);
        active.add(oscillator);
        oscillator.onended = () => {
            active.delete(oscillator);
            oscillator.disconnect();
            envelope.disconnect();
        };
        oscillator.start(start);
        oscillator.stop(start + duration + 0.02);
    }
}
export async function previewSound() {
    await unlockSounds();
    playSound('call-join', true);
}
