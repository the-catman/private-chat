import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity as create } from '../src/lib/crypto';
import { Ratchet, type RatchetStorage } from '../src/lib/signal';
import type { PrekeyBundle, RatchetKey } from '../src/types';
import { createIdentity } from './identities';

// Ratchet messages carry 32-byte content keys.
const bytes = (text: string) => {
    const key = new Uint8Array(32);
    key.set(new TextEncoder().encode(text));
    return key;
};
const text = (data: Uint8Array) =>
    new TextDecoder().decode(data).replace(/\0+$/, '');

// Stores structured clones, as IndexedDB would.
function storage() {
    const data = {
        sessions: new Map(),
        prekeys: new Map(),
        opened: new Map(),
        meta: new Map(),
    };
    const store: RatchetStorage = {
        load: async () =>
            Object.fromEntries(
                Object.entries(data).map(([name, map]) => [
                    name,
                    structuredClone([...map]),
                ])
            ) as Awaited<ReturnType<RatchetStorage['load']>>,
        put: (name, key, value) => data[name].set(key, structuredClone(value)),
        delete: (name, key) => data[name].delete(key),
        flush: async () => {},
    };
    return store;
}

test('X3DH and the Double Ratchet carry keys both ways, out of order, across many turns', async () => {
    const [alice, bob] = await Promise.all([
        createIdentity(),
        createIdentity(),
    ]);
    const first = await alice.ratchet.seal(bob, bytes('one'), 'ctx');
    const second = await alice.ratchet.seal(bob, bytes('two'), 'ctx');
    assert.ok(first.pre?.opk !== undefined, 'the first message runs X3DH');
    assert.deepEqual(first.pre, second.pre);
    assert.equal(text(await bob.ratchet.open(alice, second, 'ctx')), 'two');
    assert.equal(text(await bob.ratchet.open(alice, first, 'ctx')), 'one');
    const reply = await bob.ratchet.seal(alice, bytes('three'), 'ctx');
    assert.equal(reply.pre, undefined);
    assert.notEqual(reply.dh, first.dh, 'the reply turns the DH ratchet');
    assert.equal(text(await alice.ratchet.open(bob, reply, 'ctx')), 'three');
    const after = await alice.ratchet.seal(bob, bytes('four'), 'ctx');
    assert.equal(after.pre, undefined, 'X3DH values stop after a reply');
    assert.notEqual(after.dh, first.dh);
    // Several messages lost from one chain, then a new chain.
    const skipped: RatchetKey[] = [];
    for (let i = 0; i < 5; i++)
        skipped.push(await bob.ratchet.seal(alice, bytes(`late ${i}`), 'x'));
    assert.equal(text(await bob.ratchet.open(alice, after, 'ctx')), 'four');
    const next = await bob.ratchet.seal(alice, bytes('next'), 'x');
    assert.equal(text(await alice.ratchet.open(bob, next, 'x')), 'next');
    for (const [i, entry] of skipped.reverse().entries())
        assert.equal(
            text(await alice.ratchet.open(bob, entry, 'x')),
            `late ${4 - i}`
        );
});

test('replayed, altered, misdirected and wrong-context ratchet keys are rejected', async () => {
    const [alice, bob, mallory] = await Promise.all([
        createIdentity(),
        createIdentity(),
        createIdentity(),
    ]);
    const entry = await alice.ratchet.seal(bob, bytes('secret'), 'ctx');
    await assert.rejects(bob.ratchet.open(alice, entry, 'other'));
    await assert.rejects(mallory.ratchet.open(alice, entry, 'ctx'));
    await assert.rejects(bob.ratchet.open(mallory, entry, 'ctx'));
    const flipped = `${entry.data[0] === 'A' ? 'B' : 'A'}${entry.data.slice(1)}`;
    await assert.rejects(
        bob.ratchet.open(alice, { ...entry, data: flipped }, 'ctx')
    );
    await assert.rejects(
        bob.ratchet.open(alice, { ...entry, n: entry.n + 1 }, 'ctx')
    );
    assert.equal(text(await bob.ratchet.open(alice, entry, 'ctx')), 'secret');
    await assert.rejects(bob.ratchet.open(alice, entry, 'ctx'), /decrypted/);
    await assert.rejects(
        bob.ratchet.open(
            alice,
            { ...entry, extra: true } as unknown as RatchetKey,
            'ctx'
        ),
        /Invalid/
    );
});

