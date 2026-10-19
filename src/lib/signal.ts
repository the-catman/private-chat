import type {
    Identity,
    Prekey,
    PrekeyBundle,
    Prekeys,
    RatchetKey,
    Recipient,
    SelfKey,
} from '../types';
import { b64, identityId, prekeyText, sign, unb64, verify } from './crypto.ts';

// The Signal protocol for Hush: X3DH starts a session from a signed prekey
// and a one-time prekey, then the Double Ratchet gives every message key
// forward secrecy and heals after a compromise. Each recipient gets their own
// ratchet message; for rooms of up to eight people this pairwise fan-out is
// stronger than Sender Keys. Only keys are kept, never messages.
type Bytes = Uint8Array<ArrayBuffer>;
type Pair = { pub: string; key: CryptoKey };
type Session = {
    // Initiator and responder ids, as bound by X3DH.
    ad: string;
    // The initiator's ephemeral key names the session.
    base: string;
    rk: Bytes;
    dhs: Pair;
    dhr?: string;
    cks?: Bytes;
    ckr?: Bytes;
    ns: number;
    nr: number;
    pn: number;
    skipped: [dh: string, n: number, mk: Bytes][];
    // Sent with every message until the responder first replies.
    pre?: RatchetKey['pre'];
};
type Private = Pair & { sig?: string; time: number };
type Opened = { from: string; scope: string; key: Bytes };
type Store = 'sessions' | 'prekeys' | 'opened' | 'meta';
export type RatchetStorage = {
    load(): Promise<Record<Store, [IDBValidKey, unknown][]>>;
    put(store: Store, key: IDBValidKey, value: unknown): void;
    delete(store: Store, key: IDBValidKey): void;
    // Resolves once earlier writes are durable, so no key is used twice.
    flush(): Promise<void>;
};
export class RatchetError extends Error {}

const enc = new TextEncoder();
const X25519 = { name: 'X25519' } as const;
const MAX_SKIP = 1000;
const MAX_SESSIONS = 4;
const MAX_PREKEYS = 200;
const SIGNED_PREKEY_MS = 7 * 24 * 60 * 60 * 1000;
const COUNTER = 2 ** 31;

