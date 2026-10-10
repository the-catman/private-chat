import { useEffect, useRef } from 'react';

type Subject = {
    id: string;
    stream?: MediaStream | null;
    enabled: boolean;
};
type Meter = {
    track: MediaStreamTrack;
    source: MediaStreamAudioSourceNode;
    analyser: AnalyserNode;
    samples: Float32Array<ArrayBuffer>;
    frequencies: Uint8Array<ArrayBuffer>;
    level: number;
    speaking: boolean;
    lastVoice: number;
};
const rays = Array.from({ length: 32 }, (_, index) => {
    const angle = (index / 32) * Math.PI * 2 - Math.PI / 2;
    return {
        x: Math.cos(angle),
        y: Math.sin(angle),
        band: index < 16 ? index : 31 - index,
    };
});

// One silent analysis graph per call view. Only the small indicators are painted;
// audio samples never enter React/chat state, storage, or the signalling channel.
export function useCallActivity(subjects: Subject[], view: Window) {
    const elements = useRef(new Map<string, HTMLDivElement>());
    const latest = useRef(subjects);
    latest.current = subjects;
    const synchronize = useRef<() => void>(() => {});

    useEffect(() => {
        let context: AudioContext;
        try {
            context = new AudioContext();
        } catch {
            return;
        }
        const meters = new Map<string, Meter>();
        const motion = view.matchMedia('(prefers-reduced-motion: reduce)');
        let frame = 0;
        let lastPaint = 0;
        let disposed = false;
        const quiet = (id: string) => {
            const tile = elements.current.get(id);
            if (tile) {
                tile.dataset.speaking = 'false';
                tile.style.setProperty('--voice-level', '0');
            }
        };
        const disconnect = (meter: Meter) => {
            meter.source.disconnect();
            meter.analyser.disconnect();
        };
        const sync = () => {
            const current = latest.current;
            for (const [id, meter] of meters) {
                const subject = current.find((item) => item.id === id);
                if (
                    !subject?.enabled ||
                    subject.stream?.getAudioTracks()[0] !== meter.track ||
                    meter.track.readyState === 'ended'
                ) {
                    disconnect(meter);
                    meters.delete(id);
                    quiet(id);
                }
            }
            for (const subject of current) {
                const track = subject.stream?.getAudioTracks()[0];
                if (!subject.enabled || !track || track.readyState !== 'live') {
                    quiet(subject.id);
                    continue;
                }
                if (meters.has(subject.id)) continue;
                try {
                    const source = context.createMediaStreamSource(
                        new MediaStream([track])
                    );
                    const analyser = context.createAnalyser();
                    analyser.fftSize = 1024;
                    analyser.smoothingTimeConstant = 0.7;
                    analyser.minDecibels = -75;
                    analyser.maxDecibels = -20;
                    source.connect(analyser);
                    // No connection to speakers: this must never play the mic twice.
                    meters.set(subject.id, {
                        track,
                        source,
                        analyser,
                        samples: new Float32Array(analyser.fftSize),
                        frequencies: new Uint8Array(analyser.frequencyBinCount),
                        level: 0,
                        speaking: false,
                        lastVoice: -Infinity,
                    });
                } catch {
                    quiet(subject.id);
                }
            }
        };
        synchronize.current = sync;
        sync();
        const resume = () => {
            if (!disposed && context.state === 'suspended')
                void context.resume().catch(() => {});
        };
        const visibility = () => {
            if (view.document.visibilityState === 'visible') resume();
            else
                for (const [id, meter] of meters) {
                    meter.speaking = false;
                    meter.lastVoice = -Infinity;
                    quiet(id);
                }
        };
        resume();
        view.document.addEventListener('pointerdown', resume, true);
        view.document.addEventListener('keydown', resume, true);
        view.document.addEventListener('visibilitychange', visibility);
        const paint = (now: number) => {
            if (disposed) return;
            frame = view.requestAnimationFrame(paint);
            if (now - lastPaint < (motion.matches ? 100 : 1000 / 30)) return;
            lastPaint = now;
            for (const [id, meter] of meters) {
                const tile = elements.current.get(id);
                if (!tile) continue;
                if (
                    context.state !== 'running' ||
                    !meter.track.enabled ||
                    meter.track.muted ||
                    meter.track.readyState !== 'live'
                ) {
                    meter.speaking = false;
                    meter.lastVoice = -Infinity;
                    meter.level = 0;
                    quiet(id);
                    continue;
                }
                meter.analyser.getFloatTimeDomainData(meter.samples);
                let sum = 0;
                let squares = 0;
                for (const value of meter.samples) {
                    sum += value;
                    squares += value * value;
                }
                const rms = Math.sqrt(
                    Math.max(
                        0,
                        squares / meter.samples.length -
                            (sum / meter.samples.length) ** 2
                    )
                );
                // Hysteresis and a short hold keep syllables from flickering.
                if (rms > (meter.speaking ? 0.005 : 0.009))
                    meter.lastVoice = now;
                meter.speaking = now - meter.lastVoice < 220;
                const target = meter.speaking ? Math.min(1, rms * 7) : 0;
                meter.level +=
                    (target - meter.level) *
                    (target > meter.level ? 0.55 : 0.2);
                tile.dataset.speaking = String(meter.speaking);
                tile.style.setProperty(
                    '--voice-level',
                    motion.matches ? '0' : meter.level.toFixed(3)
                );
                if (!meter.speaking || motion.matches) continue;
                const wave = tile.querySelector('.voice-wave');
                if (!wave) continue;
                meter.analyser.getByteFrequencyData(meter.frequencies);
                const path = rays
                    .map(({ x, y, band }) => {
                        const hz = 150 * (4000 / 150) ** (band / 15);
                        const bin = Math.min(
                            meter.frequencies.length - 1,
                            Math.round(
                                (hz * meter.analyser.fftSize) /
                                    context.sampleRate
                            )
                        );
                        const strength =
                            Math.max(
                                meter.frequencies[bin],
                                meter.frequencies[Math.max(0, bin - 1)]
                            ) / 255;
                        const radius =
                            44 + (2 + strength * 9) * (0.3 + meter.level * 0.7);
                        return `M${(60 + x * 43).toFixed(2)},${(60 + y * 43).toFixed(2)}L${(60 + x * radius).toFixed(2)},${(60 + y * radius).toFixed(2)}`;
                    })
                    .join('');
                wave.setAttribute('d', path);
            }
        };
        frame = view.requestAnimationFrame(paint);
        return () => {
            disposed = true;
            synchronize.current = () => {};
            view.cancelAnimationFrame(frame);
            view.document.removeEventListener('pointerdown', resume, true);
            view.document.removeEventListener('keydown', resume, true);
            view.document.removeEventListener('visibilitychange', visibility);
            for (const [id, meter] of meters) {
                disconnect(meter);
                quiet(id);
            }
            meters.clear();
            void context.close().catch(() => {});
        };
    }, [view]);
    useEffect(() => synchronize.current(), [subjects]);

    return (id: string, element: HTMLDivElement | null) => {
        if (element) elements.current.set(id, element);
        else elements.current.delete(id);
    };
}
