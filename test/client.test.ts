import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatClient } from '../src/lib/client';
import {
    seal,
    open,
    contentKey,
    b64,
    dmScope,
    partHashes,
} from '../src/lib/crypto';
import { createIdentity } from './identities';
import { Ratchet, RatchetError } from '../src/lib/signal';
import { PART_BYTES } from '../src/lib/limits';
import type { ClientPacket, Identity, Envelope } from '../src/types';
import type { SoundCue } from '../src/lib/sounds';

function clientFor(
    identity: Identity,
    everyone: Identity[],
    boot: string,
    sound?: (cue: SoundCue) => void
) {
    const client = new ChatClient(sound);
    client.identity = identity;
    client.update({
        phase: 'online',
        self: identity.id,
        name: identity.id,
        peers: everyone.map((peer) => ({
            id: peer.id,
            bundle: peer.bundle,
            name: peer.id,
            online: true,
            call: null,
        })),
        config: {
            boot,
            maxClients: 4,
            expires: Date.now() + 60000,
        },
    });
    const sent: Envelope[] = [];
    client.wire = (packet: ClientPacket) => {
        if (packet.type !== 'envelope') return;
        sent.push(packet.envelope);
        queueMicrotask(
            () => void client.receive({ type: 'ack', id: packet.envelope.id })
        );
    };
    client.request = async <T>() => ({}) as T;
    return { client, sent };
}

test('clearing a conversation drops pending and in-flight content, preserves DMs, and ignores replayed clear markers', async () => {
    const [alice, bob] = await Promise.all([
        createIdentity(),
        createIdentity(),
    ]);
    const boot = crypto.randomUUID();
    const { client } = clientFor(alice, [alice, bob], boot);
    const dm = await seal(
        bob,
        [alice, bob],
        boot,
        dmScope(alice.id, bob.id),
        'chat',
        { kind: 'text', text: 'Keep this DM' }
    );
    await client.receive({ type: 'message', envelope: dm, received: 1 });
    const room = await seal(bob, [alice, bob], boot, 'room', 'chat', {
        kind: 'text',
        text: 'Clear this',
    });
    await client.receive({ type: 'message', envelope: room, received: 2 });
    client.pending.set(room.id, room);
    client.update({
        unread: { room: 2 },
        typing: { [`room:${bob.id}`]: Date.now() + 3000 },
    });
    const inFlight = await seal(bob, [alice, bob], boot, 'room', 'chat', {
        kind: 'text',
        text: 'Still decrypting',
    });
    const incoming = client.receive({
        type: 'message',
        envelope: inFlight,
        received: 3,
    });
    // Observe the rejection now; it may settle before the decryption below.
    const outgoing = assert.rejects(
        client.send({ kind: 'text', text: 'Still encrypting' }),
        /conversation was cleared/
    );
    const marker = {
        type: 'cleared' as const,
        id: crypto.randomUUID(),
        scope: 'room',
        by: bob.id,
    };
    await client.receive(marker);
    await incoming;
    await outgoing;
    assert.deepEqual(
        client.state.messages.map((m) => m.id),
        [dm.id]
    );
    assert.equal(client.pending.size, 0);
    assert.equal(client.state.unread.room, 0);
    assert.deepEqual(client.state.typing, {});
    const fresh = await seal(bob, [alice, bob], boot, 'room', 'chat', {
        kind: 'text',
        text: 'New after clearing',
    });
    await client.receive({ type: 'message', envelope: fresh, received: 4 });
    client.pending.set(fresh.id, fresh);
    await client.receive(marker);
    assert.equal(client.state.messages.length, 2);
    assert.equal(
        client.pending.size,
        1,
        'reconnect marker leaves newer unsent messages intact'
    );
    client.wire = (packet) => {
        assert.equal(packet.type, 'clear');
        if (packet.type === 'clear')
            queueMicrotask(
                () => void client.receive({ type: 'ack', id: packet.id })
            );
    };
    await client.clearConversation('room');
    clearTimeout(client.noticeTimer);
});