async function generate(): Promise<Pair> {
    const pair = (await crypto.subtle.generateKey(X25519, false, [
        'deriveBits',
    ])) as CryptoKeyPair;
    return {
        key: pair.privateKey,
        pub: b64(await crypto.subtle.exportKey('raw', pair.publicKey)),
    };
}
async function dh(key: CryptoKey, pub: string) {
    const peer = await crypto.subtle.importKey(
        'raw',
        unb64(pub),
        X25519,
        false,
        []
    );
    return new Uint8Array(
        await crypto.subtle.deriveBits(
            { name: 'X25519', public: peer },
            key,
            256
        )
    );
}
async function hkdf(ikm: Bytes, salt: Bytes, info: string, bytes: number) {
    const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, [
        'deriveBits',
    ]);
    return new Uint8Array(
        await crypto.subtle.deriveBits(
            { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) },
            key,
            bytes * 8
        )
    );
}
async function hmac(key: Bytes, byte: number) {
    const k = await crypto.subtle.importKey(
        'raw',
        key,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    return new Uint8Array(
        await crypto.subtle.sign('HMAC', k, new Uint8Array([byte]))
    );
}
async function kdfRk(rk: Bytes, out: Bytes) {
    const bytes = await hkdf(out, rk, 'hush-ratchet-v1', 64);
    return [bytes.slice(0, 32), bytes.slice(32)];
}
// [next chain key, message key]
const kdfCk = async (ck: Bytes) => [await hmac(ck, 2), await hmac(ck, 1)];
async function aead(mk: Bytes, ad: Bytes, data: Bytes, open: boolean) {
    const bytes = await hkdf(mk, new Uint8Array(32), 'hush-message-v1', 44);
    const key = await crypto.subtle.importKey(
        'raw',
        bytes.slice(0, 32),
        'AES-GCM',
        false,
        [open ? 'decrypt' : 'encrypt']
    );
    const params = { name: 'AES-GCM', iv: bytes.slice(32), additionalData: ad };
    return new Uint8Array(
        await (open
            ? crypto.subtle.decrypt(params, key, data)
            : crypto.subtle.encrypt(params, key, data))
    );
}
const associated = (
    s: Session,
    header: Pick<RatchetKey, 'dh' | 'pn' | 'n'>,
    context: string
) =>
    enc.encode(
        JSON.stringify([
            'hush-dr-v1',
            s.ad,
            header.dh,
            header.pn,
            header.n,
            context,
        ])
    );
async function x3dh(parts: Bytes[]) {
    const ikm = new Uint8Array(32 * (parts.length + 1)).fill(0xff);
    parts.forEach((part, i) => ikm.set(part, 32 * (i + 1)));
    return hkdf(ikm, new Uint8Array(32), 'hush-x3dh-v1', 32);
}

async function skip(s: Session, until: number) {
    if (!s.ckr) return;
    if (until - s.nr > MAX_SKIP) throw new Error('Too many skipped messages.');
    while (s.nr < until) {
        const [ckr, mk] = await kdfCk(s.ckr);
        s.skipped.push([s.dhr!, s.nr, mk]);
        s.ckr = ckr;
        s.nr++;
    }
    if (s.skipped.length > MAX_SKIP)
        s.skipped.splice(0, s.skipped.length - MAX_SKIP);
}
async function decrypt(s: Session, e: RatchetKey, context: string) {
    const ad = associated(s, e, context);
    const data = unb64(e.data);
    const index = s.skipped.findIndex(([d, n]) => d === e.dh && n === e.n);
    if (index !== -1) {
        const [[, , mk]] = s.skipped.splice(index, 1);
        return aead(mk, ad, data, true);
    }
    if (e.dh !== s.dhr) {
        await skip(s, e.pn);
        s.pn = s.ns;
        s.ns = s.nr = 0;
        s.dhr = e.dh;
        [s.rk, s.ckr] = await kdfRk(s.rk, await dh(s.dhs.key, e.dh));
        s.dhs = await generate();
        [s.rk, s.cks] = await kdfRk(s.rk, await dh(s.dhs.key, e.dh));
    }
    await skip(s, e.n);
    const [ckr, mk] = await kdfCk(s.ckr!);
    s.ckr = ckr;
    s.nr++;
    return aead(mk, ad, data, true);
}

const B64 = /^[A-Za-z0-9_-]+$/;
const key43 = (x: unknown): x is string =>
    typeof x === 'string' && x.length === 43 && B64.test(x);
const counter = (x: unknown): x is number =>
    Number.isSafeInteger(x) && (x as number) >= 0 && (x as number) < COUNTER;
const only = (x: object, keys: string[]) =>
    Object.keys(x).every((key) => keys.includes(key));
export function validRatchetKey(e: unknown): e is RatchetKey {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
    const { dh, pn, n, data, pre } = e as RatchetKey;
    return (
        only(e, ['dh', 'pn', 'n', 'data', 'pre']) &&
        key43(dh) &&
        counter(pn) &&
        counter(n) &&
        typeof data === 'string' &&
        data.length === 64 &&
        B64.test(data) &&
        (pre === undefined ||
            (typeof pre === 'object' &&
                pre !== null &&
                only(pre, ['ek', 'spk', 'opk']) &&
                key43(pre.ek) &&
                counter(pre.spk) &&
                (pre.opk === undefined || counter(pre.opk))))
    );
}
export const validPrekey = (p: unknown): p is Prekey =>
    !!p &&
    typeof p === 'object' &&
    only(p, ['id', 'key']) &&
    counter((p as Prekey).id) &&
    key43((p as Prekey).key);

export function memoryStorage(): RatchetStorage {
    return {
        load: async () => ({ sessions: [], prekeys: [], opened: [], meta: [] }),
        put() {},
        delete() {},
        flush: async () => {},
    };
}

export class Ratchet {
    // Supplies a peer's prekey bundle; the server hands out one-time keys.
    fetch?: (id: string) => Promise<PrekeyBundle>;
    private sessions = new Map<string, Session[]>();
    private prekeys = new Map<number, Private>();
    private opened = new Map<string, Opened>();
    private locks = new Map<string, Promise<unknown>>();
    private vault?: Promise<CryptoKey>;
    private signed?: number;
    constructor(
        private identity: Pick<Identity, 'id' | 'dh' | 'sign' | 'bundle'>,
        private storage: RatchetStorage = memoryStorage()
    ) {}
    async load() {
        const data = await this.storage.load();
        this.sessions = new Map(data.sessions as [string, Session[]][]);
        this.prekeys = new Map(data.prekeys as [number, Private][]);
        this.opened = new Map(data.opened as [string, Opened][]);
        const meta = new Map(data.meta);
        this.signed = meta.get('signed') as number | undefined;
        const vault = meta.get('vault') as CryptoKey | undefined;
        if (vault) this.vault = Promise.resolve(vault);
        return this;
    }
    private exclusive<T>(peer: string, task: () => Promise<T>) {
        const run = (this.locks.get(peer) || Promise.resolve()).then(
            task,
            task
        );
        const tail = run.catch(() => {});
        this.locks.set(peer, tail);
        tail.then(() => {
            if (this.locks.get(peer) === tail) this.locks.delete(peer);
        });
        return run;
    }
    private save(peer: string, list: Session[]) {
        this.sessions.set(peer, list);
        this.storage.put('sessions', peer, list);
    }
    private promote(peer: string, session: Session, replaced?: Session) {
        const rest = (this.sessions.get(peer) || []).filter(
            (s) => s !== replaced && s.base !== session.base
        );
        this.save(peer, [session, ...rest].slice(0, MAX_SESSIONS));
    }
    private add(pair: Pair, sig?: string) {
        let id: number;
        do id = crypto.getRandomValues(new Uint32Array(1))[0] % COUNTER;
        while (this.prekeys.has(id));
        const record = { ...pair, sig, time: Date.now() };
        this.prekeys.set(id, record);
        this.storage.put('prekeys', id, record);
        return id;
    }
    // A signed prekey, rotated weekly, plus fresh one-time prekeys.
    async publish(count: number): Promise<Prekeys> {
        let spk =
            this.signed === undefined
                ? undefined
                : this.prekeys.get(this.signed);
        if (!spk?.sig || Date.now() - spk.time > SIGNED_PREKEY_MS) {
            const pair = await generate();
            const sig = await sign(
                this.identity as Identity,
                prekeyText(pair.pub)
            );
            this.signed = this.add(pair, sig);
            this.storage.put('meta', 'signed', this.signed);
            spk = this.prekeys.get(this.signed)!;
        }
        const opks: Prekey[] = [];
        for (let i = 0; i < count; i++) {
            const pair = await generate();
            opks.push({ id: this.add(pair), key: pair.pub });
        }
        const old = Array.from(this.prekeys)
            .filter(([id]) => id !== this.signed)
            .sort(([, a], [, b]) => a.time - b.time);
        for (const [id] of old.slice(
            0,
            Math.max(0, old.length - MAX_PREKEYS)
        )) {
            this.prekeys.delete(id);
            this.storage.delete('prekeys', id);
        }
        // Private halves must be stored before the public halves leave.
        await this.storage.flush();
        return { spk: { id: this.signed!, key: spk.pub, sig: spk.sig! }, opks };
    }
    // One bundle at a time, for tests that skip the server.
    async bundle(): Promise<PrekeyBundle> {
        const { spk, opks } = await this.publish(1);
        return { spk, opk: opks[0] };
    }

    async seal(peer: Recipient, plain: Bytes, context: string) {
        return this.exclusive(peer.id, async (): Promise<RatchetKey> => {
            let session = this.sessions.get(peer.id)?.[0];
            if (!session?.cks) session = await this.initiate(peer);
            if (session.ns >= COUNTER) throw new Error('Session exhausted.');
            const [cks, mk] = await kdfCk(session.cks!);
            const header = {
                dh: session.dhs.pub,
                pn: session.pn,
                n: session.ns,
            };
            session.cks = cks;
            session.ns++;
            const data = b64(
                await aead(
                    mk,
                    associated(session, header, context),
                    plain,
                    false
                )
            );
            this.save(peer.id, this.sessions.get(peer.id)!);
            await this.storage.flush();
            return {
                ...header,
                data,
                ...(session.pre && { pre: session.pre }),
            };
        });
    }
    async open(peer: Recipient, entry: RatchetKey, context: string) {
        return this.exclusive(peer.id, async () => {
            if (!validRatchetKey(entry))
                throw new RatchetError('Invalid message key.');
            const sessions = this.sessions.get(peer.id) || [];
            const pre = entry.pre;
            const known = pre && sessions.find((s) => s.base === pre.ek);
            const candidates = pre
                ? [known || (await this.respond(peer, pre))]
                : sessions;
            for (const original of candidates) {
                const session = structuredClone(original);
                const plain = await decrypt(session, entry, context).catch(
                    () => null
                );
                if (!plain) continue;
                session.pre = undefined;
                // A one-time prekey opens exactly one session.
                if (pre?.opk !== undefined && !known) {
                    this.prekeys.delete(pre.opk);
                    this.storage.delete('prekeys', pre.opk);
                }
                this.promote(peer.id, session, original);
                return plain;
            }
            throw new RatchetError('This message could not be decrypted.');
        });
    }
    // Starts a new X3DH session, after this browser lost a message key.
    async restart(peer: Recipient) {
        await this.exclusive(peer.id, () => this.initiate(peer));
    }
    private async checkPeer(peer: Recipient) {
        if ((await identityId(peer.bundle)) !== peer.id)
            throw new Error('Invalid participant identity.');
    }
    private async initiate(peer: Recipient) {
        await this.checkPeer(peer);
        if (!this.fetch) throw new Error('This person has no prekeys yet.');
        const { spk, opk } = await this.fetch(peer.id);
        if (
            !validPrekey({ id: spk?.id, key: spk?.key }) ||
            (opk !== undefined && !validPrekey(opk)) ||
            !(await verify(peer.bundle, prekeyText(spk.key), spk.sig))
        )
            throw new Error('This person’s prekeys could not be verified.');
        const ek = await generate();
        const secret = await x3dh([
            await dh(this.identity.dh.privateKey, spk.key),
            await dh(ek.key, peer.bundle.dh),
            await dh(ek.key, spk.key),
            ...(opk ? [await dh(ek.key, opk.key)] : []),
        ]);
        const dhs = await generate();
        const [rk, cks] = await kdfRk(secret, await dh(dhs.key, spk.key));
        const session: Session = {
            ad: `${this.identity.id}:${peer.id}`,
            base: ek.pub,
            rk,
            dhs,
            dhr: spk.key,
            cks,
            ns: 0,
            nr: 0,
            pn: 0,
            skipped: [],
            pre: { ek: ek.pub, spk: spk.id, ...(opk && { opk: opk.id }) },
        };
        this.promote(peer.id, session);
        return session;
    }
    private async respond(
        peer: Recipient,
        pre: NonNullable<RatchetKey['pre']>
    ): Promise<Session> {
        await this.checkPeer(peer);
        const spk = this.prekeys.get(pre.spk);
        const opk =
            pre.opk === undefined ? undefined : this.prekeys.get(pre.opk);
        if (!spk?.sig || (pre.opk !== undefined && (!opk || opk.sig)))
            throw new RatchetError('That prekey is no longer available.');
        return {
            ad: `${peer.id}:${this.identity.id}`,
            base: pre.ek,
            rk: await x3dh([
                await dh(spk.key, peer.bundle.dh),
                await dh(this.identity.dh.privateKey, pre.ek),
                await dh(spk.key, pre.ek),
                ...(opk ? [await dh(opk.key, pre.ek)] : []),
            ]),
            dhs: { key: spk.key, pub: spk.pub },
            ns: 0,
            nr: 0,
            pn: 0,
            skipped: [],
        };
    }

    // The author's own copy of a message key, sealed with a key that never
    // leaves this browser.
    private key() {
        this.vault ||= crypto.subtle
            .generateKey({ name: 'AES-GCM', length: 256 }, false, [
                'encrypt',
                'decrypt',
            ])
            .then((key) => {
                this.storage.put('meta', 'vault', key);
                return key;
            });
        return this.vault;
    }
    async lock(plain: Bytes, context: string): Promise<SelfKey> {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const data = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv, additionalData: enc.encode(context) },
            await this.key(),
            plain
        );
        await this.storage.flush();
        return { iv: b64(iv), data: b64(data) };
    }
    async unlock(entry: SelfKey, context: string) {
        return new Uint8Array(
            await crypto.subtle.decrypt(
                {
                    name: 'AES-GCM',
                    iv: unb64(entry.iv),
                    additionalData: enc.encode(context),
                },
                await this.key(),
                unb64(entry.data)
            )
        );
    }

    // Message keys already opened, so history can be read again after a
    // reload. They are deleted with their messages and on a server restart.
    remember(id: string, from: string, scope: string, key: Bytes) {
        const record = { from, scope, key: key.slice() };
        this.opened.set(id, record);
        this.storage.put('opened', id, record);
    }
    recall(id: string, from: string) {
        const record = this.opened.get(id);
        return record?.from === from ? record.key.slice() : undefined;
    }
    forget(ids: Iterable<string>) {
        for (const id of ids)
            if (this.opened.delete(id)) this.storage.delete('opened', id);
    }
    forgetScope(scope: string) {
        this.forget(
            Array.from(this.opened)
                .filter(([, record]) => record.scope === scope)
                .map(([id]) => id)
        );
    }
}

