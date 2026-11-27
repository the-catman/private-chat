import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { networkInterfaces } from 'node:os';
import { imageType, type ImageMime } from '../src/lib/image-type.ts';

// Image links in messages load through the server, so the sites hosting them
// never see readers' IP addresses. Fetches reach only public addresses, follow
// few redirects, stop at a size limit, and keep results in RAM for a while.
export const IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_URL = 2048;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const CACHE_BYTES = 64 * 1024 * 1024;
const CACHE_ENTRIES = 2048;
const CACHE_MS = 60 * 60_000;
const FAILURE_MS = 5 * 60_000;
const MAX_FAILURES = 1024;
const CONCURRENT = 6;
const MAX_WAITING = 64;

const reserved4 = new BlockList();
for (const [net, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
] as const)
    reserved4.addSubnet(net, prefix, 'ipv4');
// IPv6 must be global unicast, minus the documentation and tunnelling ranges
// that can wrap a private IPv4 address.
const global6 = new BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
const reserved6 = new BlockList();
for (const [net, prefix] of [
    ['2001::', 23],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['3fff::', 20],
] as const)
    reserved6.addSubnet(net, prefix, 'ipv6');

export function publicAddress(address: string) {
    const family = isIP(address);
    if (family === 4) return !reserved4.check(address, 'ipv4');
    if (family === 6)
        return (
            global6.check(address, 'ipv6') && !reserved6.check(address, 'ipv6')
        );
    return false;
}

// This machine's own addresses may expose services that are firewalled from
// the internet, so they are refused as well.
function ownAddress(address: string) {
    return Object.values(networkInterfaces()).some((list) =>
        list?.some((item) => item.address === address)
    );
}

export type Resolve = (host: string) => Promise<{
    address: string;
    family: number;
}>;

// Every address a name resolves to must be public; the connection then uses
// the checked address, so a second DNS answer cannot redirect it.
export const resolvePublic: Resolve = async (host) => {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (
        !addresses.length ||
        addresses.some(
            ({ address }) => !publicAddress(address) || ownAddress(address)
        )
    )
        throw new ImageError(403);
    return addresses[0]!;
};

export class ImageError extends Error {
    constructor(readonly status: number) {
        super(`Image unavailable (${status})`);
    }
}

export function imageUrl(raw: unknown) {
    if (typeof raw !== 'string' || !raw || raw.length > MAX_URL) return null;
    try {
        const url = new URL(raw);
        if (
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            !url.hostname
        )
            return null;
        url.hash = '';
        return url;
    } catch {
        return null;
    }
}

type Image = { bytes: Buffer; mime: ImageMime };

