import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createChatServer } from '../server/app';
import { readConfig } from '../server/config';
import {
    dmScope,
    open,
    proofText,
    seal,
    sign,
    contentKey,
    openWithKey,
    grantRecipient,
    partHashes,
    partKey,
    sealPart,
    readPart,
    openPart,
    b64,
    unb64,
    verify,
    prekeyText,
    signedText,
} from '../src/lib/crypto';
import { createIdentity } from './identities';
import { normalizeName, MAX_FILE_BYTES, PART_BYTES } from '../src/lib/limits';
import { validateContent } from '../src/lib/content';
import type { Identity, ServerPacket, Envelope } from '../src/types';
import { request } from 'node:http';

// Use the native HTTP client so Host can emulate Caddy's upstream requests.
function fetch(
    url: string,
    options: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
    } = {}
) {
    return new Promise<{
        status: number;
        headers: { get: (name: string) => string | null };
    }>((resolve, reject) => {
        const req = request(
            url,
            { method: options.method, headers: options.headers },
            (response) => {
                response.resume();
                response.on('end', () =>
                    resolve({
                        status: response.statusCode!,
                        headers: {
                            get: (name) => {
                                const value = response.headers[name];
                                return Array.isArray(value)
                                    ? value.join('; ')
                                    : value || null;
                            },
                        },
                    })
                );
            }
        );
        req.on('error', reject);
        req.end(options.body);
    });
}

const origin = 'https://chat.test';
const password = 'test-password-only-not-a-real-secret';
const config = readConfig({
    APP_PASSWORD: password,
    APP_ORIGIN: origin,
    MEDIA_PORT: '0',
    MEDIA_LISTEN_IP: '127.0.0.1',
    MEDIA_ANNOUNCED_ADDRESS: '127.0.0.1',
});
const headers = {
    host: 'chat.test',
    origin,
    'x-forwarded-proto': 'https',
    'content-type': 'application/json',
};

async function fixture() {
    const app = createChatServer(config);
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    async function login() {
        const response = await fetch(`${url}/api/login`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ password }),
        });
        assert.equal(response.status, 200);
        return response.headers.get('set-cookie')!.split(';')[0];
    }
    async function join(
        name: string,
        identity?: Identity,
        cookie?: string,
        rejected = false
    ) {
        identity ||= await createIdentity();
        cookie ||= await login();
        const ws = new WebSocket(`${url.replace('http:', 'ws:')}/ws`, {
            headers: { ...headers, cookie },
        });
        const packets: ServerPacket[] = [];
        const parts: Buffer[] = [];
        ws.on('message', (data, isBinary) => {
            if (isBinary) parts.push(data as Buffer);
            else packets.push(JSON.parse(data.toString()));
        });
        async function wait(type: ServerPacket['type']) {
            const start = Date.now();
            while (Date.now() - start < 3000) {
                const index = packets.findIndex(
                    (packet) => packet.type === type
                );
                if (index !== -1) return packets.splice(index, 1)[0];
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            throw new Error(`Timed out waiting for ${type}`);
        }
        const challenge = await wait('challenge');
        assert.equal(challenge.type, 'challenge');
        if (challenge.type !== 'challenge')
            throw new Error('Missing challenge');
        ws.send(
            JSON.stringify({
                type: 'join',
                id: identity.id,
                bundle: identity.bundle,
                name,
                sig: await sign(
                    identity,
                    proofText(
                        origin,
                        challenge.boot,
                        challenge.nonce,
                        identity.id,
                        normalizeName(name)
                    )
                ),
                prekeys: await identity.ratchet.publish(20),
            })
        );
        if (rejected) {
            const [code, reason] = await once(ws, 'close');
            return {
                ws,
                identity,
                cookie,
                packets,
                parts,
                wait,
                code,
                reason: String(reason),
            };
        }
        await wait('ready');
        await wait('history-end');
        return {
            ws,
            identity,
            cookie,
            packets,
            parts,
            wait,
            code: 0,
            reason: '',
        };
    }
    return { app, url, join, login };
}

test('HTTPS proxy, origin, password, cookie and asset boundaries are enforced', async () => {
    const f = await fixture();
    try {
        assert.equal((await fetch(f.url)).status, 426);
        assert.equal(
            (await fetch(`${f.url}/api/session`, { headers })).status,
            401
        );
        assert.equal((await fetch(`${f.url}/.env`, { headers })).status, 404);
        assert.equal(
            (await fetch(`${f.url}/server/app.ts`, { headers })).status,
            404
        );
        assert.equal(
            (
                await fetch(`${f.url}/api/login`, {
                    method: 'POST',
                    headers: { ...headers, origin: 'https://evil.test' },
                    body: JSON.stringify({ password }),
                })
            ).status,
            403
        );
        assert.equal(
            (
                await fetch(`${f.url}/api/login`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ password: 'wrong' }),
                })
            ).status,
            401
        );
        const response = await fetch(`${f.url}/api/login`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ password }),
        });
        assert.match(
            response.headers.get('set-cookie')!,
            /HttpOnly; Secure; SameSite=Strict/
        );
        assert.match(response.headers.get('cache-control')!, /no-store/);
        const ws = new WebSocket(f.url.replace('http:', 'ws:') + '/ws', {
            headers,
        });
        const [error] = await once(ws, 'error');
        assert.match(String(error), /403/);
    } finally {
        await f.app.close();
    }
});

