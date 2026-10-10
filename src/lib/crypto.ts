import type { Identity, Bundle, Recipient, Envelope } from '../types';
// Browser-native primitives. The relay never receives private keys or plaintext.
const enc = new TextEncoder();
const dec = new TextDecoder();
export const VERSION = 2;
export const b64 = (bytes: ArrayBuffer | Uint8Array) => {
    let value = '';
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < view.length; i += 8192)
        value += String.fromCharCode(...view.subarray(i, i + 8192));
    return btoa(value)
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
};
export const unb64 = (value: string) =>
    Uint8Array.from(
        atob(value.replaceAll('-', '+').replaceAll('_', '/')),
        (c) => c.charCodeAt(0)
    );
export const randomId = () => crypto.randomUUID();

export async function identityId(bundle: Bundle) {
    return b64(
        await crypto.subtle.digest(
            'SHA-256',
            enc.encode(JSON.stringify([bundle.dh, bundle.sign]))
        )
    );
}

export async function createIdentity(): Promise<Identity> {
    const dh = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveBits']
    );
    const sign = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign', 'verify']
    );
    const bundle = {
        dh: b64(await crypto.subtle.exportKey('raw', dh.publicKey)),
        sign: b64(await crypto.subtle.exportKey('raw', sign.publicKey)),
    };
    return { dh, sign, bundle, id: await identityId(bundle) };
}

function database() {
    return new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('hush-keys', 1);
        request.onupgradeneeded = () =>
            request.result.createObjectStore('keys');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
            reject(
                new Error(
                    'Browser key storage is unavailable. Allow site storage to use Hush.'
                )
            );
    });
}

export async function loadIdentity(): Promise<Identity> {
    const db = await database();
    try {
        const identity = await new Promise<Identity | undefined>(
            (resolve, reject) => {
                const request = db
                    .transaction('keys')
                    .objectStore('keys')
                    .get('identity');
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            }
        );
        if (identity) return identity;
        const fresh = await createIdentity();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('keys', 'readwrite');
            tx.objectStore('keys').put(fresh, 'identity');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        return fresh;
    } finally {
        db.close();
    }
}

export async function sign(identity: Identity, text: string) {
    return b64(
        await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            identity.sign.privateKey,
            enc.encode(text)
        )
    );
}
export async function verify(bundle: Bundle, text: string, signature: string) {
    try {
        const key = await crypto.subtle.importKey(
            'raw',
            unb64(bundle.sign),
            { name: 'ECDSA', namedCurve: 'P-256' },
            false,
            ['verify']
        );
        return await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            key,
            unb64(signature),
            enc.encode(text)
        );
    } catch {
        return false;
    }
}
export const proofText = (
    origin: string,
    boot: string,
    nonce: string,
    id: string,
    name: string
) => JSON.stringify(['hush-join-v1', origin, boot, nonce, id, name]);
export const dmScope = (a: string, b: string) =>
    `dm:${[a, b].sort().join(':')}`;
export const aadText = (m: Envelope) =>
    JSON.stringify([
        m.v,
        m.boot,
        m.id,
        m.from,
        m.scope,
        m.type,
        m.time,
        m.targets ?? null,
        m.revision ?? null,
    ]);
export const signedText = (m: Envelope) =>
    JSON.stringify([
        aadText(m),
        m.iv,
        m.data,
        Object.entries(m.keys).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ]);

async function pairKey(identity: Identity, peer: Recipient, boot: string) {
    if ((await identityId(peer.bundle)) !== peer.id)
        throw new Error('Invalid participant identity.');
    const publicKey = await crypto.subtle.importKey(
        'raw',
        unb64(peer.bundle.dh),
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        []
    );
    const bits = await crypto.subtle.deriveBits(
        { name: 'ECDH', public: publicKey },
        identity.dh.privateKey,
        256
    );
    const material = await crypto.subtle.importKey('raw', bits, 'HKDF', false, [
        'deriveKey',
    ]);
    return crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: enc.encode(boot),
            info: enc.encode(
                `hush-wrap-v1:${[identity.id, peer.id].sort().join(':')}`
            ),
        },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

