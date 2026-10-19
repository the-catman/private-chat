import type { Device, types as msc } from 'mediasoup-client';
import type {
    CallState,
    ClientPacket,
    Identity,
    MediaEvent,
    MediaKind,
    MediaRequest,
    MediaState,
    MlsServerPacket,
    Peer,
    ServerPacket,
    SessionConfig,
    Signal,
} from '../types';
import {
    getAudioPreferences,
    subscribeAudioPreferences,
    setAudioPreferences,
    type NoiseReduction,
} from './audio-preferences';
import {
    microphoneConstraints,
    processMicrophone,
    type MicrophoneFilter,
} from './microphone';
import type { DaveSession } from './dave.ts';
import type { WorkerMessage, WorkerRequest } from './dave-worker.ts';
// Media goes through the server's SFU, never browser to browser. Every frame
// is DAVE-encrypted with MLS-derived keys before it leaves the browser, so the
// server forwards only ciphertext. Media state uses the E2EE message channel.
type Remote = {
    state: Partial<MediaState>;
    streams: Partial<Record<MediaKind, MediaStream>>;
    consumers: Map<string, { consumer: msc.Consumer; source: MediaKind }>;
};
type Pending = {
    resolve: (data: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
};
const KINDS: MediaKind[] = ['mic', 'camera', 'screen', 'system'];
const REQUEST_MS = 10_000;
const UNREACHABLE =
    'Could not reach the call server. Check your connection, or ask whoever runs Hush to open its media port.';
export class CallEngine {
    peers = new Map<string, Remote>();
    scope: string | null = null;
    media: Record<MediaKind, MediaStream | null> = {
        mic: null,
        camera: null,
        screen: null,
        system: null,
    };
    state: MediaState = {
        muted: false,
        deafened: false,
        camera: false,
        screen: false,
        screenAudio: false,
    };
    started = 0;
    members: Peer[] = [];
    private operation = 0;
    private cameraPending = false;
    private screenPending = false;
    private rawMic: MediaStream | null = null;
    private micFilter?: MicrophoneFilter;
    private noiseReduction: NoiseReduction = 'browser';
    private noisePending = false;
    private noiseQueue: Promise<void> = Promise.resolve();
    private preferredNoise: NoiseReduction = 'browser';
    private unsubscribeAudio?: () => void;
    private device?: Device;
    private sendTransport?: msc.Transport;
    private recvTransport?: msc.Transport;
    private producers: Partial<Record<MediaKind, msc.Producer>> = {};
    private worker?: Worker;
    private dave?: DaveSession;
    private tasks: Promise<void> = Promise.resolve();
    private requests = new Map<number, Pending>();
    private requestId = 0;
    // MLS epochs' per-member base secrets, for ratchet generations on demand.
    private bases = new Map<number, Map<string, Uint8Array>>();
    private keySet = 0;
    private keyed = new Set<string>();
    private installing: Promise<void> = Promise.resolve();
    private restarted = new Map<string, number>();
    private ratchetKey?: typeof import('./dave.ts').ratchetKey;
    constructor(
        public identity: Identity,
        public config: SessionConfig,
        public wire: (packet: ClientPacket) => void,
        public send: (id: string, payload: Signal) => Promise<void>,
        public update: (call: CallState | null) => void,
        public notify: (message: string) => void
    ) {}
    get id() {
        return this.identity.id;
    }
    emit() {
        if (!this.scope) return this.update(null);
        this.update({
            scope: this.scope,
            started: this.started,
            ...this.state,
            noiseReduction: this.noiseReduction,
            noisePending: this.noisePending,
            screenAudioAvailable: Boolean(
                this.media.system
                    ?.getAudioTracks()
                    .some((track) => track.readyState === 'live')
            ),
            local: {
                mic: this.media.mic,
                camera: this.media.camera,
                screen: this.media.screen,
            },
            peers: Array.from(this.peers, ([id, p]) => ({
                id,
                state: p.state,
                status: this.status(id, p),
                streams: p.streams,
            })),
        });
    }
    // Connected means the server link is up and this person holds the
    // current call keys, so both of you can hear each other.
    private status(id: string, remote: Remote): RTCPeerConnectionState {
        const send = this.sendTransport?.connectionState;
        const recv = this.recvTransport?.connectionState;
        if (send === 'failed' || recv === 'failed') return 'failed';
        return send === 'connected' &&
            this.keyed.has(id) &&
            (!remote.consumers.size || recv === 'connected')
            ? 'connected'
            : 'connecting';
    }
    async join(scope: string, video: boolean) {
        if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection)
            throw new Error(
                'Calling is not supported in this browser. Try a current Chrome, Firefox, or Safari.'
            );
        if (typeof RTCRtpScriptTransform !== 'function')
            throw new Error(
                'This browser cannot encrypt call media. Update Chrome, Edge, Firefox, or Safari.'
            );
        const operation = ++this.operation;
        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: microphoneConstraints(),
                video: video
                    ? { width: { ideal: 1280 }, height: { ideal: 720 } }
                    : false,
            });
        } catch (error) {
            throw new Error(
                error instanceof DOMException &&
                    error.name === 'NotAllowedError'
                    ? 'Allow microphone access in your browser to join the call.'
                    : 'Could not open your microphone or camera. Check that it is connected.'
            );
        }
        if (operation !== this.operation) {
            stream.getTracks().forEach((t) => t.stop());
            throw new Error('Call cancelled.');
        }
        this.rawMic = new MediaStream(stream.getAudioTracks());
        this.preferredNoise = getAudioPreferences().noiseReduction;
        let filter: MicrophoneFilter;
        try {
            filter = await processMicrophone(
                this.rawMic,
                this.preferredNoise,
                this.noiseFallback
            );
        } catch (error) {
            stream.getTracks().forEach((track) => track.stop());
            throw error;
        }
        if (operation !== this.operation) {
            filter.close();
            stream.getTracks().forEach((track) => track.stop());
            throw new Error('Call cancelled.');
        }
        this.micFilter = filter;
        this.noiseReduction = filter.mode;
        this.scope = scope;
        this.started = Date.now();
        this.media.mic = filter.stream;
        this.media.camera = stream.getVideoTracks().length
            ? new MediaStream(stream.getVideoTracks())
            : null;
        this.state = {
            muted: false,
            deafened: false,
            camera: Boolean(this.media.camera),
            screen: false,
            screenAudio: false,
        };
        this.applyMute();
        this.unsubscribeAudio = subscribeAudioPreferences(() =>
            this.syncNoisePreference()
        );
        this.syncNoisePreference();
        this.emit();
        this.wire({ type: 'call', scope });
        const connecting = this.connect(operation);
        this.tasks = connecting.catch(() => {});
        await connecting;
    }
    private request<T>(body: MediaRequest) {
        const request = ++this.requestId;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.requests.delete(request);
                reject(new Error('The call server did not respond.'));
            }, REQUEST_MS);
            this.requests.set(request, {
                resolve: resolve as (data: unknown) => void,
                reject,
                timer,
            });
            try {
                this.wire({ type: 'media', request, ...body } as ClientPacket);
            } catch (error) {
                clearTimeout(timer);
                this.requests.delete(request);
                reject(error);
            }
        });
    }
    private enqueue(task: () => Promise<void>) {
        const operation = this.operation;
        this.tasks = this.tasks
            .then(() => (operation === this.operation ? task() : undefined))
            .catch(() => {});
    }
    private async connect(operation: number) {
        // The call stack loads on first use, keeping it out of app start-up.
        const [{ Device }, dave, setup] = await Promise.all([
            import('mediasoup-client'),
            import('./dave.ts'),
            this.request<{
                rtpCapabilities: msc.RtpCapabilities;
                producers: Extract<MediaEvent, { type: 'producer' }>[];
            }>({ action: 'setup' }),
        ]);
        this.ratchetKey = dave.ratchetKey;
        const device = await Device.factory();
        await device.load({ routerRtpCapabilities: setup.rtpCapabilities });
        if (operation !== this.operation) return;
        if (!device.canProduce('audio'))
            throw new Error('This browser cannot send audio to the call.');
        this.device = device;
        this.worker = new Worker(new URL('./dave-worker.ts', import.meta.url), {
            type: 'module',
        });
        this.worker.onmessage = (event: MessageEvent<WorkerRequest>) =>
            void this.derive(event.data);
        this.sendTransport = await this.transport('send', device);
        this.recvTransport = await this.transport('recv', device);
        if (operation !== this.operation) return;
        this.dave = new dave.DaveSession({
            identity: this.identity,
            boot: this.config.boot,
            scope: this.scope!,
            bundle: (id) =>
                id === this.id
                    ? this.identity.bundle
                    : this.members.find((member) => member.id === id)?.bundle,
            send: (packet) => this.wire(packet),
            install: (secrets, delay) => this.install(secrets, delay),
            fail: () =>
                this.notify(
                    'Call encryption could not be set up. Leave the call and join again.'
                ),
        });
        this.dave.start();
        for (const kind of KINDS) await this.produce(kind);
        for (const producer of setup.producers) await this.consume(producer);
        // ICE gives up only after half a minute; say why much sooner.
        const link = this.sendTransport;
        setTimeout(() => {
            if (
                operation === this.operation &&
                link.connectionState !== 'connected'
            )
                this.notify(UNREACHABLE);
        }, REQUEST_MS);
    }
    private async transport(direction: 'send' | 'recv', device: Device) {
        const options = await this.request<msc.TransportOptions>({
            action: 'transport',
            direction,
        });
        const transport =
            direction === 'send'
                ? device.createSendTransport(options)
                : device.createRecvTransport(options);
        transport.on('connect', ({ dtlsParameters }, done, fail) =>
            this.request({
                action: 'connect',
                transport: transport.id,
                dtlsParameters,
            }).then(() => done(), fail)
        );
        transport.on(
            'produce',
            ({ kind, rtpParameters, appData }, done, fail) =>
                this.request<{ id: string }>({
                    action: 'produce',
                    transport: transport.id,
                    kind,
                    rtpParameters,
                    source: appData.source as MediaKind,
                }).then(done, fail)
        );
        transport.on('connectionstatechange', (state) => {
            if (state === 'failed' || state === 'disconnected')
                void this.restart(transport, state);
            this.emit();
        });
        return transport;
    }
    // One ICE restart per transport every 10 seconds rides out network changes.
    private async restart(transport: msc.Transport, state: string) {
        const now = Date.now();
        if (now - (this.restarted.get(transport.id) || 0) < 10_000) {
            if (state === 'failed') this.notify(UNREACHABLE);
            return;
        }
        this.restarted.set(transport.id, now);
        if (state === 'disconnected')
            await new Promise((resolve) => setTimeout(resolve, 3000));
        if (transport.closed || transport.connectionState === 'connected')
            return;
        try {
            const { iceParameters } = await this.request<{
                iceParameters: msc.IceParameters;
            }>({ action: 'restart', transport: transport.id });
            if (!transport.closed)
                await transport.restartIce({ iceParameters });
        } catch {}
    }
    private install(secrets: Map<string, Uint8Array>, delay: number) {
        const set = ++this.keySet;
        const operation = this.operation;
        this.installing = this.installing
            .then(async () => {
                const keys = await Promise.all(
                    Array.from(
                        secrets,
                        async ([id, base]) =>
                            [id, await this.ratchetKey!(base, 0)] as [
                                string,
                                CryptoKey,
                            ]
                    )
                );
                if (operation !== this.operation || !this.worker) return;
                this.bases.set(set, secrets);
                for (const old of this.bases.keys())
                    if (old <= set - 4) this.bases.delete(old);
                this.worker.postMessage({
                    type: 'keys',
                    set,
                    self: this.id,
                    keys,
                    delay,
                } satisfies WorkerMessage);
                this.keyed = new Set(secrets.keys());
                this.emit();
            })
            .catch(() => {});
    }
    private async derive({ set, member, generation }: WorkerRequest) {
        const base = this.bases.get(set)?.get(member);
        if (!base || !Number.isInteger(generation) || generation > 255) return;
        const key = await this.ratchetKey!(base, generation);
        this.worker?.postMessage({
            type: 'key',
            set,
            member,
            generation,
            key,
        } satisfies WorkerMessage);
    }
    private async produce(kind: MediaKind) {
        const track = this.media[kind]?.getTracks()[0];
        const existing = this.producers[kind];
        if (!track || !this.sendTransport || !this.worker) return;
        if (existing) return existing.replaceTrack({ track });
        const worker = this.worker;
        this.producers[kind] = await this.sendTransport.produce({
            track,
            stopTracks: false,
            disableTrackOnPause: false,
            appData: { source: kind },
            ...(kind === 'system' && { codecOptions: { opusStereo: true } }),
            onRtpSender: (sender) => {
                sender.transform = new RTCRtpScriptTransform(worker, {
                    operation: 'encrypt',
                    kind: track.kind,
                });
            },
        });
    }
    private async unproduce(kind: MediaKind) {
        const producer = this.producers[kind];
        if (!producer) return;
        delete this.producers[kind];
        producer.close();
        await this.request({ action: 'close', producer: producer.id }).catch(
            () => {}
        );
    }
    private async consume({
        producer,
        member,
        source,
    }: Extract<MediaEvent, { type: 'producer' }>) {
        const transport = this.recvTransport;
        const worker = this.worker;
        if (member === this.id || !transport || !worker || !this.device) return;
        const operation = this.operation;
        let data: msc.ConsumerOptions;
        try {
            data = await this.request<msc.ConsumerOptions>({
                action: 'consume',
                producer,
                rtpCapabilities: this.device.rtpCapabilities,
            });
        } catch {
            return;
        }
        const consumer = await transport.consume({
            ...data,
            onRtpReceiver: (receiver) => {
                receiver.transform = new RTCRtpScriptTransform(worker, {
                    operation: 'decrypt',
                    kind: data.kind,
                    sender: member,
                });
            },
        });
        if (operation !== this.operation) return consumer.close();
        let remote = this.peers.get(member);
        if (!remote) {
            remote = { state: {}, streams: {}, consumers: new Map() };
            this.peers.set(member, remote);
        }
        remote.consumers.get(producer)?.consumer.close();
        remote.consumers.set(producer, { consumer, source });
        remote.streams[source] = new MediaStream([consumer.track]);
        consumer.track.onunmute = () => this.emit();
        this.emit();
        await this.request({ action: 'resume', consumer: consumer.id }).catch(
            () => {}
        );
    }
    private closeProducer(producer: string) {
        for (const remote of this.peers.values()) {
            const entry = remote.consumers.get(producer);
            if (!entry) continue;
            entry.consumer.close();
            remote.consumers.delete(producer);
            if (
                remote.streams[entry.source]?.getTracks()[0] ===
                entry.consumer.track
            )
                delete remote.streams[entry.source];
            this.emit();
        }
    }
    // Media responses, SFU events, and MLS handshakes from the server.
    receiveServer(
        packet: Extract<
            ServerPacket,
            { type: 'media' | 'mls' | 'producer' | 'producer-closed' }
        >
    ) {
        if (packet.type === 'media') {
            const pending = this.requests.get(packet.request);
            if (!pending) return;
            this.requests.delete(packet.request);
            clearTimeout(pending.timer);
            if (packet.error) pending.reject(new Error(packet.error));
            else pending.resolve(packet.data);
            return;
        }
        if (!this.scope || packet.scope !== this.scope) return;
        if (packet.type === 'mls')
            return this.dave?.receive(packet as MlsServerPacket);
        if (packet.type === 'producer')
            return this.enqueue(() => this.consume(packet));
        this.enqueue(async () => this.closeProducer(packet.producer));
    }
    private noiseFallback = () => {
        this.noiseReduction = 'browser';
        this.notify(
            'Enhanced noise reduction is unavailable. Using browser noise reduction.'
        );
        this.emit();
    };
    private syncNoisePreference() {
        const mode = getAudioPreferences().noiseReduction;
        if (mode === this.preferredNoise) return;
        this.preferredNoise = mode;
        const operation = this.operation;
        this.noiseQueue = this.noiseQueue.then(async () => {
            if (
                !this.scope ||
                !this.rawMic ||
                operation !== this.operation ||
                this.preferredNoise !== mode
            )
                return;
            this.noisePending = true;
            this.emit();
            let next: MicrophoneFilter | undefined;
            try {
                next = await processMicrophone(
                    this.rawMic,
                    mode,
                    this.noiseFallback
                );
                if (
                    !this.scope ||
                    operation !== this.operation ||
                    this.preferredNoise !== mode
                ) {
                    next.close();
                    return;
                }
                next.stream.getAudioTracks().forEach((track) => {
                    track.enabled = !this.state.muted && !this.state.deafened;
                });
                await this.replace('mic', next.stream, false);
                if (!this.scope || operation !== this.operation) {
                    next.close();
                    return;
                }
                const previous = this.micFilter;
                this.micFilter = next;
                this.noiseReduction = next.mode;
                this.applyMute();
                previous?.close();
            } catch {
                next?.close();
                if (this.scope)
                    this.notify(
                        'Could not change microphone processing. Try rejoining the call.'
                    );
            } finally {
                if (operation === this.operation) {
                    this.noisePending = false;
                    this.emit();
                }
            }
        });
    }
    sync(members: Peer[]) {
        if (!this.scope) return;
        this.members = members;
        const active = members.filter(
            (p) => p.id !== this.id && p.online && p.call === this.scope
        );
        for (const [id, remote] of this.peers)
            if (!active.some((m) => m.id === id)) {
                for (const { consumer } of remote.consumers.values())
                    consumer.close();
                this.peers.delete(id);
            }
        for (const member of active)
            if (!this.peers.has(member.id)) {
                this.peers.set(member.id, {
                    state: {},
                    streams: {},
                    consumers: new Map(),
                });
                this.send(member.id, {
                    call: this.scope,
                    media: this.state,
                }).catch(() => {});
            }
        this.emit();
    }
    async receive(id: string, payload: Signal) {
        if (
            !this.scope ||
            payload.call !== this.scope ||
            !payload.media ||
            typeof payload.media !== 'object' ||
            !this.members?.some(
                (m) => m.id === id && m.online && m.call === this.scope
            )
        )
            return;
        let remote = this.peers.get(id);
        if (!remote) {
            remote = { state: {}, streams: {}, consumers: new Map() };
            this.peers.set(id, remote);
        }
        remote.state = Object.fromEntries(
            (
                [
                    'muted',
                    'deafened',
                    'camera',
                    'screen',
                    'screenAudio',
                ] as const
            ).map((key) => [key, payload.media![key] === true])
        );
        this.emit();
    }
    publishState() {
        if (!this.scope) return;
        for (const id of this.peers.keys())
            this.send(id, { call: this.scope!, media: this.state }).catch(
                () => {}
            );
        this.emit();
    }
    mute() {
        this.state.muted = !this.state.muted;
        this.applyMute();
        this.publishState();
    }
    deafen() {
        this.state.deafened = !this.state.deafened;
        this.applyMute();
        this.publishState();
    }
    private applyMute() {
        for (const stream of [this.rawMic, this.media.mic])
            stream?.getAudioTracks().forEach((track) => {
                track.enabled = !this.state.muted && !this.state.deafened;
            });
    }
    async replace(
        kind: MediaKind,
        stream: MediaStream | null,
        stopPrevious = true
    ) {
        const previous = this.media[kind];
        const end = () =>
            previous?.getTracks().forEach((track) => track.stop());
        this.media[kind] = stream;
        // Turning a source off ends capture at once, not after the server replies.
        if (!stream && stopPrevious) end();
        this.enqueue(() =>
            this.media[kind] ? this.produce(kind) : this.unproduce(kind)
        );
        await this.tasks;
        if (stream && stopPrevious) end();
    }
    async camera() {
        if (this.cameraPending || !this.scope) return;
        this.cameraPending = true;
        const operation = this.operation;
        try {
            const stream = this.state.camera
                ? null
                : await navigator.mediaDevices.getUserMedia({
                      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
                  });
            if (!this.scope || operation !== this.operation) {
                stream?.getTracks().forEach((t) => t.stop());
                return;
            }
            await this.replace('camera', stream);
            this.state.camera = Boolean(stream);
            this.publishState();
        } catch {
            this.notify(
                'Could not access the camera. Check your browser permissions.'
            );
        } finally {
            this.cameraPending = false;
        }
    }
    async screen(
        withAudio = getAudioPreferences().shareAudio,
        reselect = false,
        devices = navigator.mediaDevices
    ) {
        if (this.screenPending || !this.scope) return;
        if (this.state.screen && !reselect) return this.stopScreen();
        if (!devices?.getDisplayMedia)
            return this.notify(
                'Screen sharing is unavailable in this browser. Try a desktop browser.'
            );
        this.screenPending = true;
        const operation = this.operation;
        try {
            const stream = await devices.getDisplayMedia({
                video: { frameRate: { ideal: 15, max: 30 } },
                audio: withAudio,
            });
            if (!this.scope || operation !== this.operation) {
                stream.getTracks().forEach((t) => t.stop());
                return;
            }
            await this.replace(
                'screen',
                new MediaStream(stream.getVideoTracks())
            );
            if (!this.scope || operation !== this.operation) {
                stream.getTracks().forEach((track) => track.stop());
                return;
            }
            if (stream.getAudioTracks().length)
                await this.replace(
                    'system',
                    new MediaStream(stream.getAudioTracks())
                );
            else await this.replace('system', null);
            if (!this.scope || operation !== this.operation) {
                stream.getTracks().forEach((track) => track.stop());
                return;
            }
            stream.getVideoTracks()[0].onended = () => this.stopScreen();
            this.state.screen = true;
            this.state.screenAudio =
                withAudio && Boolean(stream.getAudioTracks().length);
            if (withAudio && !this.state.screenAudio)
                this.notify(
                    'Your browser did not share audio. Try sharing a browser tab and enabling audio in the browser picker.'
                );
            stream.getAudioTracks().forEach((track) => {
                track.enabled = this.state.screenAudio;
                track.onended = () => {
                    this.state.screenAudio = false;
                    this.publishState();
                };
            });
            this.publishState();
        } catch (error) {
            if (!(
                error instanceof DOMException &&
                error.name === 'NotAllowedError'
            ))
                this.notify(
                    'Screen sharing could not start. Try a desktop browser.'
                );
        } finally {
            this.screenPending = false;
        }
    }
    async stopScreen() {
        await Promise.all([
            this.replace('screen', null),
            this.replace('system', null),
        ]);
        this.state.screen = false;
        this.state.screenAudio = false;
        this.publishState();
    }
    async setScreenAudio(enabled: boolean, devices = navigator.mediaDevices) {
        setAudioPreferences({ shareAudio: enabled });
        if (!this.state.screen) return;
        const tracks =
            this.media.system
                ?.getAudioTracks()
                .filter((track) => track.readyState === 'live') || [];
        if (enabled && tracks.length === 0)
            return this.screen(true, true, devices);
        for (const track of tracks) track.enabled = enabled;
        this.state.screenAudio = enabled && tracks.length > 0;
        this.publishState();
    }
    stop() {
        this.operation++;
        this.unsubscribeAudio?.();
        this.unsubscribeAudio = undefined;
        this.micFilter?.close();
        this.micFilter = undefined;
        this.rawMic?.getTracks().forEach((track) => track.stop());
        this.rawMic = null;
        this.noisePending = false;
        this.scope = null;
        this.dave?.close();
        this.dave = undefined;
        this.sendTransport?.close();
        this.recvTransport?.close();
        this.sendTransport = this.recvTransport = this.device = undefined;
        this.worker?.terminate();
        this.worker = undefined;
        this.producers = {};
        for (const pending of this.requests.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Call ended.'));
        }
        this.requests.clear();
        this.bases.clear();
        this.keyed = new Set();
        this.restarted.clear();
        this.tasks = this.installing = Promise.resolve();
        this.peers.clear();
        for (const stream of Object.values(this.media))
            stream?.getTracks().forEach((track) => track.stop());
        this.media = { mic: null, camera: null, screen: null, system: null };
        this.update(null);
    }
}