test('DMs stay between recipients, history survives reconnect, and a fresh process starts empty', async () => {
    const f = await fixture();
    try {
        const alice = await f.join('Alice');
        const bob = await f.join('Bob');
        const charlie = await f.join('Charlie');
        const envelope = await seal(
            alice.identity,
            [alice.identity, bob.identity],
            f.app.boot,
            dmScope(alice.identity.id, bob.identity.id),
            'chat',
            { kind: 'text', text: 'Private for Bob' }
        );
        alice.ws.send(JSON.stringify({ type: 'envelope', envelope }));
        const delivered = await bob.wait('message');
        assert.equal(delivered.type, 'message');
        if (delivered.type === 'message')
            assert.deepEqual(
                await open(
                    bob.identity,
                    alice.identity,
                    f.app.boot,
                    delivered.envelope
                ),
                { kind: 'text', text: 'Private for Bob' }
            );
        await alice.wait('ack');
        assert.equal(
            charlie.packets.some((p) => p.type === 'message'),
            false
        );
        assert.equal(f.app.stats().messages, 1);
        alice.ws.send(JSON.stringify({ type: 'envelope', envelope }));
        await alice.wait('ack');
        assert.equal(f.app.stats().messages, 1);
        bob.ws.close();
        await once(bob.ws, 'close');
        const rejoined = await f.join('Bob', bob.identity, bob.cookie);
        assert.equal(
            rejoined.packets.filter((p) => p.type === 'message').length,
            1
        );
        alice.ws.close();
        rejoined.ws.close();
        charlie.ws.close();
        await Promise.all([
            once(alice.ws, 'close'),
            once(rejoined.ws, 'close'),
            once(charlie.ws, 'close'),
        ]);
        assert.equal(
            f.app.stats().messages,
            1,
            'leaving does not delete history'
        );
    } finally {
        await f.app.close();
    }
    const restarted = await fixture();
    try {
        assert.equal(restarted.app.stats().messages, 0);
    } finally {
        await restarted.app.close();
    }
});

test('a reconnecting browser replaces its stale socket instead of being locked out', async () => {
    const f = await fixture();
    try {
        const alice = await f.join('Alice');
        const bob = await f.join('Bob');
        const closed = once(alice.ws, 'close');
        // Same browser, new tab or reload, while the old socket still looks open.
        const again = await f.join('Alice', alice.identity, alice.cookie);
        const [code, reason] = await closed;
        assert.equal(code, 4009);
        assert.match(String(reason), /another tab/);
        assert.equal(f.app.stats().online, 2);
        const envelope = await seal(
            bob.identity,
            [bob.identity, alice.identity],
            f.app.boot,
            'room',
            'chat',
            { kind: 'text', text: 'Reaches the new tab' }
        );
        await transmit(bob, envelope);
        await delivered(again);
        assert.equal(
            bob.packets.some(
                (p) => p.type === 'presence' && p.event.action === 'left'
            ),
            false,
            'replacing a tab is not announced as leaving'
        );
    } finally {
        await f.app.close();
    }
});

test('forged signatures and attempts to leak a DM to a third recipient are rejected', async () => {
    for (const mode of ['signature', 'recipient']) {
        const f = await fixture();
        try {
            const alice = await f.join('Alice');
            const bob = await f.join('Bob');
            const charlie = await f.join('Charlie');
            const envelope = await seal(
                alice.identity,
                mode === 'recipient'
                    ? [alice.identity, bob.identity, charlie.identity]
                    : [alice.identity, bob.identity],
                f.app.boot,
                dmScope(alice.identity.id, bob.identity.id),
                'chat',
                { kind: 'text', text: 'private' }
            );
            if (mode === 'signature')
                envelope.data = `${envelope.data[0] === 'A' ? 'B' : 'A'}${envelope.data.slice(1)}`;
            alice.ws.send(JSON.stringify({ type: 'envelope', envelope }));
            const [code] = await once(alice.ws, 'close');
            assert.equal(code, 1008);
            assert.equal(f.app.stats().messages, 0);
        } finally {
            await f.app.close();
        }
    }
});

