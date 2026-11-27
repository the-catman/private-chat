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
    sign,
    clearText,
} from '../src/lib/crypto';
import { createIdentity } from './identities';
import { Ratchet, RatchetError } from '../src/lib/signal';
import { PART_BYTES } from '../src/lib/limits';
import type { ClientPacket, Identity, Envelope } from '../src/types';
import type { SoundCue } from '../src/lib/sounds';

// A clear notice as the server relays it, signed by the person clearing.
async function clearedBy(
    identity: Identity,
    boot: string,
    scope: string,
    time = Date.now()
) {
    const id = crypto.randomUUID();
    return {
        type: 'cleared' as const,
        id,
        scope,
        by: identity.id,
        time,
        sig: await sign(
            identity,
            clearText(boot, id, scope, time, identity.id)
        ),
    };
}

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
            status: 'online' as const,
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
    const marker = await clearedBy(bob, boot, 'room');
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

test('a relay cannot place a message in another DM or roll back an edit', async () => {
    const [alice, bob, mallory] = await Promise.all(
        Array.from({ length: 3 }, () => createIdentity())
    );
    const boot = crypto.randomUUID();
    const { client } = clientFor(alice, [alice, bob, mallory], boot);
    // A validly signed message from Mallory, labelled as Alice and Bob's DM.
    const injected = await seal(
        mallory,
        [mallory, alice],
        boot,
        dmScope(alice.id, bob.id),
        'chat',
        { kind: 'text', text: 'Hi, it is Bob' }
    );
    await assert.rejects(
        client.receive({ type: 'message', envelope: injected, received: 1 }),
        /another conversation/
    );
    assert.equal(client.state.messages.length, 0);

    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    const revise = (text: string, revision: string, original: string) =>
        seal(
            bob,
            [bob, alice],
            boot,
            'room',
            'edit',
            { kind: 'text', text },
            { targets: [original], revision }
        );
    const original = await seal(bob, [bob, alice], boot, 'room', 'chat', {
        kind: 'text',
        text: 'v0',
    });
    await tick();
    const first = await revise('v1', original.id, original.id);
    await tick();
    const second = await revise('v2', first.id, original.id);
    for (const [envelope, received] of [
        [original, 2],
        [second, 3],
        [first, 4],
    ] as const)
        await client.receive({ type: 'message', envelope, received });
    assert.equal(client.state.messages.length, 1);
    assert.deepEqual(client.state.messages[0]!.payload, {
        kind: 'text',
        text: 'v2',
    });
});

test('only a signed clear from someone in the conversation removes it, and an old one keeps newer messages', async () => {
    const [alice, bob, carol] = await Promise.all(
        Array.from({ length: 3 }, () => createIdentity())
    );
    const boot = crypto.randomUUID();
    const { client } = clientFor(alice, [alice, bob, carol], boot);
    const scope = dmScope(alice.id, bob.id);
    const dm = await seal(bob, [alice, bob], boot, scope, 'chat', {
        kind: 'text',
        text: 'Keep this',
    });
    await client.receive({ type: 'message', envelope: dm, received: 1 });
    // The relay blames Bob with someone else's signature.
    const forged = { ...(await clearedBy(carol, boot, scope)), by: bob.id };
    await assert.rejects(client.receive(forged), /Invalid clear/);
    // Carol signs her own request, but she is not in this DM.
    await assert.rejects(
        client.receive(await clearedBy(carol, boot, scope)),
        /Invalid clear/
    );
    // A clear Bob signed an hour ago, replayed now, keeps newer messages.
    await client.receive(
        await clearedBy(bob, boot, scope, Date.now() - 3_600_000)
    );
    assert.deepEqual(
        client.state.messages.map((m) => m.id),
        [dm.id]
    );
    await client.receive(await clearedBy(bob, boot, scope));
    assert.equal(client.state.messages.length, 0);
});

