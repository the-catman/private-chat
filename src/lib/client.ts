import type {
    ChatState,
    ClientPacket,
    Content,
    Envelope,
    Identity,
    ServerPacket,
    SessionConfig,
    Signal,
    Message,
    CallState,
    PrekeyBundle,
} from '../types';
import type { SoundCue } from './sounds';
import {
    loadIdentity,
    seal,
    open,
    sign,
    proofText,
    dmScope,
    contentKey,
    openWithKey,
    grantRecipient,
    messageId,
    partKey,
    sealPart,
    openPart,
    readPart,
    b64,
    unb64,
} from './crypto.ts';
import {
    normalizeName,
    MAX_BATCH,
    PART_BYTES,
    AUTO_FETCH_BYTES,
    PROTOCOL,
} from './limits.ts';
import { validateContent } from './content.ts';
import { replaceEmoji } from './emoji.ts';
import { CallEngine } from './rtc.ts';
import {
    Ratchet,
    RatchetError,
    browserStorage,
    claimStorage,
} from './signal.ts';

const initial = (): ChatState => ({
    phase: 'loading',
    name: '',
    self: null,
    peers: [],
    messages: [],
    presence: [],
    scope: 'room',
    error: '',
    notice: '',
    typing: {},
    unread: {},
    config: null,
    call: null,
});