test('prekeys are signed, handed out once, replenished, and envelope keys keep their roles', async () => {
    const f = await fixture();
    try {
        const mallory = await createIdentity();
        const stolen = await (await createIdentity()).ratchet.publish(1);
        mallory.ratchet.publish = async () => stolen;
        const refused = await f.join('Mallory', mallory, undefined, true);
        assert.equal(refused.code, 1008, 'a signed prekey must be our own');

        const alice = await f.join('Alice');
        const bob = await f.join('Bob');
        let request = 0;
        const ask = async (id: string) => {
            alice.ws.send(
                JSON.stringify({ type: 'bundle', request: ++request, id })
            );
            const reply = await alice.wait('bundle');
            if (reply.type !== 'bundle' || reply.request !== request)
                throw new Error('Unexpected bundle reply');
            return reply;
        };
        assert.match((await ask(alice.identity.id)).error!, /no longer here/);
        const handed = new Set<number>();
        for (let i = 0; i < 20; i++) {
            const { bundle } = await ask(bob.identity.id);
            assert.ok(bundle?.opk && !handed.has(bundle.opk.id));
            handed.add(bundle.opk.id);
            assert.ok(
                await verify(
                    bob.identity.bundle,
                    prekeyText(bundle.spk.key),
                    bundle.spk.sig
                )
            );
        }
        const low = await bob.wait('prekeys');
        assert.deepEqual(low, { type: 'prekeys', remaining: 4 });
        assert.equal(
            bob.packets.some((p) => p.type === 'prekeys'),
            false,
            'the owner is asked once'
        );
        assert.equal((await ask(bob.identity.id)).bundle?.opk, undefined);
        bob.ws.send(
            JSON.stringify({
                type: 'prekeys',
                ...(await bob.identity.ratchet.publish(20)),
            })
        );
        alice.identity.ratchet.fetch = async (id) => (await ask(id)).bundle!;
        const envelope = await seal(
            alice.identity,
            [alice.identity, bob.identity],
            f.app.boot,
            'room',
            'chat',
            { kind: 'text', text: 'Through server prekeys' }
        );
        const entry = envelope.keys[bob.identity.id];
        assert.ok('pre' in entry && entry.pre?.opk !== undefined);
        await transmit(alice, envelope);
        assert.deepEqual(
            await open(
                bob.identity,
                alice.identity,
                f.app.boot,
                (await delivered(bob)).envelope
            ),
            { kind: 'text', text: 'Through server prekeys' }
        );

        // The author's entry is a self key and every other entry a ratchet key.
        for (const swap of ['author', 'recipient']) {
            const m = await seal(
                alice.identity,
                [alice.identity, bob.identity],
                f.app.boot,
                'room',
                'chat',
                { kind: 'text', text: 'Wrong roles' }
            );
            const [self, other] = [
                m.keys[alice.identity.id],
                m.keys[bob.identity.id],
            ];
            m.keys =
                swap === 'author'
                    ? { [alice.identity.id]: other, [bob.identity.id]: other }
                    : { [alice.identity.id]: self, [bob.identity.id]: self };
            m.sig = await sign(alice.identity, signedText(m));
            const closed = once(alice.ws, 'close');
            alice.ws.send(JSON.stringify({ type: 'envelope', envelope: m }));
            assert.equal((await closed)[0], 1008);
            if (swap === 'author')
                Object.assign(
                    alice,
                    await f.join('Alice', alice.identity, alice.cookie)
                );
        }
    } finally {
        await f.app.close();
    }
});

test('a full RAM store rejects new messages without deleting earlier ones', async () => {
    const f = await fixture();
    try {
        const alice = await f.join('Alice');
        // Fill with encrypted payloads; production memory capacity is shared with this config.
        const prior = config.maxHistoryBytes;
        config.maxHistoryBytes = 3500;
        try {
            const first = await seal(
                alice.identity,
                [alice.identity],
                f.app.boot,
                'room',
                'chat',
                { kind: 'text', text: 'keep me' }
            );
            alice.ws.send(
                JSON.stringify({ type: 'envelope', envelope: first })
            );
            await alice.wait('ack');
            const second = await seal(
                alice.identity,
                [alice.identity],
                f.app.boot,
                'room',
                'chat',
                { kind: 'text', text: 'x'.repeat(4000) }
            );
            alice.ws.send(
                JSON.stringify({ type: 'envelope', envelope: second })
            );
            await alice.wait('error');
            assert.equal(f.app.stats().messages, 1);
        } finally {
            config.maxHistoryBytes = prior;
        }
    } finally {
        await f.app.close();
    }
});

type Participant = Awaited<
    ReturnType<Awaited<ReturnType<typeof fixture>>['join']>
>;
async function transmit(
    person: Participant,
    envelope: Envelope,
    result: 'ack' | 'error' = 'ack'
) {
    person.ws.send(JSON.stringify({ type: 'envelope', envelope }));
    const packet = await person.wait(result);
    assert.equal(packet.type, result);
    if (packet.type === 'ack' || packet.type === 'error')
        assert.equal(packet.id, envelope.id);
    return packet;
}
async function delivered(person: Participant) {
    const packet = await person.wait('message');
    assert.equal(packet.type, 'message');
    if (packet.type !== 'message') throw new Error('Missing message');
    return packet;
}
async function fileMessage(
    author: Identity,
    audience: Identity[],
    boot: string,
    data: Uint8Array<ArrayBuffer>
) {
    const hashes = await partHashes(data);
    const payload = {
        kind: 'file' as const,
        name: 'synthetic-test.dat',
        mime: 'application/octet-stream',
        size: data.length,
        hashes,
    };
    const envelope = await seal(
        author,
        audience,
        boot,
        'room',
        'chat',
        payload,
        {
            parts: hashes.length,
        }
    );
    const key = await partKey(await contentKey(author, author, boot, envelope));
    const frames: Uint8Array<ArrayBuffer>[] = [];
    for (let i = 0; i < hashes.length; i++)
        frames.push(
            await sealPart(
                key,
                envelope,
                i,
                data.subarray(i * PART_BYTES, (i + 1) * PART_BYTES)
            )
        );
    return { envelope, payload, frames };
}
async function upload(
    person: Participant,
    file: Awaited<ReturnType<typeof fileMessage>>
) {
    person.ws.send(
        JSON.stringify({ type: 'envelope', envelope: file.envelope })
    );
    for (const frame of file.frames) person.ws.send(frame);
    const packet = await person.wait('ack');
    assert.ok(packet.type === 'ack' && packet.id === file.envelope.id);
    const progress = person.packets.filter((p) => p.type === 'progress');
    assert.equal(progress.length, file.frames.length - 1);
    person.packets.splice(
        0,
        Infinity,
        ...person.packets.filter((p) => p.type !== 'progress')
    );
}
async function receivedParts(person: Participant, count: number, id?: string) {
    // Recipients fetch parts on demand; the relay never pushes them unasked.
    if (id) person.ws.send(JSON.stringify({ type: 'fetch', id }));
    const start = Date.now();
    while (person.parts.length < count && Date.now() - start < 3000)
        await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(person.parts.length, count);
    return person.parts.splice(0, count);
}

