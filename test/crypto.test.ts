import test from 'node:test';
import assert from 'node:assert/strict';
import { seal, open, dmScope, safetyCode, unb64 } from '../src/lib/crypto';
import { createIdentity } from './identities';

test('only intended recipients can decrypt text and binary voice content', async () => {
    const [alice, bob, outsider] = await Promise.all([
        createIdentity(),
        createIdentity(),
        createIdentity(),
    ]);
    const scope = dmScope(alice.id, bob.id);
    const content = {
        kind: 'text',
        text: 'This must never reach the relay in plaintext.',
    };
    const message = await seal(
        alice,
        [alice, bob],
        'boot-one',
        scope,
        'chat',
        content
    );
    assert.deepEqual(await open(bob, alice, 'boot-one', message), content);
    assert.deepEqual(await open(alice, alice, 'boot-one', message), content);
    await assert.rejects(open(outsider, alice, 'boot-one', message));
    assert.equal(JSON.stringify(message).includes(content.text), false);
    const voice = {
        kind: 'voice',
        audio: 'AAECAwQF',
        mime: 'audio/webm;codecs=opus',
        duration: 2,
    };
    const voiceMessage = await seal(
        alice,
        [alice, bob],
        'boot-one',
        scope,
        'chat',
        voice
    );
    assert.deepEqual(await open(bob, alice, 'boot-one', voiceMessage), voice);
    assert.equal(unb64(message.iv).length, 12);
    assert.notEqual(message.iv, voiceMessage.iv);
});

test('tampering with ciphertext, routing, recipients, identity, or server epoch is rejected', async () => {
    const [alice, bob, attacker] = await Promise.all([
        createIdentity(),
        createIdentity(),
        createIdentity(),
    ]);
    const message = await seal(alice, [alice, bob], 'epoch', 'room', 'chat', {
        kind: 'text',
        text: 'hello',
    });
    for (const modified of [
        {
            ...message,
            data: `${message.data[0] === 'A' ? 'B' : 'A'}${message.data.slice(1)}`,
        },
        { ...message, scope: dmScope(alice.id, bob.id) },
        { ...message, from: attacker.id },
        { ...message, time: message.time + 1 },
        { ...message, keys: { [bob.id]: message.keys[bob.id] } },
    ])
        await assert.rejects(open(bob, alice, 'epoch', modified));
    await assert.rejects(open(bob, alice, 'different-epoch', message));
    await assert.rejects(
        open(bob, { ...attacker, id: alice.id }, 'epoch', message)
    );
});

test('device private keys are nonexportable and safety codes bind both identities', async () => {
    const [alice, bob, replacement] = await Promise.all([
        createIdentity(),
        createIdentity(),
        createIdentity(),
    ]);
    await assert.rejects(crypto.subtle.exportKey('jwk', alice.dh.privateKey));
    await assert.rejects(crypto.subtle.exportKey('jwk', alice.sign.privateKey));
    assert.equal(
        await safetyCode(alice.id, bob.id),
        await safetyCode(bob.id, alice.id)
    );
    assert.notEqual(
        await safetyCode(alice.id, bob.id),
        await safetyCode(alice.id, replacement.id)
    );
});