test('notification sounds distinguish live messages from history, replay, edits and failed sends; deafening silences them', async () => {
    const [alice, bob] = await Promise.all([
        createIdentity(),
        createIdentity(),
    ]);
    const boot = crypto.randomUUID();
    const cues: SoundCue[] = [];
    const { client } = clientFor(bob, [alice, bob], boot, (cue) =>
        cues.push(cue)
    );
    const incoming = async (text: string) => {
        const envelope = await seal(alice, [alice, bob], boot, 'room', 'chat', {
            kind: 'text',
            text,
        });
        await client.receive({
            type: 'message',
            envelope,
            received: Date.now(),
        });
        return envelope;
    };
    await incoming('Old history');
    assert.deepEqual(cues, []);
    await client.receive({ type: 'history-end' });
    const live = await incoming('A live message');
    assert.deepEqual(cues, ['received']);
    await client.receive({
        type: 'message',
        envelope: live,
        received: Date.now(),
    });
    const edit = await seal(
        alice,
        [alice, bob],
        boot,
        'room',
        'edit',
        { kind: 'text', text: 'Edited' },
        { targets: [live.id] }
    );
    await client.receive({
        type: 'message',
        envelope: edit,
        received: Date.now(),
    });
    assert.deepEqual(cues, ['received']);
    const outgoing = await seal(bob, [alice, bob], boot, 'room', 'chat', {
        kind: 'text',
        text: 'A reply',
    });
    client.pending.set(outgoing.id, outgoing);
    await client.receive({ type: 'ack', id: outgoing.id });
    await client.receive({ type: 'ack', id: outgoing.id });
    assert.deepEqual(cues, ['received', 'sent']);
    const failed = await seal(bob, [alice, bob], boot, 'room', 'chat', {
        kind: 'text',
        text: 'Failed send',
    });
    client.pending.set(failed.id, failed);
    await client.receive({
        type: 'error',
        id: failed.id,
        message: 'Test delivery failure',
    });
    assert.deepEqual(cues, ['received', 'sent']);
    client.update({
        call: {
            scope: 'room',
            started: Date.now(),
            muted: false,
            deafened: true,
            camera: false,
            screen: false,
            screenAudio: false,
            screenAudioAvailable: false,
            noiseReduction: 'browser',
            noisePending: false,
            local: { mic: null, camera: null, screen: null },
            peers: [],
        },
    });
    await incoming('Quiet during deafen');
    assert.deepEqual(cues, ['received', 'sent']);
    client.update({ call: null });
    await client.receive({
        type: 'presence',
        event: {
            id: crypto.randomUUID(),
            userId: alice.id,
            name: 'Alice',
            action: 'left',
            time: Date.now(),
        },
    });
    assert.deepEqual(cues, ['received', 'sent', 'leave']);
    clearTimeout(client.noticeTimer);
});

test('shared history can be forwarded with a signed chain; only proven recipients are included in edits', async () => {
    const [alice, bob, charlie, outsider] = await Promise.all(
        Array.from({ length: 4 }, () => createIdentity())
    );
    const boot = crypto.randomUUID();
    const everyone = [alice, bob, charlie, outsider];
    const a = clientFor(alice, everyone, boot);
    const b = clientFor(bob, everyone, boot);
    const c = clientFor(charlie, everyone, boot);
    const original = await seal(alice, [alice], boot, 'room', 'chat', {
        kind: 'text',
        text: 'Only Alice originally received this.',
    });
    await a.client.receive({
        type: 'message',
        envelope: original,
        received: 100,
    });
    await a.client.shareHistory([original.id], bob.id, () => {});
    const firstGrant = a.sent[0];
    await b.client.receive({
        type: 'message',
        envelope: firstGrant,
        source: { envelope: original, received: 100 },
        grants: [firstGrant],
        received: 100,
    });
    assert.equal(b.client.state.messages[0].from, alice.id);
    assert.equal(b.client.state.messages[0].envelope.keys[bob.id], undefined);
    await b.client.shareHistory([original.id], charlie.id, () => {});
    const secondGrant = b.sent[0];
    await c.client.receive({
        type: 'message',
        envelope: secondGrant,
        source: { envelope: original, received: 100 },
        grants: [firstGrant, secondGrant],
        received: 100,
    });
    assert.equal(c.client.state.messages[0].from, alice.id);
    assert.deepEqual(c.client.state.messages[0].payload, {
        kind: 'text',
        text: 'Only Alice originally received this.',
    });
    await a.client.receive({
        type: 'access',
        id: original.id,
        grant: firstGrant,
    });
    await a.client.receive({
        type: 'access',
        id: original.id,
        grant: secondGrant,
    });
    await a.client.edit(original.id, 'Edited :wave:');
    assert.deepEqual(
        Object.keys(a.sent[1].keys).sort(),
        [alice.id, bob.id, charlie.id].sort()
    );
    await c.client.receive({
        type: 'message',
        envelope: a.sent[1],
        received: 100,
    });
    await a.client.receive({
        type: 'message',
        envelope: a.sent[1],
        received: 100,
    });
    assert.deepEqual(c.client.state.messages[0].payload, {
        kind: 'text',
        text: 'Edited 👋',
    });
    assert.equal(
        c.client.state.messages[0].historyGrant,
        undefined,
        'old grant is discarded after a direct encrypted edit'
    );
    const fakeGrant = await seal(
        outsider,
        [outsider, bob],
        boot,
        'room',
        'share',
        { kind: 'history', key: 'fake' },
        { targets: [original.id], revision: a.sent[1].id }
    );
    await assert.rejects(
        a.client.receive({ type: 'access', id: original.id, grant: fakeGrant }),
        /verified/
    );
    assert.equal(
        a.client.state.messages[0].audience.includes(outsider.id),
        false
    );
});

