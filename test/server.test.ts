import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createChatServer } from '../server/app';
import { readConfig } from '../server/config';
import {
    createIdentity,
    dmScope,
    open,
    proofText,
    seal,
    sign,
    contentKey,
    openWithKey,
    grantRecipient,
    b64,
    unb64,
} from '../src/lib/crypto';
import { normalizeName, MAX_FILE_BYTES } from '../src/lib/limits';
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
    STUN_URLS: '',
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
        ws.on('message', (data) => {
            packets.push(JSON.parse(data.toString()));
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
            })
        );
        if (rejected) {
            const [code, reason] = await once(ws, 'close');
            return {
                ws,
                identity,
                cookie,
                packets,
                wait,
                code,
                reason: String(reason),
            };
        }
        await wait('ready');
        await wait('history-end');
        return { ws, identity, cookie, packets, wait, code: 0, reason: '' };
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
        const file = await seal(
            bob.identity,
            audience,
            f.app.boot,
            'room',
            'chat',
            {
                kind: 'file',
                name: 'test.txt',
                mime: 'text/plain',
                size: 4096,
                data: b64(new Uint8Array(4096)),
            }
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
        for (const [person, message] of [
            [alice, original],
            [bob, file],
        ] as const)
            await transmit(person, message);
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

test('5 MB files are encrypted in RAM, validate at the boundary, and deletion frees storage', async () => {
    const f = await fixture();
    try {
        const alice = await f.join('Alice');
        const bob = await f.join('Bob');
        const data = new Uint8Array(MAX_FILE_BYTES).fill(61);
        const payload = {
            kind: 'file' as const,
            data: b64(data),
            name: 'synthetic-test.dat',
            mime: 'application/octet-stream',
            size: data.length,
        };
        assert.equal(validateContent(payload), payload);
        assert.throws(() =>
            validateContent({ ...payload, size: MAX_FILE_BYTES + 1 })
        );
        assert.throws(() =>
            validateContent({ ...payload, data: payload.data.slice(1) })
        );
        const envelope = await seal(
            alice.identity,
            [alice.identity, bob.identity],
            f.app.boot,
            'room',
            'chat',
            payload
        );
        await transmit(alice, envelope);
        const received = await delivered(bob);
        const file = await open<typeof payload>(
            bob.identity,
            alice.identity,
            f.app.boot,
            received.envelope
        );
        assert.equal(file.name, payload.name);
        assert.deepEqual(unb64(file.data), data);
        assert.equal(
            JSON.stringify(received).includes(payload.name),
            false,
            'filenames are encrypted too'
        );
        assert.equal(f.app.stats().messages, 1);
        const deletion = await seal(
            alice.identity,
            [alice.identity, bob.identity],
            f.app.boot,
            'room',
            'delete',
            { kind: 'delete' },
            { targets: [envelope.id] }
        );
        await transmit(alice, deletion);
        assert.equal(f.app.stats().historyBytes, 0);
    } finally {
        await f.app.close();
    }
});