test('any room member can clear all authors and shared files, while DMs, calls and replay protection survive', async () => {
    const f = await fixture();
    try {
        const alice = await f.join('Alice');
        const bob = await f.join('Bob');
        const audience = [alice.identity, bob.identity];
        const original = await seal(
            alice.identity,
            audience,
            f.app.boot,
            'room',
            'chat',
            { kind: 'text', text: 'Room history' }
        );
        const file = await fileMessage(
            bob.identity,
            audience,
            f.app.boot,
            new Uint8Array(4096)
        );
        const scope = dmScope(alice.identity.id, bob.identity.id);
        const dm = await seal(
            alice.identity,
            audience,
            f.app.boot,
            scope,
            'chat',
            { kind: 'text', text: 'Private history' }
        );
        await transmit(alice, original);
        await upload(bob, file);
        const roomBytes = f.app.stats().historyBytes;
        await transmit(alice, dm);
        const privateBytes = f.app.stats().historyBytes - roomBytes;
        const charlie = await f.join('Charlie');
        const grant = await seal(
            alice.identity,
            [alice.identity, charlie.identity],
            f.app.boot,
            'room',
            'share',
            {
                kind: 'history',
                key: b64(
                    await contentKey(
                        alice.identity,
                        alice.identity,
                        f.app.boot,
                        original
                    )
                ),
            },
            { targets: [original.id], revision: original.id }
        );
        await transmit(alice, grant);
        alice.ws.send(JSON.stringify({ type: 'call', scope: 'room' }));
        bob.ws.close();
        await once(bob.ws, 'close');
        const clear = { type: 'clear', id: crypto.randomUUID(), scope: 'room' };
        charlie.ws.send(JSON.stringify(clear));
        await charlie.wait('ack');
        assert.equal(
            f.app.stats().messages,
            1,
            'all room authors, files and grants are removed'
        );
        assert.equal(f.app.stats().historyBytes, privateBytes);
        assert.equal(
            f.app.stats().online,
            2,
            'clearing does not sign anyone out'
        );
        await alice.wait('cleared');
        const replay = await transmit(alice, original);
        assert.ok(
            replay.type === 'ack' && replay.deleted,
            'old ciphertext cannot resurrect a cleared message'
        );
        const fresh = await seal(
            alice.identity,
            [alice.identity, charlie.identity],
            f.app.boot,
            'room',
            'chat',
            { kind: 'text', text: 'After clearing' }
        );
        await transmit(alice, fresh);
        charlie.ws.send(JSON.stringify(clear));
        await charlie.wait('ack');
        assert.equal(
            f.app.stats().messages,
            2,
            'retrying a clear does not erase newer messages'
        );
        const returned = await f.join('Bob', bob.identity, bob.cookie);
        const marker = returned.packets.findIndex((p) => p.type === 'cleared');
        const firstMessage = returned.packets.findIndex(
            (p) => p.type === 'message'
        );
        assert.ok(
            marker >= 0 && marker < firstMessage,
            'offline readers learn about clearing before history'
        );
        const deliveredDm = await delivered(returned);
        assert.equal(deliveredDm.envelope.id, dm.id);
        const callPacket = returned.packets.find((p) => p.type === 'peers');
        assert.ok(
            callPacket?.type === 'peers' &&
                callPacket.peers.find((p) => p.id === alice.identity.id)
                    ?.call === 'room'
        );
        charlie.packets.length = 0;
        returned.ws.send(
            JSON.stringify({ type: 'clear', id: crypto.randomUUID(), scope })
        );
        await returned.wait('ack');
        assert.equal(
            f.app.stats().messages,
            1,
            'either DM participant can clear that DM'
        );
        assert.ok(
            !charlie.packets.some((p) => p.type === 'cleared'),
            'private clearing stays private'
        );
        // An authenticated third person still cannot clear somebody else's DM.
        charlie.ws.send(
            JSON.stringify({ type: 'clear', id: crypto.randomUUID(), scope })
        );
        const [code] = await once(charlie.ws, 'close');
        assert.equal(code, 1008);
        assert.equal(f.app.stats().messages, 1);
        alice.ws.send(
            JSON.stringify({
                type: 'clear',
                id: crypto.randomUUID(),
                scope: 'room',
            })
        );
        await alice.wait('ack');
        assert.equal(f.app.stats().historyBytes, 0);
    } finally {
        await f.app.close();
    }
});