test('a relay cannot invent a history-sharing chain, even when it has a valid original ciphertext', async () => {
    const [alice, bob, outsider] = await Promise.all(
        Array.from({ length: 3 }, () => createIdentity())
    );
    const boot = crypto.randomUUID();
    const original = await seal(alice, [alice], boot, 'room', 'chat', {
        kind: 'text',
        text: 'Private',
    });
    const key = await contentKey(alice, alice, boot, original);
    const unproven = await seal(
        outsider,
        [outsider, bob],
        boot,
        'room',
        'share',
        { kind: 'history', key: b64(key) },
        { targets: [original.id], revision: original.id }
    );
    key.fill(0);
    const b = clientFor(bob, [alice, bob, outsider], boot);
    await assert.rejects(
        b.client.receive({
            type: 'message',
            envelope: unproven,
            source: { envelope: original, received: 1 },
            grants: [unproven],
            received: 1,
        }),
        /verified/
    );
    assert.deepEqual(b.client.state.messages, []);
});

test('signing out cancels in-flight encryption and decryption without restoring cleared messages', async () => {
    const [alice, bob] = await Promise.all([
        createIdentity(),
        createIdentity(),
    ]);
    const boot = crypto.randomUUID();
    const bytes = new Uint8Array(8192);
    const file = {
        kind: 'file' as const,
        hashes: await partHashes(bytes),
        size: 8192,
        mime: 'application/octet-stream',
        name: 'synthetic.dat',
    };
    const packet = await seal(alice, [alice, bob], boot, 'room', 'chat', file, {
        parts: 1,
    });
    const receiver = clientFor(bob, [alice, bob], boot);
    const incoming = receiver.client.receive({
        type: 'message',
        envelope: packet,
        received: 1,
    });
    await receiver.client.logout();
    await incoming;
    assert.equal(receiver.client.state.phase, 'login');
    assert.deepEqual(receiver.client.state.messages, []);
    const sender = clientFor(alice, [alice, bob], boot);
    const outgoing = sender.client.send(file, 'room', bytes);
    await sender.client.logout();
    await assert.rejects(outgoing, /connection changed/);
    assert.equal(sender.client.pending.size, 0);
    assert.deepEqual(sender.client.state.messages, []);
    assert.deepEqual(sender.sent, []);
});

