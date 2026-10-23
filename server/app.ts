import http from 'node:http';
import {
    randomBytes,
    randomUUID,
    createHash,
    timingSafeEqual,
} from 'node:crypto';
import express, {
    type Request,
    type Response,
    type NextFunction,
} from 'express';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from './config';
import { CallError, createCalls } from './calls.ts';
import type { Frontend } from './frontend';
import type {
    Bundle,
    ClientPacket,
    Envelope,
    Prekey,
    Prekeys,
    ServerPacket,
} from '../src/types';
import { resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import {
    identityId,
    verify,
    proofText,
    signedText,
    dmScope,
    prekeyText,
    VERSION,
} from '../src/lib/crypto.ts';
import { validPrekey, validRatchetKey } from '../src/lib/signal.ts';
import {
    MAX_BATCH,
    MAX_ENCRYPTED_LENGTH,
    MAX_PARTS,
    PART_BYTES,
    PART_HEADER,
    PROTOCOL,
    nameKey,
    normalizeName,
    validName,
} from '../src/lib/limits.ts';

type Auth = { id: string; expires: number };
type Session = Auth & { token: string };
type RecordMessage = Extract<ServerPacket, { type: 'message' }>;
type StoredMessage = {
    envelope: Envelope;
    received: number;
    audience: Set<string>;
    grants: Map<string, Envelope>;
    bytes: number;
    // Encrypted file part frames, relayed exactly as the author sent them.
    parts?: Buffer[];
    upload?: { ws: ClientSocket; timer: ReturnType<typeof setTimeout> };
};
interface ClientSocket extends WebSocket {
    auth: Session;
    // The origin this browser opened, which its identity proof names.
    origin: string;
    memberId?: string;
    nonce: string;
    alive: boolean;
    recent: Set<string>;
    pending: number;
    pendingParts: number;
    queue: Promise<void>;
    outbox: { id: string; record: StoredMessage; index: number }[];
    partTimer?: ReturnType<typeof setTimeout>;
    window: { start: number; packets: number; bytes: number };
    joinTimer?: ReturnType<typeof setTimeout>;
    historyTimer?: ReturnType<typeof setTimeout>;
    historyIterator?: MapIterator<StoredMessage> | null;
}
type Member = {
    id: string;
    name: string;
    bundle: Bundle;
    ws: ClientSocket | null;
    call: string | null;
    // Public Signal prekeys. Each one-time key is handed out only once.
    prekeys: Prekeys;
    replenishing: boolean;
};

const ID = /^[A-Za-z0-9_-]{43}$/;
const UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const B64 = /^[A-Za-z0-9_-]+$/;
const MAX_PACKET = 4 * 1024 * 1024;
const PART_FRAME = PART_HEADER + PART_BYTES + 16;
const UPLOAD_IDLE_MS = 60_000;
const SESSION_MS = 12 * 60 * 60 * 1000;
const COOKIE = '__Host-hush';
const plain = (x: unknown): x is Record<string, unknown> =>
    x !== null && typeof x === 'object' && !Array.isArray(x);
const hash = (x: string) => createHash('sha256').update(x).digest();
const encoded = (x: unknown, min: number, max = min): x is string =>
    typeof x === 'string' && x.length >= min && x.length <= max && B64.test(x);
const MAX_PREKEYS = 100;
const validPrekeys = (x: unknown, have = 0): x is Prekey[] =>
    Array.isArray(x) &&
    x.length <= MAX_PREKEYS - have &&
    x.every(validPrekey) &&
    new Set(x.map((p) => p.id)).size === x.length;
// Exactly a prekey id, key and the identity's signature over it.
async function signedPrekey(bundle: Bundle, spk: unknown) {
    if (!plain(spk) || Object.keys(spk).length !== 3) return false;
    const { id, key, sig } = spk;
    return (
        validPrekey({ id, key }) &&
        encoded(sig, 86) &&
        verify(bundle, prekeyText(key as string), sig)
    );
}

export function createChatServer(
    config: Config,
    {
        dist = resolve('dist'),
        frontend,
    }: { dist?: string; frontend?: Frontend } = {}
) {
    // Only ciphertext is retained here. No message, session, or signaling file writes.
    const boot = randomUUID();
    const sessions = new Map<string, Auth>();
    const members = new Map<string, Member>();
    const history = new Map<string, StoredMessage>();
    // Operation IDs prevent a deleted message being replayed back into history.
    const operations = new Set<string>();
    // Retain only the latest clear marker per conversation, never its contents.
    const clears = new Map<
        string,
        Extract<ServerPacket, { type: 'cleared' }>
    >();
    const nameOwners = new Map<string, string>();
    const attempts = new Map<string, { start: number; count: number }>();
    let historyBytes = 0;
    let globalAttempts = { start: Date.now(), count: 0 };
    const passwordHash = hash(config.password);
    const sockets = new Set<ClientSocket>();
    const calls = createCalls(config);
    const wss = new WebSocketServer({
        noServer: true,
        maxPayload: MAX_PACKET,
        perMessageDeflate: false,
    });
    const publicMember = (member: Member) => ({
        id: member.id,
        name: member.name,
        bundle: member.bundle,
        online: Boolean(member.ws),
        call: member.call || null,
    });

    function send(ws: ClientSocket, payload: ServerPacket) {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > 24 * 1024 * 1024)
            return ws.close(
                1013,
                'Connection is too slow. Reconnect to recover history.'
            );
        ws.send(JSON.stringify(payload));
    }
    const peers = () => Array.from(members.values(), publicMember);
    const broadcast = (payload: ServerPacket) => {
        for (const member of members.values())
            if (member.ws) send(member.ws, payload);
    };
    const broadcastPeers = () => broadcast({ type: 'peers', peers: peers() });
    // Caddy forwards the public HTTPS origin. This machine may also open
    // http://localhost:PORT directly, which browsers treat as secure.
    function originOf(req: IncomingMessage) {
        if (
            !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
                req.socket.remoteAddress || ''
            )
        )
            return;
        const { host } = req.headers;
        if (req.headers['x-forwarded-proto'] === 'https')
            return host === config.host ? config.origin : undefined;
        if (
            !req.headers['x-forwarded-for'] &&
            ['localhost', '127.0.0.1', '[::1]'].some(
                (name) => host === `${name}:${req.socket.localPort}`
            )
        )
            return `http://${host}`;
    }
    const sameOrigin = (req: IncomingMessage) => {
        const origin = originOf(req);
        return origin !== undefined && req.headers.origin === origin;
    };
    function session(req: IncomingMessage): Session | null {
        const token = req.headers.cookie
            ?.split(';')
            .map((s) => s.trim())
            .find((s) => s.startsWith(`${COOKIE}=`))
            ?.slice(COOKIE.length + 1);
        const value = token && sessions.get(token);
        if (!value || value.expires <= Date.now()) return null;
        return { token, ...value };
    }
    function headers(req: IncomingMessage, res: ServerResponse) {
        const origin = originOf(req) || config.origin;
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Frame-Options', 'DENY');
        if (origin === config.origin)
            res.setHeader('Strict-Transport-Security', 'max-age=31536000');
        res.setHeader(
            'Permissions-Policy',
            'camera=(self), microphone=(self), display-capture=(self), geolocation=()'
        );
        res.setHeader(
            'Content-Security-Policy',
            `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src ${frontend ? "'self' blob:" : "'self'"}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${origin.replace(/^http/, 'ws')}; media-src 'self' blob:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`
        );
    }
    function json(res: ServerResponse, status: number, body: unknown) {
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
        });
        res.end(JSON.stringify(body));
    }
    function throttle(req: IncomingMessage) {
        const now = Date.now();
        // Caddy overwrites X-Forwarded-For by default; only trust the last proxy-added IP.
        const ip = String(
            req.headers['x-forwarded-for'] || req.socket.remoteAddress
        )
            .split(',')
            .at(-1)!
            .trim()
            .slice(0, 80);
        let bucket = attempts.get(ip);
        if (!bucket || now - bucket.start > 60_000)
            bucket = { start: now, count: 0 };
        if (now - globalAttempts.start > 60_000)
            globalAttempts = { start: now, count: 0 };
        if (attempts.size < 1024 || attempts.has(ip)) attempts.set(ip, bucket);
        bucket.count++;
        globalAttempts.count++;
        return bucket.count > 8 || globalAttempts.count > 80;
    }

    const app = express();
    app.disable('x-powered-by');
    app.use((req, res, next) => {
        headers(req, res);
        if (!originOf(req))
            return json(res, 426, {
                error: 'Open this app through its configured HTTPS address or localhost.',
            });
        next();
    });
    app.use(express.json({ limit: '2kb', strict: true }));
    app.use(async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (req.url === '/api/login' && req.method === 'POST') {
                if (!sameOrigin(req))
                    return json(res, 403, { error: 'Origin not allowed.' });
                if (throttle(req)) {
                    res.setHeader('Retry-After', '60');
                    return json(res, 429, {
                        error: 'Too many attempts. Try again in one minute.',
                    });
                }
                const data = req.body;
                if (!plain(data))
                    return json(res, 400, { error: 'Expected a JSON object.' });
                if (
                    typeof data.password !== 'string' ||
                    data.password.length > 512 ||
                    !timingSafeEqual(hash(data.password), passwordHash)
                )
                    return json(res, 401, {
                        error: 'That password is not right. Try again.',
                    });
                if (sessions.size >= 128)
                    return json(res, 503, {
                        error: 'Too many active sessions. Try again later.',
                    });
                const old = session(req);
                if (old) sessions.delete(old.token);
                const token = randomBytes(32).toString('base64url');
                sessions.set(token, {
                    id: randomUUID(),
                    expires: Date.now() + SESSION_MS,
                });
                res.setHeader(
                    'Set-Cookie',
                    `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`
                );
                return json(res, 200, { ok: true });
            }
            if (req.url === '/api/session' && req.method === 'GET') {
                const auth = session(req);
                if (!auth)
                    return json(res, 401, {
                        error: 'Please enter the room password.',
                    });
                return json(res, 200, {
                    boot,
                    maxClients: config.maxClients,
                    expires: auth.expires,
                    protocol: PROTOCOL,
                    origin: config.origin,
                });
            }
            if (req.url === '/api/logout' && req.method === 'POST') {
                if (!sameOrigin(req))
                    return json(res, 403, { error: 'Origin not allowed.' });
                const auth = session(req);
                if (auth) {
                    sessions.delete(auth.token);
                    for (const ws of sockets)
                        if (ws.auth.token === auth.token)
                            ws.close(4001, 'Signed out.');
                }
                res.setHeader(
                    'Set-Cookie',
                    `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
                );
                return json(res, 200, { ok: true });
            }
            if (
                !['GET', 'HEAD'].includes(req.method) ||
                req.url.startsWith('/api/')
            )
                return json(res, 404, { error: 'Not found.' });
            const pathname = new URL(req.url, config.origin).pathname;
            if (frontend) {
                if (!frontend.allows(pathname))
                    return json(res, 404, { error: 'Not found.' });
                return next();
            }
            if (
                pathname !== '/' &&
                !/^\/assets\/[a-zA-Z0-9_.-]+\.(js|css|svg|woff2|wasm)$/.test(
                    pathname
                )
            )
                return json(res, 404, { error: 'Not found.' });
            next();
        } catch {
            json(res, 400, { error: 'Unable to process that request.' });
        }
    });
    if (frontend) app.use(frontend.middleware);
    else
        app.use(
            express.static(dist, {
                etag: false,
                lastModified: false,
                cacheControl: false,
                dotfiles: 'deny',
                index: 'index.html',
            })
        );
    app.use((_req, res) => {
        json(res, 404, { error: 'Not found.' });
    });
    app.use(
        (
            _error: unknown,
            _req: Request,
            res: Response,
            _next: NextFunction
        ) => {
            json(res, 400, { error: 'Invalid request or request too large.' });
        }
    );
    const server = http.createServer(app);
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.maxHeadersCount = 32;

    server.on('upgrade', (req, socket, head) => {
        if (
            frontend &&
            new URL(req.url || '/', config.origin).pathname ===
                frontend.upgradePath
        ) {
            if (!sameOrigin(req)) {
                socket.end(
                    'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'
                );
                return;
            }
            frontend.upgrade(req, socket, head);
            return;
        }
        const auth = session(req);
        if (
            !sameOrigin(req) ||
            req.url !== '/ws' ||
            !auth ||
            sockets.size >= 16
        ) {
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            (ws as ClientSocket).auth = auth;
            (ws as ClientSocket).origin = originOf(req)!;
            wss.emit('connection', ws);
        });
    });

    function validScope(scope: unknown, from: string): scope is string {
        if (scope === 'room') return true;
        const ids = typeof scope === 'string' ? scope.split(':') : [];
        return (
            ids.length === 3 &&
            ids[0] === 'dm' &&
            ids[1] !== ids[2] &&
            ids.slice(1).includes(from) &&
            ids.slice(1).every((id) => ID.test(id) && members.has(id)) &&
            scope === dmScope(ids[1], ids[2])
        );
    }
    function validEnvelope(m: Envelope, from: string) {
        if (
            !plain(m) ||
            m.v !== VERSION ||
            m.boot !== boot ||
            !UUID.test(m.id) ||
            m.from !== from ||
            !validScope(m.scope, from) ||
            !['chat', 'signal', 'typing', 'edit', 'delete', 'share'].includes(
                m.type
            ) ||
            !Number.isSafeInteger(m.time)
        )
            return false;
        if (
            !encoded(m.iv, 16) ||
            !encoded(m.data, 22, MAX_ENCRYPTED_LENGTH) ||
            !encoded(m.sig, 86) ||
            !plain(m.keys)
        )
            return false;
        const ids = Object.keys(m.keys);
        if (
            !ids.length ||
            ids.length >
                (['edit', 'delete'].includes(m.type)
                    ? 256
                    : config.maxClients) ||
            !ids.includes(from)
        )
            return false;
        if (
            m.scope !== 'room' &&
            ids.some((id) => !m.scope.split(':').slice(1).includes(id))
        )
            return false;
        if (m.type === 'signal' && (m.scope === 'room' || ids.length !== 2))
            return false;
        if (!['chat', 'edit'].includes(m.type) && m.data.length > 100_000)
            return false;
        if (
            ['signal', 'typing'].includes(m.type) &&
            Math.abs(Date.now() - m.time) > 60_000
        )
            return false;
        if (['edit', 'delete', 'share'].includes(m.type)) {
            if (
                !Array.isArray(m.targets) ||
                !m.targets.length ||
                m.targets.length > (m.type === 'delete' ? MAX_BATCH : 1) ||
                new Set(m.targets).size !== m.targets.length ||
                m.targets.some((id) => typeof id !== 'string' || !UUID.test(id))
            )
                return false;
            if (
                m.type !== 'delete' &&
                (typeof m.revision !== 'string' || !UUID.test(m.revision))
            )
                return false;
            if (m.type === 'delete' && m.revision !== undefined) return false;
            if (m.type === 'share' && (m.scope !== 'room' || ids.length !== 2))
                return false;
        } else if (m.targets !== undefined || m.revision !== undefined)
            return false;
        if (
            m.parts !== undefined &&
            (m.type !== 'chat' ||
                !Number.isSafeInteger(m.parts) ||
                m.parts < 1 ||
                m.parts > MAX_PARTS)
        )
            return false;
        // The author keeps a self-sealed copy; recipients get ratchet keys.
        return ids.every((id) => {
            const entry: unknown = m.keys[id];
            return (
                ID.test(id) &&
                members.has(id) &&
                plain(entry) &&
                (id === from
                    ? Object.keys(entry).length === 2 &&
                      encoded(entry.iv, 16) &&
                      encoded(entry.data, 64)
                    : validRatchetKey(entry))
            );
        });
    }

    async function receive(ws: ClientSocket, data: Buffer) {
        if (!sessions.has(ws.auth.token) || ws.auth.expires <= Date.now()) {
            ws.close(4001, 'Your session expired. Please sign in again.');
            return;
        }
        let packet: ClientPacket;
        try {
            packet = JSON.parse(data.toString('utf8'));
        } catch {
            return ws.close(1008, 'Invalid packet.');
        }
        if (!plain(packet)) return ws.close(1008, 'Invalid packet.');
        if (!ws.memberId) {
            if (
                packet.type !== 'join' ||
                !plain(packet.bundle) ||
                !encoded(packet.bundle.dh, 43) ||
                !encoded(packet.bundle.sign, 43) ||
                !plain(packet.prekeys) ||
                !validPrekeys(packet.prekeys.opks) ||
                !ID.test(packet.id) ||
                typeof packet.name !== 'string' ||
                packet.name.length > 64 ||
                !validName(normalizeName(packet.name))
            )
                return ws.close(1008, 'Choose a name of 1–32 characters.');
            const name = normalizeName(packet.name);
            if (
                (await identityId(packet.bundle)) !== packet.id ||
                !(await verify(
                    packet.bundle,
                    proofText(ws.origin, boot, ws.nonce, packet.id, name),
                    packet.sig
                )) ||
                !(await signedPrekey(packet.bundle, packet.prekeys.spk))
            )
                return ws.close(1008, 'Identity verification failed.');
            const existing = members.get(packet.id);
            // The newest connection wins. A reload or a phone waking up must
            // not wait for the old socket's ping timeout.
            const replaced = existing?.ws;
            if (
                !replaced &&
                Array.from(members.values()).filter((m) => m.ws).length >=
                    config.maxClients
            )
                return ws.close(
                    4004,
                    'The room is full. Try again when someone leaves.'
                );
            if (!existing && members.size >= 256)
                return ws.close(
                    4004,
                    'Identity limit reached. Restart the server to reset.'
                );
            if (
                nameOwners.has(nameKey(name)) &&
                nameOwners.get(nameKey(name)) !== packet.id
            )
                return ws.close(
                    4004,
                    'That name is reserved by another browser. Choose another.'
                );
            if (!nameOwners.has(nameKey(name)) && nameOwners.size >= 1024)
                return ws.close(
                    4004,
                    'Name limit reached. Restart the server to reset.'
                );
            if (
                ws.readyState !== WebSocket.OPEN ||
                !sessions.has(ws.auth.token) ||
                ws.auth.expires <= Date.now()
            )
                return;
            if (replaced) {
                existing!.ws = null;
                calls.leave(packet.id);
                for (const [id, record] of history)
                    if (record.upload?.ws === replaced) drop(id, false);
                replaced.close(4009, 'Hush was opened in another tab.');
            }
            ws.memberId = packet.id;
            clearTimeout(ws.joinTimer);
            nameOwners.set(nameKey(name), packet.id);
            members.set(packet.id, {
                id: packet.id,
                name,
                bundle: { dh: packet.bundle.dh, sign: packet.bundle.sign },
                ws,
                call: null,
                prekeys: {
                    spk: packet.prekeys.spk,
                    opks: packet.prekeys.opks.map(({ id, key }) => ({
                        id,
                        key,
                    })),
                },
                replenishing: false,
            });
            send(ws, { type: 'ready', boot, peers: peers() });
            for (const cleared of clears.values()) {
                if (validScope(cleared.scope, packet.id)) send(ws, cleared);
            }
            broadcastPeers();
            broadcast({
                type: 'presence',
                event: {
                    id: randomUUID(),
                    userId: packet.id,
                    name,
                    action: 'joined',
                    time: Date.now(),
                },
            });
            // Deliver bounded chunks so a large history does not fill a socket queue.
            ws.historyIterator = history.values();
            pumpHistory(ws);
            return;
        }
        const member = members.get(ws.memberId)!;
        if (member.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
        if (packet.type === 'clear') {
            if (
                typeof packet.id !== 'string' ||
                !UUID.test(packet.id) ||
                !validScope(packet.scope, member.id)
            )
                return ws.close(1008, 'Invalid conversation.');
            // A retried clear must not delete messages sent after the first one.
            if (operations.has(packet.id))
                return send(ws, { type: 'ack', id: packet.id });
            if (operations.size >= 50_000)
                return send(ws, {
                    type: 'error',
                    id: packet.id,
                    message:
                        'This session has reached its operation limit. Restart the server to reset it.',
                });
            for (const [id, record] of history) {
                if (record.envelope.scope !== packet.scope) continue;
                drop(id, true);
            }
            operations.add(packet.id);
            const cleared = {
                type: 'cleared' as const,
                id: packet.id,
                scope: packet.scope,
                by: member.id,
            };
            clears.set(packet.scope, cleared);
            for (const person of members.values()) {
                if (person.ws && validScope(packet.scope, person.id))
                    send(person.ws, cleared);
            }
            return send(ws, { type: 'ack', id: packet.id });
        }
        if (packet.type === 'fetch') {
            if (typeof packet.id !== 'string' || !UUID.test(packet.id))
                return ws.close(1008, 'Invalid file request.');
            const record = history.get(packet.id);
            if (
                !record?.parts ||
                record.upload ||
                !record.audience.has(member.id)
            )
                return send(ws, {
                    type: 'error',
                    id: packet.id,
                    message: 'That file is no longer available.',
                });
            // One transfer per file at a time, however often it is requested.
            if (!ws.outbox.some((item) => item.id === packet.id)) {
                ws.outbox.push({ id: packet.id, record, index: 0 });
                pumpParts(ws);
            }
            return;
        }
        if (packet.type === 'bundle') {
            const request = packet.request;
            if (!Number.isSafeInteger(request) || request < 1)
                return ws.close(1008, 'Invalid key request.');
            const owner =
                typeof packet.id === 'string' && packet.id !== member.id
                    ? members.get(packet.id)
                    : undefined;
            if (!owner)
                return send(ws, {
                    type: 'bundle',
                    request,
                    error: 'That person is no longer here.',
                });
            const opk = owner.prekeys.opks.shift();
            send(ws, {
                type: 'bundle',
                request,
                bundle: { spk: owner.prekeys.spk, ...(opk && { opk }) },
            });
            if (
                owner.ws &&
                !owner.replenishing &&
                owner.prekeys.opks.length < 5
            ) {
                owner.replenishing = true;
                send(owner.ws, {
                    type: 'prekeys',
                    remaining: owner.prekeys.opks.length,
                });
            }
            return;
        }
        if (packet.type === 'prekeys') {
            if (
                !validPrekeys(packet.opks, member.prekeys.opks.length) ||
                !(await signedPrekey(member.bundle, packet.spk))
            )
                return ws.close(1008, 'Invalid prekeys.');
            member.prekeys.spk = packet.spk;
            member.prekeys.opks.push(
                ...packet.opks.map(({ id, key }) => ({ id, key }))
            );
            member.replenishing = false;
            return;
        }
        if (packet.type === 'call') {
            if (packet.scope !== null && !validScope(packet.scope, member.id))
                return ws.close(1008, 'Invalid call.');
            if (packet.scope)
                calls.join(packet.scope, member.id, (p) => send(ws, p));
            else calls.leave(member.id);
            member.call = packet.scope;
            broadcastPeers();
            return;
        }
        if (packet.type === 'media' || packet.type === 'mls') {
            if (data.length > 300_000) return ws.close(1008, 'Invalid call.');
            if (packet.type === 'mls') {
                try {
                    calls.mls(member.id, packet);
                } catch {
                    return ws.close(1008, 'Invalid call.');
                }
                return;
            }
            const request = packet.request;
            if (!Number.isSafeInteger(request) || request < 1)
                return ws.close(1008, 'Invalid call.');
            try {
                const result = await calls.request(member.id, packet);
                send(ws, { type: 'media', request, data: result });
            } catch (error) {
                send(ws, {
                    type: 'media',
                    request,
                    error:
                        error instanceof CallError
                            ? error.message
                            : 'The call server rejected that request.',
                });
            }
            return;
        }
        if (packet.type !== 'envelope')
            return ws.close(1008, 'Invalid operation.');
        const m = packet.envelope;
        if (
            !validEnvelope(m, member.id) ||
            !(await verify(member.bundle, signedText(m), m.sig))
        )
            return ws.close(1008, 'Message verification failed.');
        if (
            member.ws !== ws ||
            ws.readyState !== WebSocket.OPEN ||
            !sessions.has(ws.auth.token) ||
            ws.auth.expires <= Date.now()
        )
            return;
        const persistent = !['signal', 'typing'].includes(m.type);
        if (m.type === 'chat' && history.get(m.id)?.upload) return;
        if (operations.has(m.id) || ws.recent.has(m.id)) {
            // Resending a whole file only because an ack was lost wastes RAM and bandwidth.
            if (m.type === 'chat' && history.has(m.id) && !m.parts)
                deliver(ws, history.get(m.id)!);
            return send(ws, {
                type: 'ack',
                id: m.id,
                deleted: m.type === 'chat' && !history.has(m.id),
            });
        }
        const fail = (message: string) =>
            send(ws, { type: 'error', id: m.id, message });
        if (persistent && m.type !== 'delete' && operations.size >= 50_000)
            return fail(
                'This session has reached its operation limit. Restart the server to reset it.'
            );
        const size = envelopeBytes(m);
        const keys = Object.keys(m.keys);
        const sameAudience = (audience: Set<string>) =>
            keys.length === audience.size &&
            keys.every((id) => audience.has(id));
        const full = (delta: number) =>
            historyBytes + delta > config.maxHistoryBytes;
        if (m.type === 'chat') {
            // Reserve the largest possible file up front; finish() trims it.
            const reserved = size + (m.parts || 0) * PART_FRAME;
            if (full(reserved) || history.size >= 10000)
                return fail(
                    m.parts
                        ? 'Server memory is full. Delete some messages or files, or ask the host to raise MAX_HISTORY_MB.'
                        : 'Server memory is full. Delete some messages or restart the server to make room.'
                );
            const record: StoredMessage = {
                envelope: m,
                received: Date.now(),
                audience: new Set(keys),
                grants: new Map(),
                bytes: reserved,
            };
            history.set(m.id, record);
            historyBytes += reserved;
            if (m.parts) {
                // Recipients get nothing until every part has arrived.
                record.parts = [];
                record.upload = { ws, timer: idle(m.id) };
                return;
            }
            for (const id of record.audience) {
                const target = members.get(id)?.ws;
                if (target) deliver(target, record);
            }
        } else if (m.type === 'edit') {
            const record = history.get(m.targets![0]);
            if (
                !record ||
                record.envelope.from !== member.id ||
                record.envelope.scope !== m.scope
            )
                return fail('You can only edit your own existing messages.');
            if (record.parts)
                return fail('Files cannot be edited. Send a new file instead.');
            if (
                record.envelope.id !== m.revision ||
                !sameAudience(record.audience)
            )
                return fail(
                    'This message or its recipients changed. Please try editing again.'
                );
            if (full(size - record.bytes))
                return fail(
                    'There is not enough free server memory for this edit.'
                );
            historyBytes += size - record.bytes;
            record.envelope = m;
            record.bytes = size;
            record.grants.clear();
            for (const id of record.audience) {
                const target = members.get(id)?.ws;
                if (target) deliver(target, record);
            }
        } else if (m.type === 'delete') {
            const records = m.targets!.map((id) => history.get(id));
            if (
                records.some(
                    (r) =>
                        !r ||
                        r.envelope.from !== member.id ||
                        r.envelope.scope !== m.scope
                )
            )
                return fail(
                    'You can only delete your own existing messages in this conversation.'
                );
            const audience = new Set(records.flatMap((r) => [...r!.audience]));
            if (!sameAudience(audience))
                return fail(
                    'Message recipients changed. Please try deleting again.'
                );
            // Validate the entire batch before removing any ciphertext.
            for (const id of m.targets!) drop(id, true);
            for (const id of audience) {
                const target = members.get(id)?.ws;
                if (target)
                    send(target, {
                        type: 'message',
                        envelope: m,
                        received: Date.now(),
                    });
            }
        } else if (m.type === 'share') {
            const record = history.get(m.targets![0]);
            if (
                !record ||
                record.upload ||
                record.envelope.scope !== 'room' ||
                !record.audience.has(member.id)
            )
                return fail(
                    'Only participants who received a room message can share it. DMs stay private.'
                );
            if (record.envelope.id !== m.revision)
                return fail(
                    'The message was edited. Select its latest version and try again.'
                );
            const recipient = keys.find((id) => id !== member.id)!;
            if (!members.get(recipient)?.ws)
                return fail('That person is offline. Share when they return.');
            if (!record.audience.has(recipient)) {
                if (full(size))
                    return fail(
                        'There is not enough free server memory to share more history.'
                    );
                record.grants.set(recipient, m);
                record.audience.add(recipient);
                record.bytes += size;
                historyBytes += size;
                for (const id of record.audience) {
                    const target = members.get(id)?.ws;
                    if (target) {
                        if (id === recipient) deliver(target, record);
                        else
                            send(target, {
                                type: 'access',
                                id: m.targets![0],
                                grant: m,
                            });
                    }
                }
            }
        } else {
            for (const id of keys) {
                const target = members.get(id)?.ws;
                if (target && id !== member.id)
                    send(target, {
                        type: 'message',
                        envelope: m,
                        received: Date.now(),
                    });
            }
        }
        if (persistent) {
            operations.add(m.id);
            send(ws, { type: 'ack', id: m.id });
        } else {
            ws.recent.add(m.id);
            if (ws.recent.size > 2000)
                ws.recent.delete(ws.recent.values().next().value!);
        }
    }

    function envelopeBytes(envelope: Envelope) {
        return Buffer.byteLength(JSON.stringify(envelope)) * 2 + 1024;
    }

    // Removed IDs stay in operations so a deleted or cleared upload cannot be
    // replayed. An interrupted upload may be retried with the same ID.
    function drop(id: string, final: boolean) {
        const record = history.get(id);
        if (!record) return;
        if (record.upload) {
            clearTimeout(record.upload.timer);
            if (final) operations.add(id);
        }
        historyBytes -= record.bytes;
        history.delete(id);
    }
    function idle(id: string) {
        return setTimeout(() => {
            const record = history.get(id);
            if (!record?.upload) return;
            const ws = record.upload.ws;
            drop(id, false);
            send(ws, {
                type: 'error',
                id,
                message: 'The file upload stalled. Retry to send it again.',
            });
        }, UPLOAD_IDLE_MS);
    }
    function receivePart(ws: ClientSocket, frame: Buffer) {
        if (!sessions.has(ws.auth.token) || ws.auth.expires <= Date.now())
            return ws.close(
                4001,
                'Your session expired. Please sign in again.'
            );
        const member = ws.memberId ? members.get(ws.memberId) : undefined;
        if (!member || member.ws !== ws || ws.readyState !== WebSocket.OPEN)
            return;
        const id = frame.toString('latin1', 0, 36);
        if (!UUID.test(id)) return ws.close(1008, 'Invalid file part.');
        const record = history.get(id);
        // Parts can still be in flight after a clear, deletion or timeout.
        if (!record?.upload || record.upload.ws !== ws) return;
        const index = frame.readUInt32BE(36);
        const total = record.envelope.parts!;
        if (
            index !== record.parts!.length ||
            (index < total - 1
                ? frame.length !== PART_FRAME
                : frame.length < PART_HEADER + 16 || frame.length > PART_FRAME)
        )
            return ws.close(1008, 'Invalid file part.');
        record.parts!.push(frame);
        clearTimeout(record.upload.timer);
        if (record.parts!.length < total) {
            record.upload.timer = idle(id);
            return send(ws, { type: 'progress', id, parts: index + 1 });
        }
        record.upload = undefined;
        const bytes =
            envelopeBytes(record.envelope) +
            record.parts!.reduce((sum, part) => sum + part.length, 0);
        historyBytes += bytes - record.bytes;
        record.bytes = bytes;
        record.received = Date.now();
        operations.add(id);
        for (const person of record.audience) {
            const target = members.get(person)?.ws;
            // The author already has the file; only confirm it.
            if (target && target !== ws) deliver(target, record);
        }
        send(ws, { type: 'ack', id });
    }

    function deliver(ws: ClientSocket, record: StoredMessage) {
        const id = ws.memberId!;
        if (!record.audience.has(id)) return;
        const grant = record.grants.get(id);
        const packet: RecordMessage = {
            type: 'message',
            envelope: grant || record.envelope,
            received: record.received,
            grants: [...record.grants.values()],
            ...(grant
                ? {
                      source: {
                          envelope: record.envelope,
                          received: record.received,
                      },
                  }
                : {}),
        };
        send(ws, packet);
    }

    // Stream requested parts without filling the socket queue. History
    // replay goes first so large files never hold back conversations.
    function pumpParts(ws: ClientSocket) {
        clearTimeout(ws.partTimer);
        while (ws.outbox.length && ws.readyState === WebSocket.OPEN) {
            if (ws.historyIterator || ws.bufferedAmount >= 1024 * 1024) {
                ws.partTimer = setTimeout(() => pumpParts(ws), 25);
                return;
            }
            const item = ws.outbox[0];
            if (
                history.get(item.id) !== item.record ||
                !item.record.audience.has(ws.memberId!) ||
                item.index >= item.record.parts!.length
            ) {
                ws.outbox.shift();
                continue;
            }
            ws.send(item.record.parts![item.index++], { binary: true });
        }
    }

    function pumpHistory(ws: ClientSocket) {
        if (ws.readyState !== WebSocket.OPEN || !ws.historyIterator) return;
        let count = 0;
        while (ws.bufferedAmount < 1024 * 1024 && count < 16) {
            const next = ws.historyIterator.next();
            if (next.done) {
                ws.historyIterator = null;
                send(ws, { type: 'history-end' });
                return;
            }
            if (!next.value.upload && next.value.audience.has(ws.memberId!)) {
                deliver(ws, next.value);
                count++;
            }
        }
        ws.historyTimer = setTimeout(() => pumpHistory(ws), 25);
    }
    wss.on('connection', (socket) => {
        const ws = socket as ClientSocket;
        sockets.add(ws);
        ws.nonce = randomBytes(32).toString('base64url');
        ws.alive = true;
        ws.recent = new Set();
        ws.pending = 0;
        ws.pendingParts = 0;
        ws.queue = Promise.resolve();
        ws.outbox = [];
        ws.window = { start: Date.now(), packets: 0, bytes: 0 };
        ws.joinTimer = setTimeout(
            () => ws.close(1008, 'Join timed out.'),
            10_000
        );
        send(ws, { type: 'challenge', boot, nonce: ws.nonce });
        ws.on('pong', () => {
            ws.alive = true;
        });
        ws.on('message', (raw, isBinary) => {
            const data = Buffer.isBuffer(raw)
                ? raw
                : Buffer.from(raw as ArrayBuffer);
            if (isBinary) {
                // Parts are bounded by the upload's memory reservation and an
                // in-order index, and the client waits for progress acks.
                if (
                    !ws.memberId ||
                    ws.pendingParts >= 12 ||
                    data.length < PART_HEADER + 16 ||
                    data.length > PART_FRAME
                )
                    return ws.close(1008, 'Invalid file part.');
                ws.pendingParts++;
                ws.queue = ws.queue
                    .then(() => receivePart(ws, data))
                    .catch(() => ws.close(1008, 'Invalid request.'))
                    .finally(() => {
                        ws.pendingParts--;
                    });
                return;
            }
            if (ws.pending >= 8)
                return ws.close(1008, 'Too many pending messages.');
            if (Date.now() - ws.window.start >= 10_000)
                ws.window = { start: Date.now(), packets: 0, bytes: 0 };
            ws.window.packets++;
            ws.window.bytes += data.length;
            if (ws.window.packets > 160 || ws.window.bytes > 40 * 1024 * 1024)
                return ws.close(1008, 'Sending too quickly.');
            ws.pending++;
            ws.queue = ws.queue
                .then(() => receive(ws, data))
                .catch(() => ws.close(1008, 'Invalid request.'))
                .finally(() => {
                    ws.pending--;
                });
        });
        ws.on('error', () => {});
        ws.on('close', () => {
            sockets.delete(ws);
            clearTimeout(ws.joinTimer);
            clearTimeout(ws.historyTimer);
            clearTimeout(ws.partTimer);
            ws.outbox = [];
            for (const [id, record] of history)
                if (record.upload?.ws === ws) drop(id, false);
            const member = ws.memberId ? members.get(ws.memberId) : undefined;
            if (member?.ws === ws) {
                member.ws = null;
                member.call = null;
                calls.leave(member.id);
                broadcastPeers();
                broadcast({
                    type: 'presence',
                    event: {
                        id: randomUUID(),
                        userId: member.id,
                        name: member.name,
                        action: 'left',
                        time: Date.now(),
                    },
                });
            }
        });
    });
    const cleanup = setInterval(() => {
        const now = Date.now();
        for (const [token, auth] of sessions)
            if (auth.expires <= now) sessions.delete(token);
        for (const [ip, value] of attempts)
            if (now - value.start > 60_000) attempts.delete(ip);
        for (const ws of sockets) {
            if (!sessions.has(ws.auth.token)) {
                ws.close(4001, 'Session expired. Please sign in again.');
                continue;
            }
            if (!ws.alive) {
                ws.terminate();
                continue;
            }
            ws.alive = false;
            ws.ping();
        }
    }, 15_000);
    cleanup.unref();

    return {
        server,
        boot,
        calls,
        stats: () => ({
            messages: history.size,
            historyBytes,
            online: Array.from(members.values()).filter((m) => m.ws).length,
        }),
        async close() {
            clearInterval(cleanup);
            await calls.close();
            await frontend?.close();
            for (const ws of sockets) ws.terminate();
            for (const record of history.values())
                clearTimeout(record.upload?.timer);
            history.clear();
            operations.clear();
            clears.clear();
            nameOwners.clear();
            historyBytes = 0;
            sessions.clear();
            members.clear();
            attempts.clear();
            passwordHash.fill(0);
            await new Promise<void>((resolve) => wss.close(() => resolve()));
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