export function createImageProxy({
    resolve = resolvePublic,
}: { resolve?: Resolve } = {}) {
    const cache = new Map<string, Image & { expires: number }>();
    let cachedBytes = 0;
    const failures = new Map<string, { status: number; expires: number }>();
    const pending = new Map<string, Promise<Image>>();
    let active = 0;
    const waiting: (() => void)[] = [];

    function remember(key: string, image: Image) {
        forget(key);
        if (image.bytes.length > CACHE_BYTES / 4) return;
        cache.set(key, { ...image, expires: Date.now() + CACHE_MS });
        cachedBytes += image.bytes.length;
        for (const old of cache.keys()) {
            if (cachedBytes <= CACHE_BYTES && cache.size <= CACHE_ENTRIES)
                break;
            forget(old);
        }
    }
    function forget(key: string) {
        const entry = cache.get(key);
        if (!entry) return;
        cache.delete(key);
        cachedBytes -= entry.bytes.length;
    }
    function failed(key: string, status: number) {
        failures.delete(key);
        failures.set(key, { status, expires: Date.now() + FAILURE_MS });
        if (failures.size > MAX_FAILURES)
            failures.delete(failures.keys().next().value!);
    }

    async function slot() {
        if (active < CONCURRENT) {
            active++;
            return;
        }
        if (waiting.length >= MAX_WAITING) throw new ImageError(503);
        await new Promise<void>((done) => waiting.push(done));
    }
    function release() {
        const next = waiting.shift();
        if (next) next();
        else active--;
    }

    function request(
        url: URL,
        address: string,
        family: number,
        signal: AbortSignal
    ) {
        const pinned = ((_host, options, callback) => {
            if (options.all) callback(null, [{ address, family }]);
            else callback(null, address, family);
        }) as LookupFunction;
        return new Promise<IncomingMessage>((done, fail) => {
            const req = (url.protocol === 'https:' ? https : http).request(
                url,
                {
                    method: 'GET',
                    lookup: pinned,
                    agent: false,
                    signal,
                    timeout: TIMEOUT_MS,
                    headers: {
                        'user-agent': 'Mozilla/5.0 (compatible; image proxy)',
                        accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1',
                        'accept-encoding': 'identity',
                    },
                },
                done
            );
            req.on('timeout', () => req.destroy(new ImageError(504)));
            req.on('error', fail);
            req.end();
        });
    }

    async function download(start: URL, deadline: AbortSignal) {
        let url = start;
        for (let hop = 0; ; hop++) {
            const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
            const { address, family } = await Promise.race([
                resolve(host),
                new Promise<never>((_, fail) => {
                    deadline.throwIfAborted();
                    deadline.addEventListener(
                        'abort',
                        () => fail(new ImageError(504)),
                        { once: true }
                    );
                }),
            ]);
            const response = await request(url, address, family, deadline);
            const status = response.statusCode || 0;
            const location = response.headers.location;
            if (status !== 200) response.destroy();
            if ([301, 302, 303, 307, 308].includes(status)) {
                const next = location && imageUrl(new URL(location, url).href);
                if (!next || hop >= MAX_REDIRECTS) throw new ImageError(502);
                url = next;
                continue;
            }
            if (status !== 200)
                throw new ImageError(status === 404 ? 404 : 502);
            if (Number(response.headers['content-length']) > IMAGE_BYTES) {
                response.destroy();
                throw new ImageError(413);
            }
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of response as AsyncIterable<Buffer>) {
                size += chunk.length;
                if (size > IMAGE_BYTES) {
                    response.destroy();
                    throw new ImageError(413);
                }
                chunks.push(chunk);
            }
            const bytes = Buffer.concat(chunks, size);
            const mime = imageType(bytes);
            if (!mime) throw new ImageError(415);
            return { bytes, mime };
        }
    }

    async function load(url: URL): Promise<Image> {
        await slot();
        try {
            return await download(url, AbortSignal.timeout(TIMEOUT_MS));
        } finally {
            release();
        }
    }

    return {
        // Resolves to the image, or throws an ImageError with an HTTP status.
        async get(raw: unknown): Promise<Image> {
            const url = imageUrl(raw);
            if (!url) throw new ImageError(400);
            const key = url.href;
            const now = Date.now();
            const hit = cache.get(key);
            if (hit && hit.expires > now) {
                // Refresh its place so busy images stay cached.
                cache.delete(key);
                cache.set(key, hit);
                return hit;
            }
            if (hit) forget(key);
            const failure = failures.get(key);
            if (failure && failure.expires > now)
                throw new ImageError(failure.status);
            let job = pending.get(key);
            if (!job) {
                job = load(url)
                    .then((image) => {
                        remember(key, image);
                        return image;
                    })
                    .catch((error: unknown) => {
                        const status =
                            error instanceof ImageError ? error.status : 502;
                        if (status !== 503) failed(key, status);
                        throw new ImageError(status);
                    })
                    .finally(() => pending.delete(key));
                pending.set(key, job);
            }
            return job;
        },
        clear() {
            cache.clear();
            cachedBytes = 0;
            failures.clear();
        },
    };
}