test('file parts upload within an ack window, then decrypt, verify and assemble for recipients', async () => {
    const [alice, bob] = await Promise.all([
        createIdentity(),
        createIdentity(),
    ]);
    const boot = crypto.randomUUID();
    const sender = clientFor(alice, [alice, bob], boot);
    const frames: Uint8Array<ArrayBuffer>[] = [];
    const ws = { readyState: WebSocket.OPEN } as WebSocket;
    sender.client.ws = ws;
    let inFlight = 0;
    let maxInFlight = 0;
    sender.client.wire = (packet: ClientPacket) => {
        if (packet.type === 'envelope') sender.sent.push(packet.envelope);
    };
    sender.client.wirePart = (frame) => {
        frames.push(frame);
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        // Acknowledge asynchronously, as the relay does after storing a part.
        setTimeout(() => {
            inFlight--;
            const id = sender.sent[0].id;
            void sender.client.receive(
                frames.length === sender.sent[0].parts
                    ? { type: 'ack', id }
                    : { type: 'progress', id, parts: frames.length }
            );
        }, 1);
    };
    const data = new Uint8Array(PART_BYTES * 9 + 5).map((_, i) => i % 199);
    const payload = {
        kind: 'file' as const,
        name: 'synthetic.bin',
        mime: 'application/octet-stream',
        size: data.length,
        hashes: await partHashes(data),
    };
    await assert.rejects(
        sender.client.send(payload, 'room', data.slice(1)),
        /changed/
    );
    await sender.client.send(payload, 'room', data);
    for (let i = 0; i < 500 && sender.client.pending.size; i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(frames.length, 10);
    assert.ok(maxInFlight <= 8, 'uploads wait for progress acks');
    assert.equal(sender.client.state.messages[0].status, 'sent');
    assert.equal(sender.client.state.messages[0].bytes, data);

    const receiver = clientFor(bob, [alice, bob], boot);
    await receiver.client.receive({
        type: 'message',
        envelope: sender.sent[0],
        received: 1,
    });
    const receive = (frame: Uint8Array<ArrayBuffer>) =>
        (
            receiver.client as unknown as {
                receivePart(frame: Uint8Array<ArrayBuffer>): Promise<void>;
            }
        ).receivePart(frame);
    const fetched: ClientPacket[] = [];
    receiver.client.wire = (packet) => void fetched.push(packet);
    // Files above the auto-download size wait until someone opens them.
    assert.equal(receiver.client.state.messages[0].progress, undefined);
    receiver.client.fetchFile(receiver.client.state.messages[0].id);
    assert.deepEqual(fetched, [{ type: 'fetch', id: sender.sent[0].id }]);
    assert.equal(receiver.client.state.messages[0].progress, 0);
    assert.equal(receiver.client.state.messages[0].bytes, undefined);
    for (const frame of frames.slice(0, 5)) await receive(frame);
    assert.equal(receiver.client.state.messages[0].progress, 0.5);
    for (const frame of frames.slice(5)) await receive(frame);
    const message = receiver.client.state.messages[0];
    assert.equal(message.progress, undefined);
    assert.deepEqual(message.bytes, data);

    // A part replayed from another file is rejected and marks it unavailable.
    const other = clientFor(bob, [alice, bob], boot);
    await other.client.receive({
        type: 'message',
        envelope: sender.sent[0],
        received: 1,
    });
    other.client.wire = () => {};
    other.client.fetchFile(sender.sent[0].id);
    const forged = frames[1].slice();
    forged.set(frames[0].subarray(0, 40));
    await assert.rejects(
        (
            other.client as unknown as {
                receivePart(frame: Uint8Array<ArrayBuffer>): Promise<void>;
            }
        ).receivePart(forged)
    );
    assert.equal(other.client.state.messages[0].unavailable, true);
    assert.equal(other.client.state.messages[0].bytes, undefined);
});

test('a browser that lost its Signal sessions starts a new one and reads new messages', async () => {
    const [alice, bob] = await Promise.all([
        createIdentity(),
        createIdentity(),
    ]);
    const boot = crypto.randomUUID();
    const text = (text: string) => ({ kind: 'text' as const, text });
    await open(
        alice,
        bob,
        boot,
        await seal(bob, [alice, bob], boot, 'room', 'chat', text('hello'))
    );
    await open(
        bob,
        alice,
        boot,
        await seal(alice, [alice, bob], boot, 'room', 'chat', text('hi'))
    );
    // Bob's browser storage is cleared; Alice still uses the old session.
    const fetch = bob.ratchet.fetch;
    bob.ratchet = new Ratchet(bob);
    bob.ratchet.fetch = fetch;
    const { client, sent } = clientFor(bob, [alice, bob], boot);
    const [lost, later] = await Promise.all(
        ['lost', 'later'].map((body) =>
            seal(alice, [alice, bob], boot, 'room', 'chat', text(body))
        )
    );
    await assert.rejects(
        client.receive({ type: 'message', envelope: lost, received: 1 }),
        RatchetError
    );
    for (let i = 0; i < 100 && !sent.length; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
    const [rekey] = sent;
    assert.equal(rekey?.type, 'signal');
    assert.deepEqual(await open(alice, bob, boot, rekey), { rekey: true });
    const fresh = await seal(
        alice,
        [alice, bob],
        boot,
        'room',
        'chat',
        text('back')
    );
    await client.receive({ type: 'message', envelope: fresh, received: 2 });
    assert.deepEqual(
        client.state.messages.map((m) => m.payload),
        [text('back')]
    );
    // A second failure soon after does not send another rekey.
    await assert.rejects(
        client.receive({ type: 'message', envelope: later, received: 3 }),
        RatchetError
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sent.length, 1);
});