test('a one-time prekey opens one session, and forged prekeys are refused', async () => {
    const [alice, bob, carol] = await Promise.all([
        createIdentity(),
        createIdentity(),
        createIdentity(),
    ]);
    const bundle = await bob.ratchet.bundle();
    alice.ratchet.fetch = async () => bundle;
    carol.ratchet.fetch = async () => bundle;
    const fromAlice = await alice.ratchet.seal(bob, bytes('a'), 'c');
    const fromCarol = await carol.ratchet.seal(bob, bytes('c'), 'c');
    assert.equal(text(await bob.ratchet.open(alice, fromAlice, 'c')), 'a');
    await assert.rejects(
        bob.ratchet.open(carol, fromCarol, 'c'),
        /no longer available/
    );
    const forged: PrekeyBundle = {
        spk: { ...bundle.spk, key: (await carol.ratchet.bundle()).spk.key },
    };
    const dave = await createIdentity();
    dave.ratchet.fetch = async () => forged;
    await assert.rejects(
        dave.ratchet.seal(bob, bytes('d'), 'c'),
        /could not be verified/
    );
    // Without a one-time prekey, X3DH still runs on the signed prekey.
    dave.ratchet.fetch = async () => ({ spk: bundle.spk });
    const plain = await dave.ratchet.seal(bob, bytes('d'), 'c');
    assert.equal(plain.pre?.opk, undefined);
    assert.equal(text(await bob.ratchet.open(dave, plain, 'c')), 'd');
});

test('simultaneous first messages leave both sessions working', async () => {
    const [alice, bob] = await Promise.all([
        createIdentity(),
        createIdentity(),
    ]);
    const [a1, b1] = await Promise.all([
        alice.ratchet.seal(bob, bytes('hi bob'), 'c'),
        bob.ratchet.seal(alice, bytes('hi alice'), 'c'),
    ]);
    assert.ok(a1.pre && b1.pre);
    assert.equal(text(await bob.ratchet.open(alice, a1, 'c')), 'hi bob');
    assert.equal(text(await alice.ratchet.open(bob, b1, 'c')), 'hi alice');
    for (let i = 0; i < 3; i++) {
        const a = await alice.ratchet.seal(bob, bytes(`a${i}`), 'c');
        const b = await bob.ratchet.seal(alice, bytes(`b${i}`), 'c');
        assert.equal(text(await bob.ratchet.open(alice, a, 'c')), `a${i}`);
        assert.equal(text(await alice.ratchet.open(bob, b, 'c')), `b${i}`);
    }
});

test('ratchet state, own keys and opened keys survive a reload from storage', async () => {
    const [alice, bob] = await Promise.all([createIdentity(), create()]);
    const saved = storage();
    bob.ratchet = await new Ratchet(bob, saved).load();
    alice.ratchet.fetch = async () => bob.ratchet.bundle();
    const entry = await alice.ratchet.seal(bob, bytes('before'), 'c');
    const own = await bob.ratchet.lock(bytes('mine'), 'own');
    const key = await bob.ratchet.open(alice, entry, 'c');
    bob.ratchet.remember('m1', alice.id, 'room', key);
    bob.ratchet.remember('m2', alice.id, 'dm', key);

    const reloaded = await new Ratchet(bob, saved).load();
    assert.equal(text(reloaded.recall('m1', alice.id)!), 'before');
    assert.equal(reloaded.recall('m1', bob.id), undefined);
    assert.equal(text(await reloaded.unlock(own, 'own')), 'mine');
    const later = await alice.ratchet.seal(bob, bytes('after'), 'c');
    assert.equal(text(await reloaded.open(alice, later, 'c')), 'after');
    const reply = await reloaded.seal(alice, bytes('reply'), 'c');
    assert.equal(text(await alice.ratchet.open(bob, reply, 'c')), 'reply');
    reloaded.forgetScope('room');
    reloaded.forget(['m2']);
    const empty = await new Ratchet(bob, saved).load();
    assert.equal(empty.recall('m1', alice.id), undefined);
    assert.equal(empty.recall('m2', alice.id), undefined);
});