test('messages follow their signed send times, and edits keep their place', async () => {
    const [alice, bob] = await Promise.all([
        createIdentity(),
        createIdentity(),
    ]);
    const boot = crypto.randomUUID();
    const { client } = clientFor(alice, [alice, bob], boot);
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    const text = (value: string) => ({ kind: 'text', text: value });
    const first = await seal(
        bob,
        [bob, alice],
        boot,
        'room',
        'chat',
        text('one')
    );
    await tick();
    const second = await seal(
        bob,
        [bob, alice],
        boot,
        'room',
        'chat',
        text('two')
    );
    await tick();
    const edit = await seal(
        bob,
        [bob, alice],
        boot,
        'room',
        'edit',
        text('one, edited'),
        { targets: [first.id], revision: first.id, since: first.time }
    );
    // The relay stamps them in the wrong order. After a reload, history holds
    // only the latest revision of the first message.
    await client.receive({ type: 'message', envelope: second, received: 1 });
    await client.receive({ type: 'message', envelope: edit, received: 2 });
    assert.deepEqual(
        client.state.messages.map(
            (m) => m.payload.kind === 'text' && m.payload.text
        ),
        ['one, edited', 'two']
    );
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

test('reactions toggle in order, keep the newest signed set, and go with their message; replies survive edits', async () => {
    const [alice, bob, mallory] = await Promise.all(
        Array.from({ length: 3 }, () => createIdentity())
    );
    const boot = crypto.randomUUID();
    const { client, sent } = clientFor(alice, [alice, bob, mallory], boot);
    // The relay echoes each envelope to its author before acknowledging it.
    client.wire = (packet: ClientPacket) => {
        if (packet.type !== 'envelope') return;
        sent.push(packet.envelope);
        queueMicrotask(async () => {
            await client.receive({
                type: 'message',
                envelope: packet.envelope,
                received: Date.now(),
            });
            await client.receive({ type: 'ack', id: packet.envelope.id });
        });
    };
    const original = await seal(bob, [alice, bob], boot, 'room', 'chat', {
        kind: 'text',
        text: 'React to this',
    });
    await client.receive({ type: 'message', envelope: original, received: 1 });
    const mine = () =>
        client.state.reactions[original.id]?.[alice.id]?.emoji ?? [];

    // Two quick clicks on the same emoji cancel out.
    await Promise.all([
        client.react(original.id, '👍'),
        client.react(original.id, '👍'),
    ]);
    assert.deepEqual(mine(), []);
    await client.react(original.id, '🎉');
    assert.deepEqual(mine(), ['🎉']);
    await assert.rejects(client.react(original.id, 'hello'), /Invalid/);

    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    const reaction = (emoji: string[]) =>
        seal(
            bob,
            [alice, bob],
            boot,
            'room',
            'react',
            {
                kind: 'reaction',
                emoji,
            },
            { targets: [original.id] }
        );
    const older = await reaction(['👀']);
    await tick();
    const newer = await reaction(['❤️']);
    for (const envelope of [newer, older])
        await client.receive({ type: 'message', envelope, received: 2 });
    assert.deepEqual(client.state.reactions[original.id]?.[bob.id]?.emoji, [
        '❤️',
    ]);

    // Only people who received the message can react to it.
    const outsider = await seal(
        mallory,
        [alice, mallory],
        boot,
        'room',
        'react',
        { kind: 'reaction', emoji: ['😈'] },
        { targets: [original.id] }
    );
    await assert.rejects(
        client.receive({ type: 'message', envelope: outsider, received: 3 }),
        /Invalid reaction or pin/
    );
    const pin = await seal(
        bob,
        [alice, bob],
        boot,
        'room',
        'pin',
        { kind: 'pin', pinned: true },
        { targets: [original.id] }
    );
    await client.receive({ type: 'message', envelope: pin, received: 4 });
    assert.equal(client.state.pins[original.id]?.pinned, true);
    await client.pin(original.id, false);
    assert.equal(client.state.pins[original.id]?.pinned, false);
    assert.equal(client.state.pins[original.id]?.by, alice.id);

    const reply = await seal(alice, [alice, bob], boot, 'room', 'chat', {
        kind: 'text',
        text: 'A reply',
        reply: original.id,
    });
    await client.receive({ type: 'message', envelope: reply, received: 5 });
    await client.edit(reply.id, 'An edited reply');
    assert.deepEqual(await open(alice, alice, boot, sent.at(-1)!), {
        kind: 'text',
        text: 'An edited reply',
        reply: original.id,
    });

    const removal = await seal(
        bob,
        [alice, bob],
        boot,
        'room',
        'delete',
        { kind: 'delete' },
        { targets: [original.id] }
    );
    await client.receive({ type: 'message', envelope: removal, received: 6 });
    assert.equal(client.state.reactions[original.id], undefined);
    assert.equal(client.state.pins[original.id], undefined);
    clearTimeout(client.noticeTimer);
});

test('profiles keep the newest signed version and reach newcomers; renames, do not disturb, invisible typing and offline DMs behave', async () => {
    // Profiles and statuses are preferences kept in browser storage.
    const memory = new Map<string, string>();
    globalThis.localStorage ??= {
        getItem: (key: string) => memory.get(key) ?? null,
        setItem: (key: string, value: string) => memory.set(key, value),
        removeItem: (key: string) => memory.delete(key),
    } as unknown as Storage;
    const [alice, bob, carol] = await Promise.all(
        Array.from({ length: 3 }, () => createIdentity())
    );
    const boot = crypto.randomUUID();
    const cues: SoundCue[] = [];
    const { client, sent } = clientFor(alice, [alice, bob], boot, (cue) =>
        cues.push(cue)
    );
    client.wire = (packet: ClientPacket) => {
        if (packet.type !== 'envelope') return;
        sent.push(packet.envelope);
        queueMicrotask(async () => {
            if (packet.envelope.type === 'profile')
                await client.receive({
                    type: 'message',
                    envelope: packet.envelope,
                    received: Date.now(),
                });
            await client.receive({ type: 'ack', id: packet.envelope.id });
        });
    };
    const profile = (text: string, scope = 'room') =>
        seal(bob, [alice, bob], boot, scope, 'profile', {
            kind: 'profile',
            text,
        });
    const older = await profile('Away');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await profile('Back');
    for (const envelope of [newer, older])
        await client.receive({ type: 'message', envelope, received: 1 });
    assert.equal(client.state.profiles[bob.id]?.text, 'Back');
    await assert.rejects(
        client.receive({
            type: 'message',
            envelope: await profile('Two\nlines'),
            received: 2,
        }),
        /Invalid profile/
    );
    await assert.rejects(
        client.receive({
            type: 'message',
            envelope: await profile('Private', dmScope(alice.id, bob.id)),
            received: 2,
        }),
        /Invalid profile/
    );

    // Alice's own profile goes to everyone, and again to someone new.
    await client.receive({ type: 'history-end' });
    const png = b64(
        Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6b2sAAAAASUVORK5CYII=',
            'base64'
        )
    );
    await client.setProfile({ text: '  Out to lunch ', avatar: png });
    const profiles = () => sent.filter((e) => e.type === 'profile');
    assert.equal(profiles().length, 1);
    assert.deepEqual(
        Object.keys(profiles()[0]!.keys).sort(),
        [alice.id, bob.id].sort()
    );
    assert.equal(client.state.profiles[alice.id]?.text, 'Out to lunch');
    assert.match(
        client.state.profiles[alice.id]?.avatar || '',
        /^data:image\/png;base64,/
    );
    await client.setProfile({ text: 'Out to lunch', avatar: png });
    assert.equal(profiles().length, 1, 'an unchanged profile is not resent');
    const everyone = [alice, bob, carol].map((peer) => ({
        id: peer.id,
        bundle: peer.bundle,
        name: peer === bob ? 'Robert' : peer.id,
        online: true,
        status: 'online' as const,
        call: null,
    }));
    const chat = await seal(bob, [alice, bob], boot, 'room', 'chat', {
        kind: 'text',
        text: 'Hello',
    });
    await client.receive({ type: 'message', envelope: chat, received: 3 });
    await client.receive({ type: 'peers', peers: everyone });
    const start = Date.now();
    while (profiles().length < 2 && Date.now() - start < 3000)
        await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(Object.hasOwn(profiles()[1]!.keys, carol.id));
    // Messages show the name their author uses now.
    assert.equal(
        client.state.messages.find((m) => m.id === chat.id)?.name,
        'Robert'
    );

    // Do not disturb silences other people's messages.
    client.setStatus('dnd');
    cues.length = 0;
    const quiet = await seal(bob, [alice, bob], boot, 'room', 'chat', {
        kind: 'text',
        text: 'Shh',
    });
    await client.receive({ type: 'message', envelope: quiet, received: 4 });
    assert.deepEqual(cues, []);
    client.setStatus('online');
    const loud = await seal(bob, [alice, bob], boot, 'room', 'chat', {
        kind: 'text',
        text: 'Hey',
    });
    await client.receive({ type: 'message', envelope: loud, received: 5 });
    assert.deepEqual(cues, ['received']);

    // Invisible people do not show that they are typing.
    client.setStatus('invisible');
    const before = sent.length;
    await client.typing();
    assert.equal(sent.length, before);
    client.setStatus('online');

    // A DM may wait for someone offline; calls and room messages may not.
    await client.receive({
        type: 'peers',
        peers: everyone.map((p) =>
            p.id === carol.id ? { ...p, online: false } : p
        ),
    });
    const dm = dmScope(alice.id, carol.id);
    assert.throws(() => client.recipients(dm), /offline/);
    assert.deepEqual(
        client.recipients(dm, true).map((p) => p.id),
        [alice.id, carol.id]
    );
    assert.deepEqual(
        client.recipients('room', true).map((p) => p.id),
        [alice.id, bob.id]
    );
});