test('names are normalized, unique while offline, and reclaimable only by the same identity; presence announces joins and leaves', async () => {
    const f = await fixture();
    try {
        const alice = await f.join('Alice');
        const bob = await f.join('Bob');
        const joined = await alice.wait('presence');
        assert.equal(joined.type, 'presence');
        if (joined.type === 'presence')
            assert.equal(joined.event.action, 'joined');
        await alice.wait('presence'); // Bob's join after Alice's own join.
        const collision = await f.join(
            '  ＡＬＩＣＥ  ',
            undefined,
            undefined,
            true
        );
        assert.equal(collision.code, 4004);
        assert.match(collision.reason, /reserved/);
        alice.ws.close();
        await once(alice.ws, 'close');
        const departure = await bob.wait('presence');
        // Bob first receives his own join event; the next event is Alice leaving.
        assert.equal(departure.type, 'presence');
        const left = await bob.wait('presence');
        if (left.type !== 'presence') throw new Error('Missing leave notice');
        assert.equal(left.event.action, 'left');
        assert.equal(left.event.name, 'Alice');
        const reserved = await f.join('alice', undefined, undefined, true);
        assert.equal(reserved.code, 4004);
        const returned = await f.join('Alice', alice.identity, alice.cookie);
        assert.equal(returned.code, 0);
        const invisible = await f.join(
            'A\u200blice',
            undefined,
            undefined,
            true
        );
        assert.equal(invisible.code, 1008);
        assert.equal(f.app.stats().online, 2);
    } finally {
        await f.app.close();
    }
});

test('explicit room history grants preserve authorship, stay encrypted, survive reconnect, and never share DMs', async () => {
    const f = await fixture();
    try {
        const alice = await f.join('Alice');
        const bob = await f.join('Bob');
        const original = await seal(
            alice.identity,
            [alice.identity, bob.identity],
            f.app.boot,
            'room',
            'chat',
            { kind: 'text', text: 'Before Charlie arrived' }
        );
        await transmit(alice, original);
        const dm = await seal(
            alice.identity,
            [alice.identity, bob.identity],
            f.app.boot,
            dmScope(alice.identity.id, bob.identity.id),
            'chat',
            { kind: 'text', text: 'DM stays private' }
        );
        await transmit(alice, dm);
        const charlie = await f.join('Charlie');
        assert.equal(
            charlie.packets.some((p) => p.type === 'message'),
            false,
            'newcomers have no automatic backlog'
        );
        const raw = await contentKey(
            bob.identity,
            alice.identity,
            f.app.boot,
            original
        );
        const grant = await seal(
            bob.identity,
            [bob.identity, charlie.identity],
            f.app.boot,
            'room',
            'share',
            { kind: 'history', key: b64(raw) },
            { targets: [original.id], revision: original.id }
        );
        await transmit(bob, grant);
        const packet = await delivered(charlie);
        assert.equal(packet.envelope.id, grant.id);
        assert.equal(packet.source?.envelope.sig, original.sig);
        assert.equal(
            await grantRecipient(original, grant, bob.identity),
            charlie.identity.id
        );
        const invitation = await open<{ kind: string; key: string }>(
            charlie.identity,
            bob.identity,
            f.app.boot,
            grant
        );
        assert.deepEqual(
            await openWithKey(
                alice.identity,
                f.app.boot,
                packet.source!.envelope,
                unb64(invitation.key)
            ),
            { kind: 'text', text: 'Before Charlie arrived' }
        );
        await assert.rejects(
            open(charlie.identity, alice.identity, f.app.boot, original)
        );
        await assert.rejects(
            open(await createIdentity(), bob.identity, f.app.boot, grant)
        );
        assert.equal(
            JSON.stringify(packet).includes('Before Charlie arrived'),
            false
        );
        assert.equal(
            JSON.stringify(packet).includes(invitation.key),
            false,
            'content key is inside ciphertext'
        );
        const forged = { ...original, data: 'A' + original.data.slice(1) };
        if (forged.data === original.data)
            forged.data = 'B' + original.data.slice(1);
        await assert.rejects(
            openWithKey(alice.identity, f.app.boot, forged, raw),
            /verified/
        );
        raw.fill(0);
        const access = await alice.wait('access');
        assert.equal(access.type, 'access');
        const leak = await seal(
            bob.identity,
            [bob.identity, charlie.identity],
            f.app.boot,
            'room',
            'share',
            { kind: 'history', key: 'not-used' },
            { targets: [dm.id], revision: dm.id }
        );
        await transmit(bob, leak, 'error');
        charlie.ws.close();
        await once(charlie.ws, 'close');
        const returned = await f.join(
            'Charlie',
            charlie.identity,
            charlie.cookie
        );
        const restored = await delivered(returned);
        assert.equal(restored.source!.envelope.id, original.id);
        assert.equal(
            returned.packets.some((p) => p.type === 'message'),
            false,
            'the DM is never sent'
        );
        const dora = await f.join('Dora');
        const forwarded = await seal(
            charlie.identity,
            [charlie.identity, dora.identity],
            f.app.boot,
            'room',
            'share',
            invitation,
            { targets: [original.id], revision: original.id }
        );
        await transmit(returned, forwarded);
        const forwardedPacket = await delivered(dora);
        assert.deepEqual(
            forwardedPacket.grants!.map((g) => g.id),
            [grant.id, forwarded.id],
            'the original sharing proof accompanies a forwarded grant'
        );
        const doraKey = await open<{ key: string }>(
            dora.identity,
            charlie.identity,
            f.app.boot,
            forwarded
        );
        assert.deepEqual(
            await openWithKey(
                alice.identity,
                f.app.boot,
                forwardedPacket.source!.envelope,
                unb64(doraKey.key)
            ),
            { kind: 'text', text: 'Before Charlie arrived' }
        );
        const deletion = await seal(
            alice.identity,
            [alice.identity, bob.identity, charlie.identity, dora.identity],
            f.app.boot,
            'room',
            'delete',
            { kind: 'delete' },
            { targets: [original.id] }
        );
        const before = f.app.stats().historyBytes;
        await transmit(alice, deletion);
        assert.equal(
            f.app.stats().messages,
            1,
            'only the unrelated DM remains'
        );
        assert.ok(f.app.stats().historyBytes < before);
        returned.ws.close();
        await once(returned.ws, 'close');
        const afterDelete = await f.join(
            'Charlie',
            charlie.identity,
            charlie.cookie
        );
        assert.equal(
            afterDelete.packets.some((p) => p.type === 'message'),
            false,
            'deleted source and grant are both gone'
        );
        const replay = await transmit(alice, original);
        assert.ok(replay.type === 'ack' && replay.deleted);
        assert.equal(
            f.app.stats().messages,
            1,
            'old send cannot resurrect a deleted message'
        );
    } finally {
        await f.app.close();
    }
});

