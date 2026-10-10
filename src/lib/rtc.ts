import type {
    CallState,
    MediaKind,
    MediaState,
    Peer,
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
// A small full mesh: media travels browser-to-browser (optionally through TURN).
// SDP, DTLS fingerprints, ICE candidates, and media state use the E2EE channel.
type Connection = {
    pc: RTCPeerConnection;
    polite: boolean;
    makingOffer: boolean;
    ignoreOffer: boolean;
    settingAnswer: boolean;
    candidates: RTCIceCandidateInit[];
    streams: Partial<Record<MediaKind, MediaStream>>;
    senders: Partial<Record<MediaKind, RTCRtpSender>>;
    state: Partial<MediaState>;
    queue: Promise<void>;
    generation: string;
    failTimer?: ReturnType<typeof setTimeout>;
    restarted?: boolean;
};
export class CallEngine {
    peers = new Map<string, Connection>();
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
    constructor(
        public id: string,
        public config: SessionConfig,
        public send: (id: string, payload: Signal) => Promise<void>,
        public update: (call: CallState | null) => void,
        public notify: (message: string) => void
    ) {}
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
                status: p.pc.connectionState,
                streams: p.streams,
            })),
        });
    }
    async join(scope: string, video: boolean) {
        if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection)
            throw new Error(
                'Calling is not supported in this browser. Try a current Chrome, Firefox, or Safari.'
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
        for (const [id, p] of this.peers)
            if (!active.some((m) => m.id === id)) {
                p.pc.close();
                clearTimeout(p.failTimer);
                this.peers.delete(id);
            }
        for (const member of active)
            if (!this.peers.has(member.id)) this.createPeer(member.id);
        this.emit();
    }
    createPeer(id: string) {
        const pc = new RTCPeerConnection({
            iceServers: this.config.iceServers,
            iceTransportPolicy: this.config.relayOnly ? 'relay' : 'all',
        });
        const p: Connection = {
            pc,
            polite: this.id > id,
            makingOffer: false,
            ignoreOffer: false,
            settingAnswer: false,
            candidates: [],
            streams: {},
            senders: {},
            state: {},
            queue: Promise.resolve(),
            generation: crypto.randomUUID(),
        };
        this.peers.set(id, p);
        const kinds: MediaKind[] = ['mic', 'camera', 'screen', 'system'];
        // Only the initial offerer creates slots. Creating slots on both sides
        // before the first offer can duplicate them after an offer rollback.
        if (this.id < id) {
            kinds.forEach((kind, i) => {
                const transceiver = pc.addTransceiver(
                    i === 0 || i === 3 ? 'audio' : 'video',
                    { direction: 'sendrecv' }
                );
                p.senders[kind] = transceiver.sender;
                const track = this.media[kind]?.getTracks()[0];
                if (track) void transceiver.sender.replaceTrack(track);
            });
        }
        const signal = (payload: Omit<Signal, 'call'>) =>
            this.send(id, { ...payload, call: this.scope! }).catch(() => {});
        pc.onnegotiationneeded = async () => {
            try {
                p.makingOffer = true;
                await pc.setLocalDescription();
                await signal({
                    description: pc.localDescription!.toJSON(),
                    media: this.state,
                });
            } catch {
                if (this.scope)
                    this.notify(
                        'Call negotiation failed. Leave the call and try joining again.'
                    );
            } finally {
                p.makingOffer = false;
            }
        };
        pc.onicecandidate = ({ candidate }) => {
            if (candidate) signal({ candidate: candidate.toJSON() });
        };
        pc.ontrack = ({ track, transceiver }) => {
            const kind = kinds[pc.getTransceivers().indexOf(transceiver)];
            if (kind) p.streams[kind] = new MediaStream([track]);
            track.onunmute = () => this.emit();
            this.emit();
        };
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'failed') {
                if (!p.restarted) {
                    p.restarted = true;
                    pc.restartIce();
                } else
                    this.notify(
                        'A call connection failed. Configure a TURN relay if participants are on restrictive networks.'
                    );
            }
            if (pc.connectionState === 'disconnected') {
                clearTimeout(p.failTimer);
                p.failTimer = setTimeout(() => {
                    if (pc.connectionState === 'disconnected') pc.restartIce();
                }, 4000);
            }
            this.emit();
        };
        return p;
    }
    async receive(id: string, payload: Signal) {
        if (
            !this.scope ||
            payload.call !== this.scope ||
            !this.members?.some(
                (m) => m.id === id && m.online && m.call === this.scope
            )
        )
            return;
        const p = this.peers.get(id) || this.createPeer(id);
        p.queue = p.queue
            .then(async () => {
                if (p.pc.signalingState === 'closed') return;
                if (payload.media && typeof payload.media === 'object') {
                    p.state = Object.fromEntries(
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
                if (payload.description) {
                    const description = payload.description;
                    if (
                        !['offer', 'answer'].includes(description.type) ||
                        typeof description.sdp !== 'string' ||
                        description.sdp.length > 80_000
                    )
                        return;
                    const ready =
                        !p.makingOffer &&
                        (p.pc.signalingState === 'stable' || p.settingAnswer);
                    p.ignoreOffer =
                        !p.polite && description.type === 'offer' && !ready;
                    if (p.ignoreOffer) {
                        p.candidates = [];
                        return;
                    }
                    p.settingAnswer = description.type === 'answer';
                    await p.pc.setRemoteDescription(description);
                    p.settingAnswer = false;
                    const kinds: MediaKind[] = [
                        'mic',
                        'camera',
                        'screen',
                        'system',
                    ];
                    await Promise.all(
                        p.pc
                            .getTransceivers()
                            .map(async (transceiver, index) => {
                                const kind = kinds[index];
                                if (!kind) return;
                                p.senders[kind] = transceiver.sender;
                                transceiver.direction = 'sendrecv';
                                await transceiver.sender.replaceTrack(
                                    this.media[kind]?.getTracks()[0] || null
                                );
                                p.streams[kind] = new MediaStream([
                                    transceiver.receiver.track,
                                ]);
                            })
                    );
                    this.emit();
                    for (const candidate of p.candidates.splice(0))
                        await p.pc.addIceCandidate(candidate);
                    if (description.type === 'offer') {
                        await p.pc.setLocalDescription();
                        await this.send(id, {
                            call: this.scope!,
                            description: p.pc.localDescription!.toJSON(),
                            media: this.state,
                        });
                    }
                } else if (payload.candidate && !p.ignoreOffer) {
                    if (p.pc.remoteDescription)
                        await p.pc.addIceCandidate(payload.candidate);
                    else if (p.candidates.length < 64)
                        p.candidates.push(payload.candidate);
                }
            })
            .catch(() => {
                if (this.scope)
                    this.notify(
                        'A call connection could not be established. Try rejoining the call.'
                    );
            });
        await p.queue;
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
        this.media[kind] = stream;
        await Promise.allSettled(
            Array.from(this.peers.values(), (p) =>
                p.senders[kind]?.replaceTrack(stream?.getTracks()[0] || null)
            )
        );
        if (stopPrevious)
            previous?.getTracks().forEach((track) => track.stop());
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
        await this.replace('screen', null);
        await this.replace('system', null);
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
        for (const p of this.peers.values()) {
            p.pc.close();
            clearTimeout(p.failTimer);
        }
        this.peers.clear();
        for (const stream of Object.values(this.media))
            stream?.getTracks().forEach((track) => track.stop());
        this.media = { mic: null, camera: null, screen: null, system: null };
        this.update(null);
    }
}
