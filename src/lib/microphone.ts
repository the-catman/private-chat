import { getAudioPreferences, type NoiseReduction } from './audio-preferences';

export type MicrophoneFilter = {
    stream: MediaStream;
    mode: NoiseReduction;
    close: () => void;
};
export const microphoneConstraints = (
    mode = getAudioPreferences().noiseReduction
): MediaTrackConstraints => ({
    echoCancellation: true,
    autoGainControl: true,
    noiseSuppression: mode === 'browser',
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48000 },
});
let model: Promise<ArrayBuffer> | undefined;
function loadModel() {
    return (model ||= fetch(
        new URL('../assets/audio/gtcrn.wasm', import.meta.url),
        { credentials: 'same-origin' }
    )
        .then(async (response) => {
            if (!response.ok)
                throw new Error('Noise-reduction model unavailable.');
            const data = await response.arrayBuffer();
            if (!WebAssembly.validate(data))
                throw new Error('Invalid noise-reduction model.');
            return data;
        })
        .catch((error) => {
            model = undefined;
            throw error;
        }));
}
export async function processMicrophone(
    raw: MediaStream,
    mode: NoiseReduction,
    onFallback: () => void
): Promise<MicrophoneFilter> {
    const track = raw.getAudioTracks()[0];
    if (!track || track.readyState === 'ended')
        throw new Error('Microphone is unavailable.');
    await track.applyConstraints(microphoneConstraints(mode));
    if (mode !== 'enhanced') return { stream: raw, mode, close() {} };
    let context: AudioContext | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let node: AudioWorkletNode | undefined;
    let destination: MediaStreamAudioDestinationNode | undefined;
    let ready = false;
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        if (node) {
            node.onprocessorerror = null;
            node.port.postMessage('destroy');
            node.port.close();
            node.disconnect();
        }
        source?.disconnect();
        destination?.stream.getTracks().forEach((output) => output.stop());
        void context?.close().catch(() => {});
    };
    const filter: MicrophoneFilter = { stream: raw, mode: 'enhanced', close };
    const fallback = () => {
        if (closed || !ready || filter.mode !== 'enhanced') return;
        filter.mode = 'browser';
        node?.disconnect();
        source?.disconnect();
        source?.connect(destination!);
        void track
            .applyConstraints(microphoneConstraints('browser'))
            .catch(() => {});
        onFallback();
    };
    try {
        context = new AudioContext({
            sampleRate: 48000,
            latencyHint: 'interactive',
        });
        if (!context.audioWorklet)
            throw new Error('Audio processing is unavailable.');
        const resume = context.resume();
        const wasmBinary = await loadModel();
        await context.audioWorklet.addModule(
            new URL('../assets/audio/gtcrn-worklet.js', import.meta.url).href
        );
        source = context.createMediaStreamSource(raw);
        destination = context.createMediaStreamDestination();
        node = new AudioWorkletNode(
            context,
            '@sapphi-red/web-noise-suppressor/gtcrn',
            {
                channelCount: 1,
                channelCountMode: 'explicit',
                outputChannelCount: [1],
                processorOptions: { maxChannels: 1, wasmBinary },
            }
        );
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
                () => reject(new Error('Noise reduction did not start.')),
                5000
            );
            const fail = () => {
                clearTimeout(timeout);
                reject(new Error('Noise reduction failed.'));
            };
            node!.onprocessorerror = fail;
            node!.port.onmessage = (event) => {
                if (event.data === 'error') {
                    if (ready) fallback();
                    else fail();
                } else if (event.data === 'ready') {
                    clearTimeout(timeout);
                    resolve();
                }
            };
        });
        await Promise.race([
            resume,
            new Promise<never>((_, reject) =>
                setTimeout(
                    () => reject(new Error('Microphone audio is paused.')),
                    1500
                )
            ),
        ]);
        ready = true;
        node.onprocessorerror = fallback;
        source.connect(node);
        node.connect(destination);
        filter.stream = destination.stream;
        return filter;
    } catch {
        close();
        if (raw.getAudioTracks().some((input) => input.readyState === 'live')) {
            await track
                .applyConstraints(microphoneConstraints('browser'))
                .catch(() => {});
            onFallback();
        }
        return { stream: raw, mode: 'browser', close() {} };
    }
}
export async function captureMicrophone(onFallback: () => void) {
    const raw = await navigator.mediaDevices.getUserMedia({
        audio: microphoneConstraints(),
    });
    try {
        const filter = await processMicrophone(
            raw,
            getAudioPreferences().noiseReduction,
            onFallback
        );
        return {
            stream: filter.stream,
            close() {
                filter.close();
                raw.getTracks().forEach((track) => track.stop());
            },
        };
    } catch (error) {
        raw.getTracks().forEach((track) => track.stop());
        throw error;
    }
}
