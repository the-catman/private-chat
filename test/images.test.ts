import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import {
    createImageProxy,
    imageUrl,
    publicAddress,
    resolvePublic,
    ImageError,
    IMAGE_BYTES,
    type Resolve,
} from '../server/images';
import { createChatServer } from '../server/app';
import { readConfig } from '../server/config';

const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6b2sAAAAASUVORK5CYII=',
    'base64'
);

// A stand-in for a public image host. Tests reach it as images.test, which
// resolves to this loopback server; every other name uses the real checks.
async function upstream() {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
        hits.push(req.url!);
        const port = (server.address() as AddressInfo).port;
        switch (req.url) {
            case '/pic.png':
                res.writeHead(200, { 'content-type': 'text/plain' });
                return res.end(png);
            case '/page.html':
                res.writeHead(200, { 'content-type': 'image/png' });
                return res.end('<html><script>alert(1)</script></html>');
            case '/drawing.svg':
                res.writeHead(200, { 'content-type': 'image/svg+xml' });
                return res.end('<svg xmlns="http://www.w3.org/2000/svg"/>');
            case '/declared-large.png':
                res.writeHead(200, { 'content-length': IMAGE_BYTES + 1 });
                return res.end();
            case '/streamed-large.png':
                res.writeHead(200);
                res.write(png);
                return res.end(Buffer.alloc(IMAGE_BYTES));
            case '/moved.png':
                res.writeHead(302, { location: '/pic.png' });
                return res.end();
            case '/to-loopback.png':
                res.writeHead(302, {
                    location: `http://127.0.0.1:${port}/pic.png`,
                });
                return res.end();
            case '/loop.png':
                res.writeHead(302, { location: '/loop.png' });
                return res.end();
            default:
                res.writeHead(404);
                res.end();
        }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    const resolve: Resolve = async (host) =>
        host === 'images.test'
            ? { address: '127.0.0.1', family: 4 }
            : resolvePublic(host);
    return {
        hits,
        port,
        url: (path: string) => `http://images.test:${port}${path}`,
        resolve,
        close: () => new Promise((done) => server.close(done)),
    };
}

async function status(job: Promise<unknown>) {
    try {
        await job;
        return 200;
    } catch (error) {
        assert.ok(error instanceof ImageError, String(error));
        return error.status;
    }
}

test('only public addresses can be fetched', () => {
    for (const address of [
        '0.0.0.0',
        '10.1.2.3',
        '100.64.0.1',
        '127.0.0.1',
        '169.254.169.254',
        '172.16.0.1',
        '172.31.255.255',
        '192.168.1.1',
        '198.18.0.1',
        '224.0.0.1',
        '255.255.255.255',
        '::',
        '::1',
        '::ffff:127.0.0.1',
        '::ffff:7f00:1',
        '64:ff9b::7f00:1',
        '2002:7f00:1::1',
        '2001::1',
        '2001:db8::1',
        'fc00::1',
        'fd12:3456::1',
        'fe80::1',
        'ff02::1',
        'not-an-address',
    ])
        assert.equal(publicAddress(address), false, address);
    for (const address of [
        '1.1.1.1',
        '8.8.8.8',
        '93.184.215.14',
        '2606:4700:4700::1111',
        '2001:4860:4860::8888',
    ])
        assert.equal(publicAddress(address), true, address);
});

test('image links must be plain http or https URLs', () => {
    for (const raw of [
        null,
        '',
        'javascript:alert(1)',
        'data:image/png;base64,AAAA',
        'file:///etc/passwd',
        'ftp://example.com/a.png',
        'https://user:secret@example.com/a.png',
        `https://example.com/${'a'.repeat(2048)}.png`,
        'not a url',
    ])
        assert.equal(imageUrl(raw), null, String(raw));
    assert.equal(
        imageUrl('https://example.com/a.png?size=2#top')?.href,
        'https://example.com/a.png?size=2'
    );
});

