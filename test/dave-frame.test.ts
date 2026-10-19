import test from 'node:test';
import assert from 'node:assert/strict';
import {
    clearRanges,
    decryptFrame,
    encryptFrame,
    parseFrame,
    ReplayWindow,
} from '../src/lib/dave-frame';

const key = () =>
    crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, false, [
        'encrypt',
        'decrypt',
    ]);

test('DAVE frames encrypt Opus fully and keep only the VP8 header readable', async () => {
    const k = await key();
    const opus = crypto.getRandomValues(new Uint8Array(120));
    const sealed = await encryptFrame(k, 7, opus, clearRanges('audio', opus));
    assert.deepEqual([...sealed.subarray(-2)], [0xfa, 0xfa]);
    assert.equal(sealed.length, opus.length + 8 + 1 + 3);
    assert.notDeepEqual(sealed.subarray(0, 120), opus);
    const parsed = parseFrame(sealed)!;
    assert.equal(parsed.nonce, 7);
    assert.deepEqual(await decryptFrame(k, parsed), opus);

    const keyframe = crypto.getRandomValues(new Uint8Array(3000));
    keyframe[0] &= 0xfe;
    const video = await encryptFrame(
        k,
        300,
        keyframe,
        clearRanges('video', keyframe)
    );
    assert.deepEqual(video.subarray(0, 10), keyframe.subarray(0, 10));
    assert.notDeepEqual(video.subarray(10, 3000), keyframe.subarray(10));
    const delta = new Uint8Array([1, 2, 3, 4]);
    assert.deepEqual(clearRanges('video', delta), [[0, 1]]);
    const parsedVideo = parseFrame(video)!;
    assert.deepEqual(parsedVideo.ranges, [[0, 10]]);
    assert.deepEqual(await decryptFrame(k, parsedVideo), keyframe);
});

test('DAVE frames reject tampering, wrong keys, plain media and replays', async () => {
    const k = await key();
    const data = crypto.getRandomValues(new Uint8Array(64));
    data[0] &= 0xfe;
    const sealed = await encryptFrame(k, 1, data, clearRanges('video', data));
    // The clear header is authenticated even though it is readable.
    const header = sealed.slice();
    header[2] ^= 1;
    assert.equal(await decryptFrame(k, parseFrame(header)!), null);
    const body = sealed.slice();
    body[20] ^= 1;
    assert.equal(await decryptFrame(k, parseFrame(body)!), null);
    assert.equal(await decryptFrame(await key(), parseFrame(sealed)!), null);
    assert.equal(parseFrame(data), null);
    assert.equal(parseFrame(new Uint8Array([0xfa, 0xfa])), null);
    // Ranges outside the body or overlapping each other are malformed.
    const broken = sealed.slice();
    broken[sealed.length - 4] = 0x7f;
    assert.equal(parseFrame(broken), null);

    const window = new ReplayWindow();
    assert.equal(window.accept(5), true);
    assert.equal(window.accept(5), false);
    assert.equal(window.accept(3), true);
    assert.equal(window.accept(2000), true);
    assert.equal(window.accept(900), false);
    assert.equal(window.accept(1990), true);
    assert.equal(window.accept(1990), false);
    assert.equal(window.accept(0xffffffff), true);
});
