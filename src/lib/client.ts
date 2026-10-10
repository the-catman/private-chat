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
    b64,
    unb64,
} from './crypto.ts';
import { normalizeName, MAX_BATCH } from './limits.ts';
import { validateContent } from './content.ts';
import { replaceEmoji } from './emoji.ts';
import { CallEngine } from './rtc.ts';

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
    async start(name: string, config: SessionConfig) {
        this.stopped = false;
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
            this.identity.id,
            config,
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
        const ws = new WebSocket(
            `${location.origin.replace(/^https:/, 'wss:')}/ws`
        );
        this.ws = ws;
        ws.onmessage = (event) => {
            this.queue = this.queue
                .then(async () => {
                    if (this.ws !== ws || this.stopped) return;
                    const packet = JSON.parse(event.data);
                    await this.receive(packet);
                })
                .catch(() =>
                    this.notify(
                        'An encrypted message could not be verified. It was not displayed.'
                    )
                );
        };
        ws.onclose = (event) => {
            if (this.ws !== ws || this.stopped) return;
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
    async receive(packet: ServerPacket) {
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
            const signature = await sign(
                this.identity,
                proofText(
                    location.origin,
                    packet.boot,
                    packet.nonce,
                    this.identity.id,
                    this.state.name
                )
            );
            if (!current()) return;
            return this.wire({
                type: 'join',
                id: this.identity.id,
                bundle: this.identity.bundle,
                name: this.state.name,
                sig: signature,
            });
        }
        if (packet.type === 'ready') {
            this.liveHistory = false;
            this.retryCount = 0;
            localStorage.setItem('hush-name', this.state.name);
            this.seen.clear();
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
            for (const [id, envelope] of this.pending) {
                if (envelope.scope !== packet.scope) continue;
                this.pending.delete(id);
                this.confirm(id, new Error('This conversation was cleared.'));
            }
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
            for (const envelope of this.pending.values())
                if (envelope.boot === this.state.config!.boot)
                    this.wire({ type: 'envelope', envelope });
            return;
        }
        if (packet.type === 'ack') {
            if (!packet.deleted && this.pending.get(packet.id)?.type === 'chat')
                this.cue('sent');
            this.pending.delete(packet.id);
            this.confirm(packet.id);
            this.update({
                messages: this.state.messages
                    .filter((m) => !packet.deleted || m.id !== packet.id)
                    .map((m) =>
                        m.id === packet.id ? { ...m, status: 'sent' } : m
                    ),
            });
            return;
        }
        if (packet.type === 'error') {
            this.confirm(packet.id, new Error(packet.message));
            if (this.pending.get(packet.id)?.type !== 'chat')
                this.pending.delete(packet.id);
            this.update({
                messages: this.state.messages.map((m) =>
                    m.id === packet.id ? { ...m, status: 'failed' } : m
                ),
            });
            this.notify(packet.message);
            return;
        }
        if (packet.type !== 'message') return;
        const m = packet.envelope;
        if (this.seen.has(m.id)) return;
        const sender = this.state.peers.find((p) => p.id === m.from);
        if (!sender) throw new Error('Unknown sender.');
        const decrypted = await open<unknown>(
            this.identity,
            sender,
            this.state.config!.boot,
            m
        );
        if (!current()) return;
        if (!decrypted || typeof decrypted !== 'object')
            throw new Error('Invalid payload.');
        this.seen.add(m.id);
        if (this.seen.size > 14000)
            this.seen.delete(this.seen.values().next().value!);
        if (m.type === 'signal')
            return this.rtc?.receive(m.from, decrypted as Signal);
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
            this.update({
                messages: this.state.messages.filter(
                    (item) =>
                        !(
                            m.targets?.includes(item.id) &&
                            item.from === m.from &&
                            item.scope === m.scope
                        )
                ),
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
            } finally {
                raw.fill(0);
            }
            sharedBy = sender.name;
        }
        if (!current()) return;
        const payload = validateContent(contents);
        const id = messageId(envelope);
        const existing = this.state.messages.find((item) => item.id === id);
        if (existing && existing.from !== envelope.from)
            throw new Error('Message author changed.');
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
            this.liveHistory &&
            m.type === 'chat' &&
            !existing &&
            message.from !== this.identity.id
        )
            this.cue('received');
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
    async send(payload: Content, scope = this.state.scope) {
        validateContent(payload);
        const socket = this.ws;
        const clearMarker = this.clears.get(scope);
        const envelope = await seal(
            this.identity,
            this.recipients(scope),
            this.state.config!.boot,
            scope,
            'chat',
            payload
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
                },
            ],
        });
        this.wire({ type: 'envelope', envelope });
    }
    retry(id: string) {
        const envelope = this.pending.get(id);
        if (envelope) {
            this.wire({ type: 'envelope', envelope });
            this.update({
                messages: this.state.messages.map((m) =>
                    m.id === id ? { ...m, status: 'sending' } : m
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
    async signal(id: string, payload: Signal) {
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
            await this.rtc.join(scope, video);
            this.wire({ type: 'call', scope });
            this.rtc.sync(this.state.peers);
        } catch (error) {
            this.rtc?.stop();
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