test('the proxy returns real images once, and refuses everything else', async () => {
    const host = await upstream();
    const proxy = createImageProxy({ resolve: host.resolve });
    try {
        // Recognized by its bytes, whatever the server calls it.
        const image = await proxy.get(host.url('/pic.png'));
        assert.equal(image.mime, 'image/png');
        assert.ok(image.bytes.equals(png));
        await proxy.get(host.url('/pic.png#again'));
        await proxy.get(host.url('/moved.png'));
        assert.deepEqual(host.hits, ['/pic.png', '/moved.png', '/pic.png']);

        assert.equal(await status(proxy.get(host.url('/page.html'))), 415);
        assert.equal(await status(proxy.get(host.url('/drawing.svg'))), 415);
        assert.equal(
            await status(proxy.get(host.url('/declared-large.png'))),
            413
        );
        assert.equal(
            await status(proxy.get(host.url('/streamed-large.png'))),
            413
        );
        assert.equal(await status(proxy.get(host.url('/missing.png'))), 404);
        assert.equal(await status(proxy.get(host.url('/loop.png'))), 502);
        // A redirect is checked like the first address.
        assert.equal(
            await status(proxy.get(host.url('/to-loopback.png'))),
            403
        );
        const before = host.hits.length;
        // Failures are remembered for a while instead of fetched again.
        assert.equal(await status(proxy.get(host.url('/missing.png'))), 404);
        assert.equal(host.hits.length, before);
        assert.equal(await status(proxy.get('javascript:alert(1)')), 400);
    } finally {
        proxy.clear();
        await host.close();
    }
});

test('loopback, private and literal local addresses are never contacted', async () => {
    const host = await upstream();
    const proxy = createImageProxy();
    try {
        for (const url of [
            `http://127.0.0.1:${host.port}/pic.png`,
            `http://localhost:${host.port}/pic.png`,
            `http://[::1]:${host.port}/pic.png`,
            `http://[::ffff:127.0.0.1]:${host.port}/pic.png`,
            `http://2130706433:${host.port}/pic.png`,
            `http://0x7f.1:${host.port}/pic.png`,
            'http://169.254.169.254/latest/meta-data/',
            'http://10.0.0.1/a.png',
        ])
            assert.equal(await status(proxy.get(url)), 403, url);
        assert.deepEqual(host.hits, []);
    } finally {
        proxy.clear();
        await host.close();
    }
});

test('images load only for signed-in pages and cannot run as documents', async () => {
    const host = await upstream();
    const origin = 'https://chat.test';
    const password = 'test-password-only-not-a-real-secret';
    const app = createChatServer(
        readConfig({
            APP_PASSWORD: password,
            APP_ORIGIN: origin,
            MEDIA_PORT: '0',
            MEDIA_LISTEN_IP: '127.0.0.1',
            MEDIA_ANNOUNCED_ADDRESS: '127.0.0.1',
        }),
        { resolveImage: host.resolve }
    );
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const headers = {
        host: 'chat.test',
        origin,
        'x-forwarded-proto': 'https',
    };
    const get = (path: string, extra: Record<string, string> = {}) =>
        new Promise<http.IncomingMessage & { body: Buffer }>((done, fail) =>
            http
                .get(
                    `${base}${path}`,
                    { headers: { ...headers, ...extra } },
                    async (response) => {
                        const chunks: Buffer[] = [];
                        for await (const chunk of response) chunks.push(chunk);
                        done(
                            Object.assign(response, {
                                body: Buffer.concat(chunks),
                            })
                        );
                    }
                )
                .on('error', fail)
        );
    try {
        const path = `/api/image?url=${encodeURIComponent(host.url('/pic.png'))}`;
        assert.equal((await get(path)).statusCode, 401);
        assert.deepEqual(host.hits, []);
        const login = await new Promise<http.IncomingMessage>((done, fail) =>
            http
                .request(
                    `${base}/api/login`,
                    {
                        method: 'POST',
                        headers: {
                            ...headers,
                            'content-type': 'application/json',
                        },
                    },
                    done
                )
                .on('error', fail)
                .end(JSON.stringify({ password }))
        );
        const cookie = login.headers['set-cookie']![0]!.split(';')[0]!;
        const image = await get(path, { cookie });
        assert.equal(image.statusCode, 200);
        assert.equal(image.headers['content-type'], 'image/png');
        assert.equal(
            image.headers['content-security-policy'],
            "default-src 'none'; sandbox"
        );
        assert.match(String(image.headers['cache-control']), /no-store/);
        assert.equal(image.headers['x-content-type-options'], 'nosniff');
        assert.ok(image.body.equals(png));
        assert.equal(
            (await get(path, { cookie, 'sec-fetch-site': 'cross-site' }))
                .statusCode,
            403
        );
        const page = `/api/image?url=${encodeURIComponent(host.url('/page.html'))}`;
        assert.equal((await get(page, { cookie })).statusCode, 415);
        assert.equal(
            (await get('/api/image?url=http%3A%2F%2F127.0.0.1%2F', { cookie }))
                .statusCode,
            403
        );
    } finally {
        await app.close();
        await host.close();
    }
});