export async function seal(
    identity: Identity,
    peers: Recipient[],
    boot: string,
    scope: string,
    type: Envelope['type'],
    payload: unknown,
    operation: { targets?: string[]; revision?: string } = {}
): Promise<Envelope> {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    try {
        const key = await crypto.subtle.importKey(
            'raw',
            raw,
            'AES-GCM',
            false,
            ['encrypt']
        );
        const m: Envelope = {
            v: VERSION,
            boot,
            id: randomId(),
            from: identity.id,
            scope,
            type,
            time: Date.now(),
            iv: b64(crypto.getRandomValues(new Uint8Array(12))),
            keys: {},
            data: '',
            sig: '',
            ...operation,
        };
        const aad = enc.encode(aadText(m));
        m.data = b64(
            await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv: unb64(m.iv), additionalData: aad },
                key,
                enc.encode(JSON.stringify(payload))
            )
        );
        for (const peer of peers) {
            if (m.keys[peer.id]) continue;
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const wrapped = await crypto.subtle.encrypt(
                {
                    name: 'AES-GCM',
                    iv,
                    additionalData: enc.encode(`${aadText(m)}:${peer.id}`),
                },
                await pairKey(identity, peer, boot),
                raw
            );
            m.keys[peer.id] = { iv: b64(iv), data: b64(wrapped) };
        }
        m.sig = await sign(identity, signedText(m));
        return m;
    } finally {
        raw.fill(0);
    }
}

export async function contentKey(
    identity: Identity,
    sender: Recipient,
    boot: string,
    m: Envelope
): Promise<Uint8Array<ArrayBuffer>> {
    if (
        m.v !== VERSION ||
        m.boot !== boot ||
        m.from !== sender.id ||
        !m.keys[identity.id]
    )
        throw new Error('This message is not addressed to this browser.');
    if (
        (await identityId(sender.bundle)) !== sender.id ||
        !(await verify(sender.bundle, signedText(m), m.sig))
    )
        throw new Error('Message signature did not verify.');
    const wrap = m.keys[identity.id];
    return new Uint8Array(
        await crypto.subtle.decrypt(
            {
                name: 'AES-GCM',
                iv: unb64(wrap.iv),
                additionalData: enc.encode(`${aadText(m)}:${identity.id}`),
            },
            await pairKey(identity, sender, boot),
            unb64(wrap.data)
        )
    );
}

// A history grant forwards only a content key. The original author's signed
// ciphertext is verified separately, so a sharer cannot rewrite its contents.
export async function openWithKey<T = unknown>(
    sender: Recipient,
    boot: string,
    m: Envelope,
    raw: Uint8Array<ArrayBuffer>
): Promise<T> {
    if (
        raw.byteLength !== 32 ||
        m.v !== VERSION ||
        m.boot !== boot ||
        m.from !== sender.id ||
        (await identityId(sender.bundle)) !== sender.id ||
        !(await verify(sender.bundle, signedText(m), m.sig))
    )
        throw new Error('The original message could not be verified.');
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [
        'decrypt',
    ]);
    const plaintext = await crypto.subtle.decrypt(
        {
            name: 'AES-GCM',
            iv: unb64(m.iv),
            additionalData: enc.encode(aadText(m)),
        },
        key,
        unb64(m.data)
    );
    return JSON.parse(dec.decode(plaintext));
}

export async function open<T = unknown>(
    identity: Identity,
    sender: Recipient,
    boot: string,
    m: Envelope
): Promise<T> {
    const raw = await contentKey(identity, sender, boot, m);
    try {
        return await openWithKey<T>(sender, boot, m, raw);
    } finally {
        raw.fill(0);
    }
}

export async function safetyCode(a: string, b: string) {
    const bytes = new Uint8Array(
        await crypto.subtle.digest(
            'SHA-256',
            enc.encode(`hush-safety-v1:${[a, b].sort().join(':')}`)
        )
    );
    return Array.from({ length: 8 }, (_, i) =>
        String(new DataView(bytes.buffer).getUint32(i * 4) % 100000).padStart(
            5,
            '0'
        )
    ).join(' ');
}

export const messageId = (envelope: Envelope) =>
    envelope.type === 'edit' ? envelope.targets![0] : envelope.id;

export async function grantRecipient(
    source: Envelope,
    grant: Envelope,
    sharer: Recipient,
    authorized: ReadonlySet<string> = new Set(Object.keys(source.keys))
) {
    const ids = Object.keys(grant.keys);
    if (
        grant.v !== VERSION ||
        grant.boot !== source.boot ||
        grant.type !== 'share' ||
        source.scope !== 'room' ||
        grant.scope !== 'room' ||
        !['chat', 'edit'].includes(source.type) ||
        grant.targets?.length !== 1 ||
        grant.targets[0] !== messageId(source) ||
        grant.revision !== source.id ||
        grant.from !== sharer.id ||
        !authorized.has(sharer.id) ||
        ids.length !== 2 ||
        !ids.includes(sharer.id) ||
        (await identityId(sharer.bundle)) !== sharer.id ||
        !(await verify(sharer.bundle, signedText(grant), grant.sig))
    )
        throw new Error('The history invitation could not be verified.');
    return ids.find((id) => id !== sharer.id)!;
}