test('editing and batch deletion enforce ownership, revision, scope and all recipients, including shared history', async () => {
    const f = await fixture();
    try {
        const alice = await f.join('Alice');
        const bob = await f.join('Bob');
        const original = await seal(
            alice.identity,
            [alice.identity, bob.identity],
            f.app.boot,
            'room',
            'chat',
            { kind: 'text', text: 'Original' }
        );
        await transmit(alice, original);
        const charlie = await f.join('Charlie');
        const key = await contentKey(
            bob.identity,
            alice.identity,
            f.app.boot,
            original
        );
        const grant = await seal(
            bob.identity,
            [bob.identity, charlie.identity],
            f.app.boot,
            'room',
            'share',
            { kind: 'history', key: b64(key) },
            { targets: [original.id], revision: original.id }
        );
        key.fill(0);
        await transmit(bob, grant);
        await delivered(charlie);
        const identities = [alice.identity, bob.identity, charlie.identity];
        const impersonation = await seal(
            bob.identity,
            identities,
            f.app.boot,
            'room',
            'edit',
            { kind: 'text', text: 'Forged edit' },
            { targets: [original.id], revision: original.id }
        );
        await transmit(bob, impersonation, 'error');
        const missedRecipient = await seal(
            alice.identity,
            [alice.identity, bob.identity],
            f.app.boot,
            'room',
            'edit',
            { kind: 'text', text: 'Missing Charlie' },
            { targets: [original.id], revision: original.id }
        );
        await transmit(alice, missedRecipient, 'error');
        const wrongScope = await seal(
            alice.identity,
            [alice.identity, bob.identity],
            f.app.boot,
            dmScope(alice.identity.id, bob.identity.id),
            'edit',
            { kind: 'text', text: 'Wrong scope' },
            { targets: [original.id], revision: original.id }
        );
        await transmit(alice, wrongScope, 'error');
        bob.ws.close();
        await once(bob.ws, 'close');
        const edited = await seal(
            alice.identity,
            identities,
            f.app.boot,
            'room',
            'edit',
            { kind: 'text', text: 'Edited for everyone' },
            { targets: [original.id], revision: original.id }
        );
        await transmit(alice, edited);
        const received = await delivered(charlie);
        assert.equal(received.envelope.type, 'edit');
        assert.equal(received.source, undefined);
        assert.deepEqual(
            await open(
                charlie.identity,
                alice.identity,
                f.app.boot,
                received.envelope
            ),
            { kind: 'text', text: 'Edited for everyone' }
        );
        const stale = await seal(
            alice.identity,
            identities,
            f.app.boot,
            'room',
            'edit',
            { kind: 'text', text: 'Outdated edit' },
            { targets: [original.id], revision: original.id }
        );
        await transmit(alice, stale, 'error');
        const returned = await f.join('Bob', bob.identity, bob.cookie);
        const latest = await delivered(returned);
        assert.equal(latest.envelope.id, edited.id);
        assert.equal(
            latest.grants?.length,
            0,
            'edits replace old ciphertext and grants'
        );
        const bobsMessage = await seal(
            bob.identity,
            identities,
            f.app.boot,
            'room',
            'chat',
            { kind: 'text', text: 'Bob owns this' }
        );
        await transmit(returned, bobsMessage);
        const unauthorized = await seal(
            bob.identity,
            identities,
            f.app.boot,
            'room',
            'delete',
            { kind: 'delete' },
            { targets: [bobsMessage.id, original.id] }
        );
        await transmit(returned, unauthorized, 'error');
        assert.equal(
            f.app.stats().messages,
            2,
            'the entire unauthorized batch is rejected'
        );
        const second = await seal(
            alice.identity,
            identities,
            f.app.boot,
            'room',
            'chat',
            { kind: 'text', text: 'Also delete this' }
        );
        await transmit(alice, second);
        const deletion = await seal(
            alice.identity,
            identities,
            f.app.boot,
            'room',
            'delete',
            { kind: 'delete' },
            { targets: [original.id, second.id] }
        );
        await transmit(alice, deletion);
        assert.equal(f.app.stats().messages, 1);
        await transmit(alice, deletion); // Retrying an acknowledged batch is harmless.
        const replay = await transmit(alice, original);
        assert.ok(replay.type === 'ack' && replay.deleted);
        assert.equal(f.app.stats().messages, 1);
    } finally {
        await f.app.close();
    }
});