export class ChatClient {
    constructor(private readonly sound: (cue: SoundCue) => void = () => {}) {}
    private liveHistory = false;
    private cue(cue: SoundCue) {
        if (!this.state.call?.deafened) this.sound(cue);
    }
    private setCall = (call: CallState | null) => {
        const previous = this.state.call;
        this.update({ call });
        if (call && !previous) this.cue('call-join');
        else if (!call && previous && !previous.deafened)
            this.cue('call-leave');
        else if (call && previous) {
            if (call.deafened !== previous.deafened)
                this.sound(call.deafened ? 'off' : 'on');
            else if (call.muted !== previous.muted)
                this.cue(call.muted ? 'off' : 'on');
            else if (call.camera !== previous.camera)
                this.cue(call.camera ? 'on' : 'off');
            else if (call.screen !== previous.screen)
                this.cue(call.screen ? 'on' : 'off');
            else if (
                call.peers.some(
                    (peer) =>
                        peer.status === 'connected' &&
                        !previous.peers.some(
                            (old) =>
                                old.id === peer.id && old.status === 'connected'
                        )
                )
            )
                this.cue('join');
            else if (
                previous.peers.some(
                    (peer) => !call.peers.some((next) => next.id === peer.id)
                )
            )
                this.cue('leave');
        }
    };
    state = initial();
    listeners = new Set<() => void>();
    identity!: Identity;
    rtc?: CallEngine;
    ws?: WebSocket;
    queue: Promise<void> = Promise.resolve();
    retryTimer?: ReturnType<typeof setTimeout>;
    noticeTimer?: ReturnType<typeof setTimeout>;
    typingTimer?: ReturnType<typeof setTimeout>;
    lastTyping = 0;
    pending = new Map<string, Envelope>();
    private confirmations = new Map<
        string,
        {
            resolve: () => void;
            reject: (error: Error) => void;
            timer: ReturnType<typeof setTimeout>;
        }
    >();
    seen = new Set<string>();
    private clears = new Map<string, string>();
    // Keys for received files, so parts can be fetched when someone opens one.
    private files = new Map<
        string,
        { key: CryptoKey; envelope: Envelope; hashes: string[] }
    >();
    // Downloaded bytes survive a reconnect if the same message is replayed.
    private held = new Map<string, Uint8Array<ArrayBuffer>>();
    // Files arrive as a signed message, then its parts once requested.
    private incoming = new Map<
        string,
        {
            key: CryptoKey;
            envelope: Envelope;
            hashes: string[];
            bytes: Uint8Array<ArrayBuffer>;
            received: number;
        }
    >();
    // Uploads run one at a time, each with a small window of unacked parts.
    private uploads: Promise<void> = Promise.resolve();
    private uploading = new Map<string, { acked: number; wake: () => void }>();
    // Signal sessions for the current server boot, owned by one tab at a time.
    private keys?: { boot: string; ratchet: Ratchet };
    private owner?: Promise<() => boolean>;
    private bundles = new Map<
        number,
        {
            resolve: (bundle: PrekeyBundle) => void;
            reject: (error: Error) => void;
            timer: ReturnType<typeof setTimeout>;
        }
    >();
    private bundleRequest = 0;
    private rekeyed = new Map<string, number>();
    retryCount = 0;
    stopped = false;
    private joiningCall = false;
    getSnapshot = () => this.state;
    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };
    update = (patch: Partial<ChatState>) => {
        this.state = { ...this.state, ...patch };
        for (const listener of this.listeners) listener();
    };
    notify = (message: string) => {
        this.update({ notice: message });
        clearTimeout(this.noticeTimer);
        this.noticeTimer = setTimeout(() => this.update({ notice: '' }), 6500);
    };

    async request<T = SessionConfig>(path: string, data?: unknown): Promise<T> {
        const response = await fetch(`/api/${path}`, {
            method: data ? 'POST' : 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
            ...(data
                ? {
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(data),
                  }
                : {}),
        });
        const result = await response.json();
        if (!response.ok) {
            const error = new ApiError(
                result.error || 'Could not reach the server.',
                response.status
            );
            throw error;
        }
        return result;
    }
    async resume() {
        if (
            location.protocol !== 'https:' ||
            !globalThis.isSecureContext ||
            !crypto.subtle
        ) {
            this.update({
                phase: 'login',
                error: 'Open Hush at its HTTPS address. A secure connection is required.',
            });
            return;
        }
        try {
            const name = localStorage.getItem('hush-name');
            const config = await this.request('session');
            if (!name) return this.update({ phase: 'login' });
            await this.start(name, config);
        } catch {
            this.update({ phase: 'login' });
        }
    }
    async login(name: string, password: string) {
        this.update({ phase: 'joining', error: '' });
        try {
            await this.request('login', { password });
            await this.start(
                normalizeName(name),
                await this.request('session')
            );
        } catch (error) {
            this.update({
                phase: 'login',
                error:
                    error instanceof Error
                        ? error.message
                        : 'Something went wrong. Please try again.',
            });
        }
    }
    private outdated(config: SessionConfig) {
        if (config.protocol === PROTOCOL) return false;
        this.update({
            phase: 'login',
            error: 'Hush was updated. Restart the server, then reload this page.',
        });
        return true;
    }
    async start(name: string, config: SessionConfig) {
        this.stopped = false;
        if (this.outdated(config)) return;
        if (this.state.config?.boot !== config.boot) {
            this.pending.clear();
            this.seen.clear();
            this.update({ messages: [], presence: [] });
        }
        this.identity = await (navigator.locks
            ? navigator.locks.request('hush-identity', loadIdentity)
            : loadIdentity());
        this.update({
            phase: 'joining',
            name: normalizeName(name),
            config,
            self: this.identity.id,
            error: '',
        });
        this.rtc = new CallEngine(
            this.identity,
            config,
            (packet) => this.wire(packet),
            (id, payload) => this.signal(id, payload),
            this.setCall,
            this.notify
        );
        this.connect();
    }
    connect() {
        this.liveHistory = false;
        clearTimeout(this.retryTimer);
        this.queue = Promise.resolve();
        this.incoming.clear();
        const ws = new WebSocket(
            `${location.origin.replace(/^https:/, 'wss:')}/ws`
        );
        ws.binaryType = 'arraybuffer';
        this.ws = ws;
        ws.onmessage = (event) => {
            let packet: ServerPacket | undefined;
            if (typeof event.data === 'string') {
                try {
                    packet = JSON.parse(event.data) as ServerPacket;
                } catch {
                    return;
                }
                // A message waiting on these keys may be holding the queue.
                if (packet.type === 'bundle') return this.answer(packet);
            }
            this.queue = this.queue
                .then(async () => {
                    if (this.ws !== ws || this.stopped) return;
                    if (event.data instanceof ArrayBuffer)
                        return this.receivePart(new Uint8Array(event.data));
                    await this.receive(packet!);
                })
                .catch((error) =>
                    this.notify(
                        error instanceof RatchetError
                            ? 'A message could not be decrypted in this browser. New messages will still arrive.'
                            : 'An encrypted message could not be verified. It was not displayed.'
                    )
                );
        };
        ws.onclose = (event) => {
            this.wakeUploads();
            if (this.ws !== ws) return;
            for (const request of this.bundles.keys())
                this.answer({
                    type: 'bundle',
                    request,
                    error: 'Connection lost.',
                });
            if (this.stopped) return;
            this.cancelConfirmations(
                'Connection lost. Reconnect to check the latest messages.'
            );
            this.rtc?.stop();
            if ([1008, 4001, 4004, 4009].includes(event.code)) {
                this.update({
                    phase: 'login',
                    error:
                        event.reason ||
                        'Your session ended. Please sign in again.',
                    messages: [],
                    peers: [],
                    call: null,
                });
                this.pending.clear();
                this.seen.clear();
                return;
            }
            this.update({ phase: 'reconnecting', call: null });
            this.retryTimer = setTimeout(
                async () => {
                    try {
                        const config = await this.request('session');
                        if (this.outdated(config)) return;
                        if (config.boot !== this.state.config!.boot) {
                            this.update({ messages: [] });
                            this.pending.clear();
                            this.seen.clear();
                        }
                        this.update({ config });
                        this.connect();
                    } catch (error) {
                        if (
                            (error instanceof ApiError && error.status) === 401
                        ) {
                            this.update({
                                phase: 'login',
                                error: 'The server restarted or your session expired. Please sign in again.',
                                messages: [],
                                peers: [],
                            });
                            this.pending.clear();
                            this.seen.clear();
                        } else this.connect();
                    }
                },
                Math.min(15000, 1000 * 2 ** this.retryCount++) +
                    Math.random() * 500
            );
        };
    }
    wire(packet: ClientPacket) {
        if (this.stopped || this.ws?.readyState !== WebSocket.OPEN)
            throw new Error('Reconnecting. Your draft is safe in this tab.');
        this.ws.send(JSON.stringify(packet));
    }
    // Signal state lasts for one server boot and lives in one tab at a time.
    private async useRatchet(boot: string) {
        let owner = await this.owner;
        // After another tab took over, reload its newer state before sealing.
        const stolen = owner && !owner();
        if (!owner || stolen) owner = await (this.owner = claimStorage());
        if (stolen || this.keys?.boot !== boot)
            this.keys = {
                boot,
                ratchet: await new Ratchet(
                    this.identity,
                    await browserStorage(boot, owner)
                ).load(),
            };
        this.keys.ratchet.fetch = (id) => this.bundle(id);
        this.identity.ratchet = this.keys.ratchet;
    }
    private bundle(id: string) {
        return new Promise<PrekeyBundle>((resolve, reject) => {
            const request = ++this.bundleRequest;
            const timer = setTimeout(
                () =>
                    this.answer({
                        type: 'bundle',
                        request,
                        error: 'Could not reach this person’s keys. Try again.',
                    }),
                10_000
            );
            this.bundles.set(request, { resolve, reject, timer });
            try {
                this.wire({ type: 'bundle', request, id });
            } catch (error) {
                this.answer({
                    type: 'bundle',
                    request,
                    error:
                        error instanceof Error
                            ? error.message
                            : 'Not connected.',
                });
            }
        });
    }
    private answer(packet: Extract<ServerPacket, { type: 'bundle' }>) {
        const pending = this.bundles.get(packet.request);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.bundles.delete(packet.request);
        if (packet.bundle) pending.resolve(packet.bundle);
        else pending.reject(new Error(packet.error || 'No keys available.'));
    }
    // A lost session heals with a new X3DH; the empty signal moves the peer to it.
    private async rekey(id: string) {
        if (Date.now() - (this.rekeyed.get(id) || 0) < 30_000) return;
        this.rekeyed.set(id, Date.now());
        const peer = this.state.peers.find((p) => p.id === id);
        if (!peer?.online) return;
        try {
            await this.identity.ratchet.restart(peer);
            await this.signal(id, { rekey: true });
        } catch {}
    }
    wirePart(frame: Uint8Array<ArrayBuffer>) {
        if (this.stopped || this.ws?.readyState !== WebSocket.OPEN)
            throw new Error('Reconnecting. Your file will resume.');
        this.ws.send(frame);
    }
    async receive(packet: ServerPacket) {
        if (
            packet.type === 'media' ||
            packet.type === 'mls' ||
            packet.type === 'producer' ||
            packet.type === 'producer-closed'
        )
            return this.rtc?.receiveServer(packet);
        const socket = this.ws;
        const boot = this.state.config?.boot;
        const contentScope =
            packet.type === 'message' &&
            !['signal', 'typing'].includes(packet.envelope.type)
                ? packet.envelope.scope
                : undefined;
        const clearMarker = contentScope && this.clears.get(contentScope);
        const current = () =>
            !this.stopped &&
            this.ws === socket &&
            this.state.config?.boot === boot &&
            (!contentScope || this.clears.get(contentScope) === clearMarker);
        if (packet.type === 'challenge') {
            if (packet.boot !== this.state.config!.boot)
                throw new Error('The server restarted.');
            await this.useRatchet(packet.boot);
            const [signature, prekeys] = await Promise.all([
                sign(
                    this.identity,
                    proofText(
                        location.origin,
                        packet.boot,
                        packet.nonce,
                        this.identity.id,
                        this.state.name
                    )
                ),
                this.identity.ratchet.publish(20),
            ]);
            if (!current()) return;
            return this.wire({
                type: 'join',
                id: this.identity.id,
                bundle: this.identity.bundle,
                name: this.state.name,
                sig: signature,
                prekeys,
            });
        }
        if (packet.type === 'prekeys') {
            const prekeys = await this.identity.ratchet.publish(20);
            if (current()) this.wire({ type: 'prekeys', ...prekeys });
            return;
        }
        if (packet.type === 'ready') {
            this.liveHistory = false;
            this.retryCount = 0;
            localStorage.setItem('hush-name', this.state.name);
            this.seen.clear();
            this.incoming.clear();
            this.files.clear();
            this.held.clear();
            for (const m of this.state.messages)
                if (m.bytes && !this.pending.has(m.id))
                    this.held.set(m.envelope.id, m.bytes);
            // Rebuild from the server's current ciphertext, including offline deletions.
            this.update({
                phase: 'online',
                peers: packet.peers,
                messages: this.state.messages.filter((m) =>
                    this.pending.has(m.id)
                ),
                unread: {},
                typing: {},
            });
            return;
        }
        if (packet.type === 'presence') {
            if (this.liveHistory && packet.event.userId !== this.state.self)
                this.cue(packet.event.action === 'joined' ? 'join' : 'leave');
            this.update({
                presence: [...this.state.presence, packet.event].slice(-200),
            });
            if (
                packet.event.userId !== this.state.self &&
                this.state.scope !== 'room'
            )
                this.notify(
                    `${packet.event.name} ${packet.event.action} the room.`
                );
            return;
        }
        if (packet.type === 'cleared') {
            const marker = `${boot}:${packet.id}`;
            if (this.clears.get(packet.scope) === marker) return;
            this.clears.set(packet.scope, marker);
            this.identity.ratchet.forgetScope(packet.scope);
            for (const [id, envelope] of this.pending) {
                if (envelope.scope !== packet.scope) continue;
                this.pending.delete(id);
                this.confirm(id, new Error('This conversation was cleared.'));
            }
            for (const map of [this.incoming, this.files])
                for (const [id, item] of map)
                    if (item.envelope.scope === packet.scope) map.delete(id);
            this.wakeUploads();
            this.update({
                messages: this.state.messages.filter(
                    (m) => m.scope !== packet.scope
                ),
                presence: packet.scope === 'room' ? [] : this.state.presence,
                unread: { ...this.state.unread, [packet.scope]: 0 },
                typing: Object.fromEntries(
                    Object.entries(this.state.typing).filter(
                        ([key]) => !key.startsWith(`${packet.scope}:`)
                    )
                ),
            });
            if (this.liveHistory) {
                const name =
                    packet.by === this.state.self
                        ? 'You'
                        : this.state.peers.find((p) => p.id === packet.by)
                              ?.name || 'A member';
                this.notify(
                    `${name} cleared ${packet.scope === 'room' ? 'the room' : 'your direct messages'} for everyone.`
                );
            }
            return;
        }
        if (packet.type === 'access') {
            const message = this.state.messages.find((m) => m.id === packet.id);
            const sharer = this.state.peers.find(
                (p) => p.id === packet.grant.from
            );
            if (message && sharer) {
                const id = await grantRecipient(
                    message.envelope,
                    packet.grant,
                    sharer,
                    new Set(message.audience)
                );
                if (!current()) return;
                this.update({
                    messages: this.state.messages.map((m) =>
                        m.id === message.id
                            ? {
                                  ...m,
                                  audience: [...new Set([...m.audience, id])],
                              }
                            : m
                    ),
                });
            }
            return;
        }
        if (packet.type === 'peers') {
            if (
                this.liveHistory &&
                !this.state.call &&
                packet.peers.some(
                    (peer) =>
                        peer.id !== this.state.self &&
                        peer.call === dmScope(this.state.self!, peer.id) &&
                        this.state.peers.find((old) => old.id === peer.id)
                            ?.call !== peer.call
                )
            )
                this.cue('ring');
            this.update({ peers: packet.peers });
            this.rtc?.sync(packet.peers);
            return;
        }
        if (packet.type === 'history-end') {
            this.liveHistory = true;
            this.held.clear();
            for (const envelope of this.pending.values())
                if (envelope.boot === this.state.config!.boot)
                    this.transmit(envelope);
            return;
        }
        if (packet.type === 'progress') {
            const upload = this.uploading.get(packet.id);
            if (upload) {
                upload.acked = Math.max(upload.acked, packet.parts);
                upload.wake();
            }
            const parts = this.pending.get(packet.id)?.parts;
            if (parts) this.progress(packet.id, packet.parts / parts);
            return;
        }
        if (packet.type === 'ack') {
            if (!packet.deleted && this.pending.get(packet.id)?.type === 'chat')
                this.cue('sent');
            this.pending.delete(packet.id);
            this.confirm(packet.id);
            this.wakeUploads();
            this.update({
                messages: this.state.messages
                    .filter((m) => !packet.deleted || m.id !== packet.id)
                    .map((m) =>
                        m.id === packet.id
                            ? { ...m, status: 'sent', progress: undefined }
                            : m
                    ),
            });
            return;
        }
        if (packet.type === 'error') {
            if (this.incoming.has(packet.id) && !this.pending.has(packet.id)) {
                this.incoming.delete(packet.id);
                this.patch(packet.id, {
                    progress: undefined,
                    unavailable: true,
                });
                return this.notify(packet.message);
            }
            this.confirm(packet.id, new Error(packet.message));
            if (this.pending.get(packet.id)?.type !== 'chat')
                this.pending.delete(packet.id);
            this.update({
                messages: this.state.messages.map((m) =>
                    m.id === packet.id
                        ? { ...m, status: 'failed', progress: undefined }
                        : m
                ),
            });
            this.wakeUploads();
            this.notify(packet.message);
            return;
        }
        if (packet.type !== 'message') return;
        const m = packet.envelope;
        if (this.seen.has(m.id)) return;
        const sender = this.state.peers.find((p) => p.id === m.from);
        if (!sender) throw new Error('Unknown sender.');
        let parts: CryptoKey | undefined;
        let decrypted: unknown;
        const session = this.state.config!.boot;
        const key = await contentKey(this.identity, sender, session, m).catch(
            (error) => {
                if (error instanceof RatchetError) void this.rekey(sender.id);
                throw error;
            }
        );
        try {
            decrypted = await openWithKey(sender, session, m, key);
            if (m.type === 'chat' && m.parts) parts = await partKey(key);
        } finally {
            key.fill(0);
        }
        if (!current()) {
            // Keep the key for a replay after a reconnect, but not after a clear.
            if (contentScope && this.clears.get(contentScope) !== clearMarker)
                this.identity.ratchet.forget([m.id]);
            return;
        }
        if (!decrypted || typeof decrypted !== 'object')
            throw new Error('Invalid payload.');
        this.seen.add(m.id);
        if (this.seen.size > 14000)
            this.seen.delete(this.seen.values().next().value!);
        if (m.type === 'signal') {
            // Opening a rekey signal already moved to the new session.
            if ('rekey' in decrypted) return;
            return this.rtc?.receive(m.from, decrypted as Signal);
        }
        if (m.type === 'typing') {
            this.update({
                typing: {
                    ...this.state.typing,
                    [`${m.scope}:${m.from}`]: Date.now() + 3500,
                },
            });
            clearTimeout(this.typingTimer);
            this.typingTimer = setTimeout(
                () =>
                    this.update({
                        typing: Object.fromEntries(
                            Object.entries(this.state.typing).filter(
                                ([, time]) => time > Date.now()
                            )
                        ),
                    }),
                3600
            );
            return;
        }
        if (m.type === 'delete') {
            if ((decrypted as { kind?: string }).kind !== 'delete')
                throw new Error('Invalid deletion.');
            for (const id of m.targets || []) {
                this.incoming.delete(id);
                this.files.delete(id);
            }
            const removed = (item: Message) =>
                m.targets?.includes(item.id) &&
                item.from === m.from &&
                item.scope === m.scope;
            this.identity.ratchet.forget(
                this.state.messages
                    .filter(removed)
                    .flatMap((item) => [
                        item.id,
                        item.envelope.id,
                        item.historyGrant?.id ?? '',
                    ])
            );
            this.update({
                messages: this.state.messages.filter((item) => !removed(item)),
            });
            return;
        }
        let envelope = m;
        let contents = decrypted;
        let sharedBy: string | undefined;
        if (m.type === 'share') {
            if (!packet.source) throw new Error('Missing original message.');
            envelope = packet.source.envelope;
        }
        const audience = new Set(Object.keys(envelope.keys));
        // Each signed grant extends a chain rooted in the original recipients.
        // Never trust a relay-supplied recipient list when encrypting an edit.
        for (const grant of packet.grants || []) {
            const sharer = this.state.peers.find((p) => p.id === grant.from);
            if (!sharer) throw new Error('Unknown history sender.');
            audience.add(
                await grantRecipient(envelope, grant, sharer, audience)
            );
            if (!current()) return;
        }
        if (m.type === 'share') {
            if (
                (await grantRecipient(envelope, m, sender, audience)) !==
                this.identity.id
            )
                throw new Error(
                    'This history invitation is for another browser.'
                );
            if (!current()) return;
            const grant = decrypted as { kind: string; key: string };
            if (
                grant.kind !== 'history' ||
                typeof grant.key !== 'string' ||
                grant.key.length !== 43
            )
                throw new Error('Invalid history invitation.');
            const author = this.state.peers.find((p) => p.id === envelope.from);
            if (!author) throw new Error('Unknown author.');
            const raw = unb64(grant.key);
            try {
                contents = await openWithKey(
                    author,
                    this.state.config!.boot,
                    envelope,
                    raw
                );
                if (envelope.parts) parts = await partKey(raw);
            } finally {
                raw.fill(0);
            }
            sharedBy = sender.name;
        }
        if (!current()) return;
        const payload = validateContent(contents);
        if (
            payload.kind === 'file'
                ? payload.hashes.length !== envelope.parts || !parts
                : envelope.parts !== undefined
        )
            throw new Error('Invalid file message.');
        const id = messageId(envelope);
        const existing = this.state.messages.find((item) => item.id === id);
        if (existing && existing.from !== envelope.from)
            throw new Error('Message author changed.');
        // An edit replaces the earlier revision and its history grants.
        if (existing && existing.envelope.id !== envelope.id)
            this.identity.ratchet.forget([
                existing.envelope.id,
                existing.historyGrant?.id ?? '',
            ]);
        let bytes: Uint8Array<ArrayBuffer> | undefined;
        if (payload.kind === 'file') {
            // Reuse bytes already downloaded or uploaded for this exact message.
            bytes =
                existing?.envelope.id === envelope.id && existing.bytes
                    ? existing.bytes
                    : this.held.get(envelope.id);
            this.files.set(id, {
                key: parts!,
                envelope,
                hashes: payload.hashes,
            });
        }
        const message: Message = {
            id,
            from: envelope.from,
            name: this.state.peers.find((p) => p.id === envelope.from)!.name,
            scope: envelope.scope,
            time: packet.source?.received ?? packet.received,
            payload,
            status: 'sent',
            envelope,
            audience: [...audience],
            edited: envelope.type === 'edit',
            sharedBy,
            historyGrant: m.type === 'share' ? m : undefined,
            bytes,
        };
        const messages = this.state.messages.filter((item) => item.id !== id);
        messages.push(message);
        messages.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
        const unread = { ...this.state.unread };
        if (
            !existing &&
            message.scope !== this.state.scope &&
            message.from !== this.identity.id
        )
            unread[message.scope] = (unread[message.scope] || 0) + 1;
        this.update({ messages, unread });
        if (
            payload.kind === 'file' &&
            !bytes &&
            payload.size <= AUTO_FETCH_BYTES
        )
            this.fetchFile(id);
        if (
            this.liveHistory &&
            m.type === 'chat' &&
            !existing &&
            message.from !== this.identity.id
        )
            this.cue('received');
    }

    fetchFile(id: string) {
        const file = this.files.get(id);
        const message = this.state.messages.find((m) => m.id === id);
        if (!file || !message || message.bytes || this.incoming.has(id)) return;
        if (message.payload.kind !== 'file') return;
        this.incoming.set(id, {
            ...file,
            bytes: new Uint8Array(message.payload.size),
            received: 0,
        });
        this.patch(id, { progress: 0, unavailable: false });
        try {
            this.wire({ type: 'fetch', id });
        } catch (error) {
            this.incoming.delete(id);
            this.patch(id, { progress: undefined });
            this.notify(
                error instanceof Error ? error.message : 'Not connected.'
            );
        }
    }
    private async receivePart(frame: Uint8Array<ArrayBuffer>) {
        const { id, index, data } = readPart(frame);
        const item = this.incoming.get(id);
        if (!item) return;
        let bytes: Uint8Array<ArrayBuffer>;
        try {
            if (index !== item.received || index >= item.hashes.length)
                throw new Error('File parts arrived out of order.');
            bytes = await openPart(
                item.key,
                item.envelope,
                index,
                data,
                item.hashes[index]
            );
            if (
                bytes.length !==
                Math.min(PART_BYTES, item.bytes.length - index * PART_BYTES)
            )
                throw new Error('A file part has the wrong size.');
        } catch (error) {
            if (this.incoming.get(id) === item) {
                this.incoming.delete(id);
                this.patch(id, { progress: undefined, unavailable: true });
            }
            throw error;
        }
        if (this.incoming.get(id) !== item || this.stopped) return;
        item.bytes.set(bytes, index * PART_BYTES);
        if (++item.received < item.hashes.length)
            return this.progress(id, item.received / item.hashes.length);
        this.incoming.delete(id);
        this.patch(id, { bytes: item.bytes, progress: undefined });
    }
    private patch(id: string, patch: Partial<Message>) {
        this.update({
            messages: this.state.messages.map((m) =>
                m.id === id ? { ...m, ...patch } : m
            ),
        });
    }
    private progress(id: string, value: number) {
        // Re-render at most once per percent, not once per part.
        const message = this.state.messages.find((m) => m.id === id);
        if (
            message?.progress !== undefined &&
            Math.floor(message.progress * 100) !== Math.floor(value * 100)
        )
            this.patch(id, { progress: value });
    }
    private wakeUploads() {
        for (const upload of this.uploading.values()) upload.wake();
    }
    private transmit(envelope: Envelope) {
        if (!envelope.parts) return this.wire({ type: 'envelope', envelope });
        const socket = this.ws;
        this.uploads = this.uploads
            .then(() => this.upload(envelope, socket))
            .catch(() => {});
    }
    private async upload(envelope: Envelope, socket?: WebSocket) {
        const id = envelope.id;
        const total = envelope.parts!;
        const live = () =>
            !this.stopped &&
            this.ws === socket &&
            socket?.readyState === WebSocket.OPEN &&
            this.pending.get(id) === envelope &&
            this.state.messages.some(
                (m) => m.id === id && m.status === 'sending'
            );
        const bytes = this.state.messages.find((m) => m.id === id)?.bytes;
        if (!live() || !bytes) return;
        const raw = await contentKey(
            this.identity,
            this.identity,
            this.state.config!.boot,
            envelope
        );
        let key: CryptoKey;
        try {
            key = await partKey(raw);
        } finally {
            raw.fill(0);
        }
        const upload = { acked: 0, wake: () => {} };
        const acked = () =>
            new Promise<void>((resolve) => {
                upload.wake = resolve;
            });
        this.uploading.set(id, upload);
        try {
            if (!live()) return;
            this.wire({ type: 'envelope', envelope });
            for (let index = 0; index < total; index++) {
                while (live() && index - upload.acked >= 8) await acked();
                if (!live()) return;
                const part = await sealPart(
                    key,
                    envelope,
                    index,
                    bytes.subarray(index * PART_BYTES, (index + 1) * PART_BYTES)
                );
                if (!live()) return;
                this.wirePart(part);
            }
            // Finish before the next upload starts so both stay within the window.
            while (live()) await acked();
        } finally {
            if (this.uploading.get(id) === upload) this.uploading.delete(id);
        }
    }

    private confirm(id: string, error?: Error) {
        const pending = this.confirmations.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.confirmations.delete(id);
        if (error) pending.reject(error);
        else pending.resolve();
    }
    private cancelConfirmations(reason: string) {
        for (const id of this.confirmations.keys()) {
            this.confirm(id, new Error(reason));
            if (this.pending.get(id)?.type !== 'chat') this.pending.delete(id);
        }
    }
    private commit(envelope: Envelope) {
        if (
            this.stopped ||
            this.state.phase !== 'online' ||
            this.state.config?.boot !== envelope.boot ||
            this.state.self !== envelope.from
        )
            return Promise.reject(
                new Error('Your connection changed. Please try again.')
            );
        this.pending.set(envelope.id, envelope);
        return this.confirmed({ type: 'envelope', envelope }, envelope.id);
    }
    async clearConversation(scope: string) {
        if (this.state.phase !== 'online')
            throw new Error('Wait until you are connected.');
        const id = crypto.randomUUID();
        await this.confirmed({ type: 'clear', id, scope }, id);
    }
    private confirmed(packet: ClientPacket, id: string) {
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.confirm(
                    id,
                    new Error(
                        'Could not confirm this change. Reconnect to check its status.'
                    )
                );
                this.pending.delete(id);
            }, 30_000);
            this.confirmations.set(id, { resolve, reject, timer });
            try {
                this.wire(packet);
            } catch (error) {
                this.pending.delete(id);
                this.confirm(
                    id,
                    error instanceof Error ? error : new Error('Not connected.')
                );
            }
        });
    }
    private audience(ids: string[]) {
        if (this.state.phase !== 'online')
            throw new Error('Wait until you are connected.');
        return [...new Set(ids)].map((id) => {
            const peer = this.state.peers.find((p) => p.id === id);
            if (!peer) throw new Error('A recipient is no longer available.');
            return peer;
        });
    }
    async edit(id: string, text: string) {
        const message = this.state.messages.find((m) => m.id === id);
        if (
            !message ||
            message.from !== this.identity.id ||
            message.payload.kind !== 'text' ||
            message.status !== 'sent'
        )
            throw new Error('Choose one of your sent text messages to edit.');
        const payload = validateContent({
            kind: 'text',
            text: replaceEmoji(text.trim()),
        });
        if (!text.trim())
            throw new Error('Use Delete to remove an empty message.');
        await this.commit(
            await seal(
                this.identity,
                this.audience(message.audience),
                this.state.config!.boot,
                message.scope,
                'edit',
                payload,
                { targets: [id], revision: message.envelope.id }
            )
        );
    }
    async deleteMessages(ids: string[]) {
        const messages = ids.map((id) =>
            this.state.messages.find((m) => m.id === id)
        );
        if (
            !ids.length ||
            ids.length > MAX_BATCH ||
            messages.some(
                (m) =>
                    !m ||
                    m.from !== this.identity.id ||
                    m.status !== 'sent' ||
                    m.scope !== messages[0]!.scope
            )
        )
            throw new Error(
                'Select up to 100 of your sent messages from one conversation.'
            );
        await this.commit(
            await seal(
                this.identity,
                this.audience(messages.flatMap((m) => m!.audience)),
                this.state.config!.boot,
                messages[0]!.scope,
                'delete',
                { kind: 'delete' },
                { targets: ids }
            )
        );
    }
    async shareHistory(
        ids: string[],
        recipientId: string,
        progress: (sent: number) => void
    ) {
        const recipient = this.state.peers.find(
            (p) => p.id === recipientId && p.online && p.id !== this.identity.id
        );
        if (!recipient || !ids.length || ids.length > MAX_BATCH)
            throw new Error('Choose an online person and up to 100 messages.');
        let sent = 0;
        for (const id of ids) {
            const message = this.state.messages.find((m) => m.id === id);
            if (
                !message ||
                message.scope !== 'room' ||
                (!message.envelope.keys[this.identity.id] &&
                    !message.historyGrant) ||
                message.status !== 'sent'
            )
                throw new Error(
                    `Shared ${sent} messages. A selected message is no longer available to share.`
                );
            if (!message.audience.includes(recipientId)) {
                const author = this.state.peers.find(
                    (p) => p.id === message.from
                )!;
                const raw = message.envelope.keys[this.identity.id]
                    ? await contentKey(
                          this.identity,
                          author,
                          this.state.config!.boot,
                          message.envelope
                      )
                    : unb64(
                          (
                              await open<{ key: string }>(
                                  this.identity,
                                  this.state.peers.find(
                                      (p) => p.id === message.historyGrant!.from
                                  )!,
                                  this.state.config!.boot,
                                  message.historyGrant!
                              )
                          ).key
                      );
                let grant: Envelope;
                try {
                    grant = await seal(
                        this.identity,
                        [this.identity, recipient],
                        this.state.config!.boot,
                        'room',
                        'share',
                        { kind: 'history', key: b64(raw) },
                        { targets: [id], revision: message.envelope.id }
                    );
                } finally {
                    raw.fill(0);
                }
                await this.commit(grant);
            }
            progress(++sent);
        }
    }

    recipients(scope: string) {
        if (this.state.phase !== 'online')
            throw new Error('Wait until you are connected.');
        const self = { id: this.identity.id, bundle: this.identity.bundle };
        const others = this.state.peers.filter(
            (p) =>
                p.online &&
                p.id !== self.id &&
                (scope === 'room' || dmScope(self.id, p.id) === scope)
        );
        if (scope !== 'room' && others.length !== 1)
            throw new Error(
                'This person is offline. You can message them when they return.'
            );
        return [self, ...others];
    }
    async send(
        payload: Content,
        scope = this.state.scope,
        bytes?: Uint8Array<ArrayBuffer>
    ) {
        validateContent(payload);
        if (
            payload.kind === 'file'
                ? bytes?.length !== payload.size
                : bytes !== undefined
        )
            throw new Error('This file changed. Choose it again.');
        const socket = this.ws;
        const clearMarker = this.clears.get(scope);
        const envelope = await seal(
            this.identity,
            this.recipients(scope),
            this.state.config!.boot,
            scope,
            'chat',
            payload,
            payload.kind === 'file' ? { parts: payload.hashes.length } : {}
        );
        if (this.clears.get(scope) !== clearMarker)
            throw new Error(
                'This conversation was cleared. Please send your message again.'
            );
        if (
            this.stopped ||
            this.ws !== socket ||
            this.ws?.readyState !== WebSocket.OPEN ||
            this.state.phase !== 'online' ||
            envelope.boot !== this.state.config?.boot
        )
            throw new Error(
                'Your connection changed. Please try sending again.'
            );
        this.pending.set(envelope.id, envelope);
        this.update({
            messages: [
                ...this.state.messages,
                {
                    id: envelope.id,
                    from: this.identity.id,
                    name: this.state.name,
                    scope,
                    time: Date.now(),
                    payload,
                    status: 'sending',
                    envelope,
                    audience: Object.keys(envelope.keys),
                    bytes,
                    progress: bytes ? 0 : undefined,
                },
            ],
        });
        this.transmit(envelope);
    }
    retry(id: string) {
        const envelope = this.pending.get(id);
        if (envelope) {
            this.transmit(envelope);
            this.update({
                messages: this.state.messages.map((m) =>
                    m.id === id
                        ? {
                              ...m,
                              status: 'sending',
                              progress: envelope.parts ? 0 : undefined,
                          }
                        : m
                ),
            });
        }
    }
    async typing() {
        if (Date.now() - (this.lastTyping || 0) < 2200) return;
        this.lastTyping = Date.now();
        try {
            this.wire({
                type: 'envelope',
                envelope: await seal(
                    this.identity,
                    this.recipients(this.state.scope),
                    this.state.config!.boot,
                    this.state.scope,
                    'typing',
                    { active: true }
                ),
            });
        } catch {}
    }
    async signal(id: string, payload: Signal | { rekey: true }) {
        const scope = dmScope(this.identity.id, id);
        this.wire({
            type: 'envelope',
            envelope: await seal(
                this.identity,
                this.recipients(scope),
                this.state.config!.boot,
                scope,
                'signal',
                payload
            ),
        });
    }
    select(scope: string) {
        this.update({ scope, unread: { ...this.state.unread, [scope]: 0 } });
    }
    async joinCall(scope = this.state.scope, video = false) {
        if (this.joiningCall) return;
        this.joiningCall = true;
        try {
            this.recipients(scope);
            if (!this.rtc) return;
            if (this.rtc.scope) this.leaveCall();
            this.rtc.members = this.state.peers;
            await this.rtc.join(scope, video);
            this.rtc.sync(this.state.peers);
        } catch (error) {
            if (this.rtc?.scope) this.leaveCall();
            else this.rtc?.stop();
            this.notify(
                error instanceof Error
                    ? error.message
                    : 'Something went wrong. Please try again.'
            );
        } finally {
            this.joiningCall = false;
        }
    }
    leaveCall() {
        this.rtc?.stop();
        try {
            this.wire({ type: 'call', scope: null });
        } catch {}
    }
    async logout() {
        this.stopped = true;
        this.cancelConfirmations('Signed out.');
        clearTimeout(this.retryTimer);
        this.rtc?.stop();
        this.ws?.close();
        try {
            await this.request('logout', {});
        } catch {}
        this.pending.clear();
        this.seen.clear();
        this.clears.clear();
        this.incoming.clear();
        this.files.clear();
        this.held.clear();
        this.wakeUploads();
        this.update({ ...initial(), phase: 'login' });
    }
}

class ApiError extends Error {
    constructor(
        message: string,
        public status: number
    ) {
        super(message);
    }
}
