import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalls } from '../server/calls';
import { readConfig } from '../server/config';
import { dmScope } from '../src/lib/crypto';
import { createIdentity } from './identities';
import { DaveSession, lingering, ratchetKey } from '../src/lib/dave';
import {
    clearRanges,
    decryptFrame,
    encryptFrame,
    parseFrame,
} from '../src/lib/dave-frame';
import type { Bundle, Identity } from '../src/types';

const config = readConfig({
    APP_PASSWORD: 'synthetic-password-for-call-tests',
    APP_ORIGIN: 'https://127.0.0.1',
    MEDIA_PORT: '0',
    MEDIA_LISTEN_IP: '127.0.0.1',
});
const boot = 'synthetic-boot';

async function until(check: () => boolean, label: string, ms = 8000) {
    const deadline = Date.now() + ms;
    while (!check()) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

function harness() {
    const calls = createCalls(config);
    const people = new Map<
        string,
        {
            identity: Identity;
            session?: DaveSession;
            secrets: Map<string, Uint8Array>;
            installs: number;
            resets: number;
            keyPackages: number;
            // Packets held while this person's tab is frozen.
            frozen?: (() => void)[];
            // How many upcoming welcomes arrive damaged.
            brokenWelcomes: number;
        }
    >();
    const known = new Map<string, Bundle>();
    // Who the peer list shows in a call, as the client UI would.
    const visible = new Map<string, string>();
    async function person(trusted = true) {
        const identity = await createIdentity();
        if (trusted) known.set(identity.id, identity.bundle);
        people.set(identity.id, {
            identity,
            secrets: new Map(),
            installs: 0,
            resets: 0,
            keyPackages: 0,
            brokenWelcomes: 0,
        });
        return identity.id;
    }
    function join(id: string, scope = 'room', shown = true) {
        const record = people.get(id)!;
        if (shown) visible.set(id, scope);
        calls.join(scope, id, (packet) => {
            if (packet.type !== 'mls') return;
            if (packet.action === 'welcome' && record.brokenWelcomes > 0) {
                record.brokenWelcomes--;
                packet = { ...packet, welcome: 'AAAA' };
            }
            const deliver = () => record.session?.receive(packet);
            if (record.frozen) record.frozen.push(deliver);
            else setImmediate(deliver);
        });
        record.session = new DaveSession({
            identity: record.identity,
            boot,
            scope,
            bundle: (member) => known.get(member),
            present: (member) => visible.get(member) === scope,
            send: (packet) => {
                if (packet.action === 'key-package') record.keyPackages++;
                setImmediate(() => calls.mls(id, packet));
            },
            install: (secrets) => {
                record.secrets = secrets;
                record.installs++;
            },
            reset: () => record.resets++,
        });
        record.session.start();
    }
    function leave(id: string) {
        people.get(id)!.session?.close();
        people.get(id)!.session = undefined;
        visible.delete(id);
        calls.leave(id);
    }
    // Everyone listed derives the same base secret for every listed sender.
    const agreed = (ids: string[]) =>
        ids.every((id) => {
            const { secrets, session } = people.get(id)!;
            return (
                session?.members().size === ids.length &&
                ids.every((member) => {
                    const mine = secrets.get(member);
                    const theirs = people.get(ids[0])!.secrets.get(member);
                    return mine && theirs && Buffer.from(mine).equals(theirs);
                })
            );
        });
    function freeze(id: string) {
        people.get(id)!.frozen = [];
    }
    function thaw(id: string) {
        const record = people.get(id)!;
        const held = record.frozen || [];
        record.frozen = undefined;
        for (const deliver of held) setImmediate(deliver);
    }
    // Sessions retry on timers until closed, like a browser still in a call.
    async function close() {
        for (const record of people.values()) record.session?.close();
        await calls.close();
    }
    return {
        calls,
        close,
        people,
        visible,
        person,
        join,
        leave,
        agreed,
        freeze,
        thaw,
    };
}

test('call keys follow MLS membership as people join and leave', async () => {
    const h = harness();
    try {
        const [alice, bob, carol] = [
            await h.person(),
            await h.person(),
            await h.person(),
        ];
        h.join(alice);
        await until(() => h.agreed([alice]), 'alice creates the group');
        h.join(bob);
        h.join(carol);
        await until(() => h.agreed([alice, bob, carol]), 'three agree');
        const before = h.people.get(carol)!.secrets.get(carol)!;

        // Frames sealed with one member's view open with another member's.
        const send = await ratchetKey(
            h.people.get(alice)!.secrets.get(alice)!,
            0
        );
        const open = await ratchetKey(
            h.people.get(bob)!.secrets.get(alice)!,
            0
        );
        const opus = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
        const frame = await encryptFrame(
            send,
            9,
            opus,
            clearRanges('audio', opus)
        );
        assert.deepEqual(await decryptFrame(open, parseFrame(frame)!), opus);

        // Bob leaves; the remaining members rotate to keys bob never had.
        h.leave(bob);
        await until(() => h.agreed([alice, carol]), 'bob removed');
        const after = h.people.get(carol)!.secrets.get(carol)!;
        assert.equal(Buffer.from(before).equals(after), false);

        // The leader leaves; the next member takes over and admits a return.
        h.leave(alice);
        await until(() => h.agreed([carol]), 'carol alone');
        h.join(bob);
        await until(() => h.agreed([carol, bob]), 'bob back with carol');
    } finally {
        await h.close();
    }
});

test('members notice someone who hung up but still holds the call keys', async () => {
    const h = harness();
    try {
        const alice = await h.person();
        const bob = await h.person();
        h.join(alice);
        await until(() => h.agreed([alice]), 'alice creates the group');
        h.join(bob);
        await until(() => h.agreed([alice, bob]), 'bob joins');
        const roster = () =>
            [...h.people.keys()].map((id) => ({
                id,
                online: true,
                call: h.visible.get(id) ?? null,
            }));
        const stale = () =>
            lingering(
                h.people.get(alice)!.session!.members(),
                roster(),
                alice,
                'room'
            );
        assert.deepEqual(stale(), []);
        // Bob hangs up, but a colluding server keeps him in the group.
        h.visible.delete(bob);
        assert.deepEqual(stale(), [bob]);
        // An honest departure removes him from the keys.
        h.leave(bob);
        await until(() => h.agreed([alice]), 'bob removed');
        assert.deepEqual(stale(), []);
    } finally {
        await h.close();
    }
});

test('the leader admits no one the peer list does not show in the call', async () => {
    const h = harness();
    try {
        const alice = await h.person();
        const bob = await h.person();
        // A valid, known identity that the server keeps out of the visible
        // call list, as it would for a hidden or offline ghost member.
        const ghost = await h.person();
        h.join(alice);
        await until(() => h.agreed([alice]), 'alice creates the group');
        h.join(ghost, 'room', false);
        h.join(bob);
        await until(() => h.agreed([alice, bob]), 'bob joins');
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(h.people.get(ghost)!.installs, 0);
        assert.equal(h.people.get(alice)!.session!.members().has(ghost), false);
    } finally {
        await h.close();
    }
});

test('the server cannot admit anyone without a valid Hush identity signature', async () => {
    const h = harness();
    try {
        const alice = await h.person();
        const bob = await h.person();
        // A key package from an identity nobody in the call recognises, as a
        // malicious server would have to forge.
        const mallory = await h.person(false);
        h.join(alice);
        await until(() => h.agreed([alice]), 'alice creates the group');
        h.join(mallory);
        h.join(bob);
        await until(() => h.agreed([alice, bob]), 'bob joins');
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(h.people.get(mallory)!.installs, 0);
        assert.deepEqual(
            [...h.people.get(alice)!.session!.members()].sort(),
            [alice, bob].sort()
        );

        h.leave(mallory);

        // Someone outside a DM cannot be added to its call, even if known.
        const carol = await h.person();
        const dm = dmScope(alice, bob);
        for (const id of [alice, bob]) h.leave(id);
        // The real server refuses carol's join (validScope); here she gets a
        // seat, but only once alice's group exists, as a member would see.
        h.join(alice, dm);
        await until(() => h.agreed([alice]), 'alice starts the dm call');
        h.join(carol, dm);
        h.join(bob, dm);
        await until(() => h.agreed([alice, bob]), 'dm call');
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(h.people.get(carol)!.session!.members().size, 0);
        assert.equal(h.people.get(alice)!.session!.members().has(carol), false);
    } finally {
        await h.close();
    }
});

test('a leader that stops answering is passed over and keeps its keys', async () => {
    const h = harness();
    try {
        const [alice, bob, carol] = [
            await h.person(),
            await h.person(),
            await h.person(),
        ];
        h.join(alice);
        await until(() => h.agreed([alice]), 'alice creates the group');
        h.join(bob);
        await until(() => h.agreed([alice, bob]), 'bob joins');
        // Alice's tab freezes just as carol asks to join.
        h.freeze(alice);
        h.join(carol);
        await until(
            () =>
                [bob, carol].every(
                    (id) => h.people.get(id)!.session?.members().size === 3
                ),
            'bob admits carol',
            12_000
        );
        // Alice catches up from the commits she missed, without starting over.
        h.thaw(alice);
        await until(() => h.agreed([alice, bob, carol]), 'alice catches up');
        assert.equal(h.people.get(alice)!.keyPackages, 1);
        assert.equal(h.people.get(alice)!.resets, 0);
    } finally {
        await h.close();
    }
});

test('a member keeps asking to join until a welcome works', async () => {
    const h = harness();
    try {
        const alice = await h.person();
        const bob = await h.person();
        h.join(alice);
        await until(() => h.agreed([alice]), 'alice creates the group');
        // More failures in a row than the old retry budget allowed.
        h.people.get(bob)!.brokenWelcomes = 5;
        h.join(bob);
        await until(() => h.agreed([alice, bob]), 'bob joins', 15_000);
        assert.equal(h.people.get(bob)!.resets, 5);
        assert.equal(h.people.get(bob)!.keyPackages, 6);
    } finally {
        await h.close();
    }
});

// ts-mls 1.6.4 demanded identical unmerged_leaves on every ancestor of an
// unmerged leaf (scripts/patch-ts-mls.ts). This order leaves the root
// listing leaves 1 and 5 while its child on leaf 1's path lists only 1.
test('a joiner accepts a group whose unmerged leaves differ by level', async () => {
    const h = harness();
    try {
        const ids: string[] = [];
        for (let i = 0; i < 6; i++) ids.push(await h.person());
        const [a, b, c, d, e, f] = ids;
        for (let i = 0; i < ids.length; i++) {
            h.join(ids[i]);
            await until(() => h.agreed(ids.slice(0, i + 1)), `${i + 1} agree`);
        }
        // Removing leaves 1 and 5 refreshes the leader's path keys.
        h.leave(b);
        h.leave(f);
        await until(() => h.agreed([a, c, d, e]), 'b and f removed');
        h.join(b);
        await until(() => h.agreed([a, b, c, d, e]), 'b returns');
        h.join(f);
        await until(() => h.agreed(ids), 'f returns');
        assert.equal(h.people.get(f)!.resets, 0);
    } finally {
        await h.close();
    }
});