test('large files travel as encrypted parts, reach recipients after upload and on reconnect, and free RAM when deleted', async () => {
    const f = await fixture();
    try {
        const alice = await f.join('Alice');
        const bob = await f.join('Bob');
        const audience = [alice.identity, bob.identity];
        const data = new Uint8Array(PART_BYTES * 2.5).map((_, i) => i % 251);
        const file = await fileMessage(
            alice.identity,
            audience,
            f.app.boot,
            data
        );
        assert.equal(validateContent(file.payload), file.payload);
        assert.throws(() =>
            validateContent({ ...file.payload, size: MAX_FILE_BYTES + 1 })
        );
        assert.throws(() =>
            validateContent({
                ...file.payload,
                hashes: file.payload.hashes.slice(1),
            })
        );
        assert.equal(file.frames.length, 3);
        alice.ws.send(
            JSON.stringify({ type: 'envelope', envelope: file.envelope })
        );
        alice.ws.send(file.frames[0]);
        const progress = await alice.wait('progress');
        assert.ok(progress.type === 'progress' && progress.parts === 1);
        assert.equal(
            bob.packets.some((p) => p.type === 'message'),
            false,
            'recipients wait for the complete file'
        );
        alice.ws.send(file.frames[1]);
        alice.ws.send(file.frames[2]);
        await alice.wait('ack');
        const received = await delivered(bob);
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(bob.parts.length, 0, 'parts wait for a request');
        const frames = await receivedParts(bob, 3, file.envelope.id);
        const raw = await contentKey(
            bob.identity,
            alice.identity,
            f.app.boot,
            received.envelope
        );
        const payload = await openWithKey<typeof file.payload>(
            alice.identity,
            f.app.boot,
            received.envelope,
            raw
        );
        const key = await partKey(raw);
        const bytes = new Uint8Array(data.length);
        for (const frame of frames) {
            const part = readPart(new Uint8Array(frame));
            assert.equal(part.id, file.envelope.id);
            bytes.set(
                await openPart(
                    key,
                    received.envelope,
                    part.index,
                    part.data,
                    payload.hashes[part.index]
                ),
                part.index * PART_BYTES
            );
        }
        assert.deepEqual(bytes, data);
        assert.equal(
            JSON.stringify(received).includes(file.payload.name),
            false,
            'filenames are encrypted too'
        );
        assert.equal(alice.parts.length, 0, 'the author is not sent a copy');
        const stored = f.app.stats().historyBytes;
        assert.ok(stored > data.length && stored < data.length + 100_000);
        await assert.rejects(
            openPart(
                key,
                received.envelope,
                1,
                readPart(new Uint8Array(frames[0])).data,
                payload.hashes[1]
            ),
            'a part cannot be replayed at another index'
        );
        const edit = await seal(
            alice.identity,
            audience,
            f.app.boot,
            'room',
            'edit',
            { kind: 'text', text: 'not a file' },
            { targets: [file.envelope.id], revision: file.envelope.id }
        );
        await transmit(alice, edit, 'error');
        bob.ws.close();
        await once(bob.ws, 'close');
        const rejoined = await f.join('Bob', bob.identity, bob.cookie);
        assert.equal(
            rejoined.packets.filter((p) => p.type === 'message').length,
            1
        );
        await receivedParts(rejoined, 3, file.envelope.id);
        const outsider = await f.join('Charlie');
        outsider.ws.send(
            JSON.stringify({ type: 'fetch', id: file.envelope.id })
        );
        await outsider.wait('error');
        assert.equal(outsider.parts.length, 0, 'only recipients get parts');
        const deletion = await seal(
            alice.identity,
            audience,
            f.app.boot,
            'room',
            'delete',
            { kind: 'delete' },
            { targets: [file.envelope.id] }
        );
        await transmit(alice, deletion);
        assert.equal(f.app.stats().historyBytes, 0);
    } finally {
        await f.app.close();
    }
});

