import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalls } from '../server/calls';
import { readConfig } from '../server/config';
import { dmScope } from '../src/lib/crypto';
import { createIdentity } from './identities';
import { DaveSession, ratchetKey } from '../src/lib/dave';
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

async function until(check: () => boolean, label: string) {
    const deadline = Date.now() + 8000;
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
        }
    >();
    const known = new Map<string, Bundle>();
    async function person(trusted = true) {
        const identity = await createIdentity();
        if (trusted) known.set(identity.id, identity.bundle);
        people.set(identity.id, {
            identity,
            secrets: new Map(),
            installs: 0,
        });
        return identity.id;
    }
    function join(id: string, scope = 'room') {
        const record = people.get(id)!;
        calls.join(scope, id, (packet) => {
            if (packet.type === 'mls')
                setImmediate(() => record.session?.receive(packet));
        });
        record.session = new DaveSession({
            identity: record.identity,
            boot,
            scope,
            bundle: (member) => known.get(member),
            send: (packet) => setImmediate(() => calls.mls(id, packet)),
            install: (secrets) => {
                record.secrets = secrets;
                record.installs++;
            },
            fail: () => {},
        });
        record.session.start();
    }
    function leave(id: string) {
        people.get(id)!.session?.close();
        people.get(id)!.session = undefined;
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
    return { calls, people, person, join, leave, agreed };
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
        await h.calls.close();
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
        h.join(alice, dm);
        h.join(carol, dm);
        h.join(bob, dm);
        await until(() => h.agreed([alice, bob]), 'dm call');
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(h.people.get(carol)!.session!.members().size, 0);
        assert.equal(h.people.get(alice)!.session!.members().has(carol), false);
    } finally {
        await h.calls.close();
    }
});