// Resolves once this tab holds the key storage lock, taking it from any other
// tab. The returned check turns false when a newer tab takes it back.
export function claimStorage(): Promise<() => boolean> {
    if (!navigator.locks) return Promise.resolve(() => true);
    let owner = false;
    return new Promise((resolve) => {
        navigator.locks
            .request('hush-ratchet', { steal: true }, () => {
                owner = true;
                resolve(() => owner);
                return new Promise(() => {});
            })
            .catch(() => {
                owner = false;
                resolve(() => owner);
            });
    });
}

const STORES: Store[] = ['sessions', 'prekeys', 'opened', 'meta'];
function request<T>(r: IDBRequest<T>) {
    return new Promise<T>((resolve, reject) => {
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
}
const done = (tx: IDBTransaction) =>
    new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error);
    });
// Persistent state for one server boot. A restart wipes everything. Once
// another tab takes the lock, this tab stops writing and stops sealing.
export async function browserStorage(
    boot: string,
    owner: () => boolean
): Promise<RatchetStorage> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open('hush-ratchet', 1);
        open.onupgradeneeded = () => {
            for (const store of STORES) open.result.createObjectStore(store);
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () =>
            reject(new Error('Browser key storage is unavailable.'));
    });
    const reset = db.transaction(STORES, 'readwrite');
    if ((await request(reset.objectStore('meta').get('boot'))) !== boot) {
        for (const store of STORES) reset.objectStore(store).clear();
        reset.objectStore('meta').put(boot, 'boot');
    }
    await done(reset);
    let ops: [Store, IDBValidKey, unknown][] = [];
    let written = Promise.resolve();
    const write = () => {
        const batch = ops;
        ops = [];
        if (!batch.length || !owner()) return;
        const tx = db.transaction(STORES, 'readwrite');
        for (const [store, key, value] of batch)
            if (value === undefined) tx.objectStore(store).delete(key);
            else tx.objectStore(store).put(value, key);
        // A failed write is not retried; the next one still goes ahead.
        written = done(tx).catch(() => {});
    };
    const queue = (op: [Store, IDBValidKey, unknown]) => {
        if (ops.push(op) === 1) queueMicrotask(write);
    };
    return {
        async load() {
            const read = db.transaction(STORES);
            const entries = async (store: Store) => {
                const s = read.objectStore(store);
                const [keys, values] = await Promise.all([
                    request(s.getAllKeys()),
                    request(s.getAll()),
                ]);
                return keys.map(
                    (key, i) => [key, values[i]] as [IDBValidKey, unknown]
                );
            };
            const [sessions, prekeys, opened, meta] = await Promise.all(
                STORES.map(entries)
            );
            return { sessions, prekeys, opened, meta };
        },
        put: (store, key, value) => queue([store, key, value]),
        delete: (store, key) => queue([store, key, undefined]),
        async flush() {
            write();
            if (!owner()) throw new Error('Hush was opened in another tab.');
            await written;
        },
    };
}