test('interrupted, cleared, oversized and out-of-order uploads release RAM without leaking parts', async () => {
    const f = await fixture();
    try {
        let alice = await f.join('Alice');
        const bob = await f.join('Bob');
        const audience = [alice.identity, bob.identity];
        const data = new Uint8Array(PART_BYTES * 2 + 10).fill(7);
        const file = await fileMessage(
            alice.identity,
            audience,
            f.app.boot,
            data
        );
        const prior = config.maxHistoryBytes;
        config.maxHistoryBytes = 2 * PART_BYTES;
        try {
            await transmit(alice, file.envelope, 'error');
        } finally {
            config.maxHistoryBytes = prior;
        }
        assert.equal(f.app.stats().messages, 0);

        alice.ws.send(
            JSON.stringify({ type: 'envelope', envelope: file.envelope })
        );
        alice.ws.send(file.frames[0]);
        await alice.wait('progress');
        alice.ws.close();
        await once(alice.ws, 'close');
        assert.deepEqual(
            [f.app.stats().messages, f.app.stats().historyBytes],
            [0, 0],
            'an interrupted upload is dropped'
        );
        alice = await f.join('Alice', alice.identity, alice.cookie);
        await upload(alice, file);
        await delivered(bob);
        await receivedParts(bob, 3, file.envelope.id);

        const cleared = await fileMessage(
            alice.identity,
            audience,
            f.app.boot,
            data
        );
        alice.ws.send(
            JSON.stringify({ type: 'envelope', envelope: cleared.envelope })
        );
        alice.ws.send(cleared.frames[0]);
        await alice.wait('progress');
        bob.ws.send(
            JSON.stringify({
                type: 'clear',
                id: crypto.randomUUID(),
                scope: 'room',
            })
        );
        await bob.wait('ack');
        assert.equal(f.app.stats().historyBytes, 0);
        alice.ws.send(cleared.frames[1]); // Parts still in flight are ignored.
        const replay = await transmit(alice, cleared.envelope);
        assert.ok(replay.type === 'ack' && replay.deleted);
        assert.equal(f.app.stats().messages, 0);
        assert.equal(
            bob.packets.some((p) => p.type === 'message'),
            false
        );
        assert.equal(bob.parts.length, 0);

        const shuffled = await fileMessage(
            alice.identity,
            audience,
            f.app.boot,
            data
        );
        alice.ws.send(
            JSON.stringify({ type: 'envelope', envelope: shuffled.envelope })
        );
        alice.ws.send(shuffled.frames[1]);
        const [code] = await once(alice.ws, 'close');
        assert.equal(code, 1008);
        for (let i = 0; i < 100 && f.app.stats().historyBytes; i++)
            await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(f.app.stats().historyBytes, 0);
    } finally {
        await f.app.close();
    }
});

test('calls admit only their members, bound transports and media, and refuse malformed MLS packets', async () => {
    const f = await fixture();
    try {
        const alice = await f.join('Alice');
        const bob = await f.join('Bob');
        const charlie = await f.join('Charlie');
        const dm = dmScope(alice.identity.id, bob.identity.id);
        let next = 0;
        async function media(
            person: typeof alice,
            body: Record<string, unknown>
        ) {
            const request = ++next;
            person.ws.send(JSON.stringify({ type: 'media', request, ...body }));
            for (;;) {
                const reply = await person.wait('media');
                if (reply.type === 'media' && reply.request === request)
                    return reply;
            }
        }
        assert.equal(
            (await media(alice, { action: 'setup' })).error,
            'Join the call first.'
        );
        alice.ws.send(JSON.stringify({ type: 'call', scope: dm }));
        const setup = await media(alice, { action: 'setup' });
        const codecs = (
            setup.data as {
                rtpCapabilities: { codecs: { mimeType: string }[] };
            }
        ).rtpCapabilities.codecs.map((codec) => codec.mimeType);
        assert.ok(
            codecs.includes('audio/opus') && codecs.includes('video/VP8')
        );
        const transport = (await media(alice, {
            action: 'transport',
            direction: 'send',
        })) as { data: { iceCandidates: { address: string; port: number }[] } };
        assert.ok(
            transport.data.iceCandidates.every(
                (c) => c.address === '127.0.0.1' && c.port > 0
            )
        );
        assert.equal(
            (await media(alice, { action: 'transport', direction: 'send' }))
                .error,
            'Invalid transport.'
        );
        assert.equal(
            (
                await media(alice, {
                    action: 'consume',
                    producer: randomUUID(),
                    rtpCapabilities: {},
                })
            ).error,
            'Unknown transport.'
        );

        // Only the two DM participants can join a DM call.
        charlie.ws.send(JSON.stringify({ type: 'call', scope: dm }));
        const [code] = await once(charlie.ws, 'close');
        assert.equal(code, 1008);

        // MLS packets are bounded and validated before they reach a leader.
        bob.ws.send(JSON.stringify({ type: 'call', scope: dm }));
        bob.ws.send(
            JSON.stringify({
                type: 'mls',
                scope: dm,
                action: 'key-package',
                version: 'not-a-uuid',
                keyPackage: 'AAAA',
            })
        );
        const [bobCode] = await once(bob.ws, 'close');
        assert.equal(bobCode, 1008);
        alice.ws.send(JSON.stringify({ type: 'call', scope: null }));
        assert.equal(
            (await media(alice, { action: 'setup' })).error,
            'Join the call first.'
        );
    } finally {
        await f.app.close();
    }
});
