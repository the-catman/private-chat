// DAVE media frames: the codec payload is encrypted in place, with a trailer of
// [8-byte tag][ULEB128 nonce][ULEB128 clear ranges][size][0xFAFA].
// AES-128-GCM uses a 64-bit tag; the clear bytes are authenticated as AAD.
export const TAG_BYTES = 8;
const MAGIC = 0xfa;
export type Ranges = [offset: number, length: number][];

// Opus is fully encrypted. VP8 keeps its frame tag (and on keyframes, the
// dimensions) readable so packetizers and the SFU can find keyframes.
export function clearRanges(kind: 'audio' | 'video', data: Uint8Array): Ranges {
    if (kind === 'audio' || !data.length) return [];
    return [[0, Math.min(data.length, (data[0] & 1) === 0 ? 10 : 1)]];
}

function uleb(value: number, out: number[]) {
    do {
        let byte = value & 0x7f;
        value = Math.floor(value / 128);
        if (value) byte |= 0x80;
        out.push(byte);
    } while (value);
}
function readUleb(data: Uint8Array, at: number, end: number) {
    let value = 0;
    for (let shift = 0, i = at; i < end && shift < 35; shift += 7, i++) {
        value += (data[i] & 0x7f) * 2 ** shift;
        if (!(data[i] & 0x80))
            return value <= 0xffffffff ? { value, next: i + 1 } : null;
    }
    return null;
}

export function iv(nonce: number) {
    const bytes = new Uint8Array(12);
    new DataView(bytes.buffer).setUint32(8, nonce, true);
    return bytes;
}
export const generation = (nonce: number) => nonce >>> 24;

function split(data: Uint8Array, ranges: Ranges) {
    const clear = ranges.reduce((sum, [, length]) => sum + length, 0);
    const aad = new Uint8Array(clear);
    const secret = new Uint8Array(data.length - clear);
    let a = 0;
    let s = 0;
    let at = 0;
    for (const [offset, length] of ranges) {
        secret.set(data.subarray(at, offset), s);
        s += offset - at;
        aad.set(data.subarray(offset, offset + length), a);
        a += length;
        at = offset + length;
    }
    secret.set(data.subarray(at), s);
    return { aad, secret };
}
function join(out: Uint8Array, secret: Uint8Array, ranges: Ranges) {
    let s = 0;
    let at = 0;
    for (const [offset, length] of [...ranges, [out.length, 0]]) {
        out.set(secret.subarray(s, s + offset - at), at);
        s += offset - at;
        at = offset + length;
    }
}

export async function encryptFrame(
    key: CryptoKey,
    nonce: number,
    data: Uint8Array,
    ranges: Ranges
) {
    const { aad, secret } = split(data, ranges);
    const sealed = new Uint8Array(
        await crypto.subtle.encrypt(
            {
                name: 'AES-GCM',
                iv: iv(nonce),
                additionalData: aad,
                tagLength: TAG_BYTES * 8,
            },
            key,
            secret
        )
    );
    const trailer: number[] = [];
    uleb(nonce, trailer);
    for (const [offset, length] of ranges) {
        uleb(offset, trailer);
        uleb(length, trailer);
    }
    const size = TAG_BYTES + trailer.length + 3;
    const out = new Uint8Array(data.length + size);
    out.set(data);
    join(out.subarray(0, data.length), sealed, ranges);
    out.set(sealed.subarray(secret.length), data.length);
    out.set(trailer, data.length + TAG_BYTES);
    out.set([size, MAGIC, MAGIC], out.length - 3);
    return out;
}

export type ParsedFrame = {
    body: Uint8Array;
    tag: Uint8Array;
    nonce: number;
    ranges: Ranges;
};
// Anything without a well-formed trailer is dropped, never played as-is.
export function parseFrame(frame: Uint8Array): ParsedFrame | null {
    const end = frame.length - 3;
    if (end < 0 || frame[end + 1] !== MAGIC || frame[end + 2] !== MAGIC)
        return null;
    const size = frame[end];
    const start = frame.length - size;
    if (size < TAG_BYTES + 4 || start < 0) return null;
    const nonce = readUleb(frame, start + TAG_BYTES, end);
    if (!nonce) return null;
    const ranges: Ranges = [];
    let at = nonce.next;
    let covered = 0;
    while (at < end) {
        const offset = readUleb(frame, at, end);
        const length = offset && readUleb(frame, offset.next, end);
        if (!offset || !length || offset.value < covered || length.value < 1)
            return null;
        covered = offset.value + length.value;
        if (covered > start || ranges.length >= 8) return null;
        ranges.push([offset.value, length.value]);
        at = length.next;
    }
    return {
        body: frame.subarray(0, start),
        tag: frame.subarray(start, start + TAG_BYTES),
        nonce: nonce.value,
        ranges,
    };
}

export async function decryptFrame(key: CryptoKey, frame: ParsedFrame) {
    const { aad, secret } = split(frame.body, frame.ranges);
    const sealed = new Uint8Array(secret.length + TAG_BYTES);
    sealed.set(secret);
    sealed.set(frame.tag, secret.length);
    let plain: Uint8Array;
    try {
        plain = new Uint8Array(
            await crypto.subtle.decrypt(
                {
                    name: 'AES-GCM',
                    iv: iv(frame.nonce),
                    additionalData: aad,
                    tagLength: TAG_BYTES * 8,
                },
                key,
                sealed
            )
        );
    } catch {
        return null;
    }
    const out = new Uint8Array(frame.body);
    join(out, plain, frame.ranges);
    return out;
}

// A sliding window rejects replayed frames without requiring strict order:
// one sender's audio and video share a counter but arrive on separate streams.
export class ReplayWindow {
    private top = -1;
    private seen = new Uint8Array(1024 / 8);
    accept(nonce: number) {
        if (nonce > this.top) {
            for (let n = Math.max(this.top + 1, nonce - 1023); n <= nonce; n++)
                this.seen[(n & 1023) >> 3] &= ~(1 << (n & 7));
            this.top = nonce;
        } else if (nonce <= this.top - 1024) return false;
        const bit = 1 << (nonce & 7);
        const index = (nonce & 1023) >> 3;
        if (this.seen[index] & bit) return false;
        this.seen[index] |= bit;
        return true;
    }
}
