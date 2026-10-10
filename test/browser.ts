import assert from 'node:assert/strict';
import { chromium, expect, type Page } from '@playwright/test';
import { createServer } from 'node:https';
import { once } from 'node:events';
import {
    mkdtemp,
    mkdir,
    readFile,
    rm,
    cp,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { createChatServer } from '../server/app';
import { readConfig } from '../server/config';
import { createDevFrontend } from '../server/frontend';
import NodeWebSocket from 'ws';
import { observeSpeaking, checkSpeaking } from './speaking-checks';
import {
    checkParticipantVolume,
    checkMarkdown,
    checkClearChat,
} from './qol-checks';
import {
    observeAudio,
    checkAudioPreferences,
    checkEnhancedReady,
    checkCallLayoutAndNoise,
    checkScreenAudioAndPopout,
    checkCaptureCleanup,
    checkFourPersonCall,
} from './call-checks';

declare global {
    interface Window {
        __testTraffic: string[];
        __testPeers: RTCPeerConnection[];
        __testSockets: WebSocket[];
    }
}

const dir = await mkdtemp(join(tmpdir(), 'hush-browser-'));
const password = 'synthetic-test-password-for-browser-tests';
const config = readConfig({
    APP_PASSWORD: password,
    APP_ORIGIN: 'https://127.0.0.1',
    STUN_URLS: '',
});
let app: ReturnType<typeof createChatServer>;
const actualProject = process.env.TEST_DEV === 'project';
const devRoot = actualProject
    ? resolve('.')
    : process.env.TEST_DEV === '1'
      ? join(dir, 'frontend')
      : '';
await promisify(execFile)('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(dir, 'key.pem'),
    '-out',
    join(dir, 'cert.pem'),
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
]);
// Test-only HTTPS ingress emulates Caddy. The public server has no HTTP bypass.
const ingress = createServer(
    {
        key: await readFile(join(dir, 'key.pem')),
        cert: await readFile(join(dir, 'cert.pem')),
    },
    (req, res) => {
        req.headers['x-forwarded-proto'] = 'https';
        app.server.emit('request', req, res);
    }
);
ingress.on('upgrade', (req, socket, head) => {
    req.headers['x-forwarded-proto'] = 'https';
    app.server.emit('upgrade', req, socket, head);
});
ingress.listen(0, '127.0.0.1');
await once(ingress, 'listening');
config.host = `127.0.0.1:${(ingress.address() as AddressInfo).port}`;
config.origin = `https://${config.host}`;
if (devRoot && !actualProject) {
    await mkdir(devRoot, { recursive: true });
    for (const path of ['src', 'index.html', 'tsconfig.json'])
        await cp(resolve(path), join(devRoot, path), { recursive: true });
    await symlink(
        resolve('node_modules'),
        join(devRoot, 'node_modules'),
        'dir'
    );
}
app = createChatServer(config, {
    dist: resolve(process.env.TEST_DIST || 'dist'),
    frontend: devRoot ? await createDevFrontend(config, devRoot) : undefined,
});

const browser = await chromium.launch({
    headless: true,
    args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--auto-select-desktop-capture-source=Entire screen',
        '--enable-usermedia-screen-capturing',
    ],
});
const errors: string[] = [];
await mkdir('test-results', { recursive: true });
async function participant(name: string) {
    const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        permissions: ['microphone', 'camera'],
        viewport: { width: 1440, height: 950 },
    });
    await observeAudio(context);
    await observeSpeaking(context);
    await context.addInitScript(() => {
        window.__testTraffic = [];
        window.__testPeers = [];
        window.__testSockets = [];
        const OriginalSocket = window.WebSocket;
        window.WebSocket = class extends OriginalSocket {
            constructor(url: string | URL, protocols?: string | string[]) {
                super(url, protocols);
                window.__testSockets.push(this);
                this.addEventListener('message', (event) =>
                    window.__testTraffic.push(String(event.data))
                );
            }
            override send(data: string | Blob | BufferSource) {
                window.__testTraffic.push(String(data));
                super.send(data);
            }
        };
        const OriginalPeer = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends OriginalPeer {
            constructor(options?: RTCConfiguration) {
                super(options);
                window.__testPeers.push(this);
            }
        };
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
        if (
            response.status() >= 400 &&
            ['script', 'stylesheet', 'font'].includes(
                response.request().resourceType()
            )
        )
            errors.push(
                `Frontend asset failed: ${response.status()} ${new URL(response.url()).pathname}`
            );
    });
    page.on('console', (event) => {
        if (
            event.type() === 'error' &&
            /Content Security Policy|violates.*directive/i.test(event.text())
        )
            errors.push(event.text());
    });
    await page.goto(config.origin);
    await page.getByLabel('What should we call you?').fill(name);
    await page.getByLabel('Room password').fill(password);
    await page
        .getByRole('button', { name: 'Enter your space', exact: true })
        .click();
    await expect(
        page.getByRole('heading', { name: 'The living room', exact: true })
    ).toBeVisible();
    return { context, page };
}
async function message(page: Page, text: string) {
    await page.locator('.composer textarea').fill(text);
    await page
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
    await expect(page.getByText(text, { exact: true })).toBeVisible();
    await expect(page.locator('.composer textarea')).toBeFocused();
}

try {
    const alice = await participant('Alice');
    const bob = await participant('Bob');
    const charlie = await participant('Charlie');
    await expect(alice.page.locator('.space-heading')).toContainText(
        '3 of 4 here'
    );
    await message(alice.page, 'A hello for everyone in this room.');
    await expect(
        bob.page.getByText('A hello for everyone in this room.', {
            exact: true,
        })
    ).toBeVisible();
    await expect(
        charlie.page.getByText('A hello for everyone in this room.', {
            exact: true,
        })
    ).toBeVisible();
    if (devRoot) {
        const originalBoot = app.boot;
        if (!actualProject) {
            const stylePath = join(devRoot, 'src/style.css');
            await writeFile(
                stylePath,
                (await readFile(stylePath, 'utf8')) +
                    '\n:root { --hush-hmr-check: 123; }\n'
            );
            await expect
                .poll(() =>
                    alice.page.evaluate(() =>
                        getComputedStyle(document.documentElement)
                            .getPropertyValue('--hush-hmr-check')
                            .trim()
                    )
                )
                .toBe('123');
            const mainPath = join(devRoot, 'src/main.tsx');
            await writeFile(
                mainPath,
                (await readFile(mainPath, 'utf8')).replace(
                    'YOUR SPACE',
                    'Frontend refresh test'
                )
            );
            await expect(
                alice.page.getByText('Frontend refresh test', { exact: true })
            ).toBeVisible({ timeout: 15000 });
            await expect(
                alice.page.getByText('A hello for everyone in this room.', {
                    exact: true,
                })
            ).toBeVisible();
        }
        assert.equal(app.boot, originalBoot);
        assert.equal(app.stats().messages, 1);
        for (const path of [
            '/.env',
            '/server/app.ts',
            '/test/browser.ts',
            '/@fs/etc/passwd',
            '/.vite/deps/../../.env',
            '/src/../server/config.ts?raw',
            '/node_modules/vite/package.json',
            '/node_modules/vite/dist/node/index.js',
        ]) {
            const response = await alice.page.request.get(config.origin + path);
            assert.equal(
                response.status(),
                404,
                `${path} must not be exposed by Vite`
            );
        }
        const crossOriginStatus = await new Promise<number>(
            (resolve, reject) => {
                const socket = new NodeWebSocket(
                    `wss://${config.host}/__vite_hmr`,
                    'vite-ping',
                    {
                        rejectUnauthorized: false,
                        origin: 'https://other.example',
                    }
                );
                socket.on('unexpected-response', (_request, response) => {
                    resolve(response.statusCode!);
                    response.destroy();
                    socket.terminate();
                });
                socket.on('open', () => {
                    socket.close();
                    reject(
                        new Error('Vite accepted a cross-origin connection')
                    );
                });
                socket.on('error', reject);
            }
        );
        assert.equal(crossOriginStatus, 403);
        console.log(
            actualProject
                ? 'PASS: actual project Vite startup through HTTPS, restricted development paths and WebSocket origin checks'
                : 'PASS: HTTPS Vite CSS updates, automatic frontend reload, preserved RAM history and restricted development paths'
        );
    }
    const fontSample =
        'Font check: 1234567890 #* café — 👋🏽 ❤️ 🇱🇧 👨‍👩‍👧‍👦 1️⃣ 🩷 🫪 🫱🏻‍🫲🏽';
    await message(charlie.page, fontSample);
    const fontRow = alice.page
        .getByTestId('chat-message')
        .filter({ hasText: fontSample });
    await expect(fontRow).toBeVisible();
    await alice.page.evaluate(async () => {
        await document.fonts.ready;
        await document.fonts.load('16px "DM Sans"', 'café');
        await document.fonts.load('20px Twemoji', '👋🏽 ❤️ 🇱🇧 👨‍👩‍👧‍👦 1️⃣ 🩷 🫪 🫱🏻‍🫲🏽');
    });
    await fontRow
        .locator('.message-text')
        .evaluate((node) => node.setAttribute('data-font-probe', 'true'));
    const fontSession = await alice.context.newCDPSession(alice.page);
    await fontSession.send('DOM.enable');
    await fontSession.send('CSS.enable');
    const { root } = await fontSession.send('DOM.getDocument');
    const { nodeId } = await fontSession.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: '[data-font-probe]',
    });
    const { fonts } = await fontSession.send('CSS.getPlatformFontsForNode', {
        nodeId,
    });
    assert.ok(
        fonts.some(
            (font) => font.isCustomFont && font.familyName.includes('DM Sans')
        ),
        'DM Sans must actually render text'
    );
    assert.ok(
        fonts.some(
            (font) => font.isCustomFont && font.familyName.includes('Twemoji')
        ),
        'Twemoji must actually render emoji'
    );
    assert.ok(
        fonts.every((font) => font.isCustomFont),
        'The sample must not silently fall back to system text or emoji fonts'
    );
    await fontSession.detach();
    assert.equal(
        await fontRow.locator('.message-text').innerText(),
        fontSample
    );
    const fontUrls = await alice.page.evaluate(() =>
        [...document.querySelectorAll<HTMLLinkElement>('link[as="font"]')].map(
            (link) => link.href
        )
    );
    assert.equal(fontUrls.length, 3);
    assert.ok(fontUrls.every((url) => new URL(url).origin === config.origin));
    await fontRow.screenshot({ path: 'test-results/font-and-emoji.png' });
    console.log(
        'PASS: actual local DM Sans and Twemoji rendering, complex emoji, unchanged Unicode text and same-origin preloaded fonts'
    );

    await alice.page.locator('.dm-row').filter({ hasText: 'Bob' }).click();
    await message(alice.page, 'Only Bob can read this private message.');
    await bob.page.locator('.dm-row').filter({ hasText: 'Alice' }).click();
    await expect(
        bob.page.getByText('Only Bob can read this private message.', {
            exact: true,
        })
    ).toBeVisible();
    assert.equal(
        await charlie.page
            .getByText('Only Bob can read this private message.', {
                exact: true,
            })
            .count(),
        0
    );
    assert.equal(
        await charlie.page.evaluate(() =>
            window.__testTraffic.some((frame) =>
                frame.includes('Only Bob can read')
            )
        ),
        false
    );
    assert.equal(
        await alice.page.evaluate(() =>
            window.__testTraffic.some(
                (frame) =>
                    frame.includes('Only Bob can read') ||
                    frame.includes('A hello for everyone')
            )
        ),
        false
    );
    console.log(
        'PASS: three-person room chat, private DMs, ciphertext-only WebSocket traffic'
    );

    await alice.page
        .getByRole('button', { name: 'Settings', exact: true })
        .click();
    await alice.page
        .getByRole('button', { name: 'Verify your safety code' })
        .click();
    await bob.page
        .getByRole('button', { name: 'Settings', exact: true })
        .click();
    await bob.page
        .getByRole('button', { name: 'Verify your safety code' })
        .click();
    await expect(alice.page.locator('.safety-code span')).toHaveCount(8);
    await expect(bob.page.locator('.safety-code span')).toHaveCount(8);
    assert.equal(
        await alice.page.locator('.safety-code').textContent(),
        await bob.page.locator('.safety-code').textContent()
    );
    await alice.page.getByRole('button', { name: 'Close dialog' }).click();
    await bob.page.getByRole('button', { name: 'Close dialog' }).click();
    await bob.page.reload();
    await expect(
        bob.page.getByRole('heading', { name: 'The living room', exact: true })
    ).toBeVisible();
    await bob.page.locator('.dm-row').filter({ hasText: 'Alice' }).click();
    await expect(
        bob.page.getByText('Only Bob can read this private message.', {
            exact: true,
        })
    ).toBeVisible();
    console.log(
        'PASS: matching safety codes, browser key persistence, refresh restores history'
    );

    await checkAudioPreferences(alice.page);
    await alice.page.getByRole('button', { name: 'Record voice note' }).click();
    await expect(alice.page.locator('.recording-label')).toBeVisible();
    await checkEnhancedReady(alice.page, 1);
    await alice.page.waitForTimeout(1300);
    await alice.page
        .getByRole('button', { name: 'Finish', exact: true })
        .click();
    await expect(alice.page.locator('.voice-preview')).toBeVisible();
    await checkCaptureCleanup(alice.page);
    await alice.page
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
    await expect(bob.page.locator('.voice-note audio')).toHaveCount(1);
    await bob.page
        .locator('.voice-note audio')
        .evaluate(async (audio: HTMLAudioElement) => {
            await audio.play();
        });
    await expect
        .poll(() =>
            bob.page
                .locator('.voice-note audio')
                .evaluate((audio: HTMLAudioElement) => audio.readyState)
        )
        .toBeGreaterThanOrEqual(2);
    console.log(
        'PASS: record, encrypt, deliver, decrypt, and play a voice note'
    );

    for (const p of [alice, bob, charlie])
        await p.page
            .getByRole('button', { name: 'The living room', exact: true })
            .click();
    await bob.page.evaluate(() => {
        window.__testSyntheticMic = true;
    });
    await alice.page
        .getByRole('button', { name: 'Start video call', exact: true })
        .click();
    await expect(
        alice.page.getByRole('region', { name: 'Active call' })
    ).toBeVisible();
    await bob.page
        .getByRole('button', { name: 'Start voice call', exact: true })
        .click();
    await expect(
        bob.page.getByRole('region', { name: 'Active call' })
    ).toBeVisible();
    await charlie.page
        .getByRole('button', { name: 'Start voice call', exact: true })
        .click();
    for (const p of [alice, bob, charlie]) {
        await expect
            .poll(
                () =>
                    p.page.evaluate(
                        () =>
                            window.__testPeers.filter(
                                (pc) => pc.connectionState === 'connected'
                            ).length
                    ),
                { timeout: 25000 }
            )
            .toBe(2);
        await expect
            .poll(
                () =>
                    p.page.evaluate(async () => {
                        let bytes = 0;
                        for (const pc of window.__testPeers)
                            for (const report of (await pc.getStats()).values())
                                if (report.type === 'inbound-rtp')
                                    bytes += Number(report.bytesReceived || 0);
                        return bytes;
                    }),
                { timeout: 15000 }
            )
            .toBeGreaterThan(0);
    }
    await alice.page
        .getByRole('button', { name: 'Mute microphone', exact: true })
        .click();
    await expect(
        alice.page.getByRole('button', {
            name: 'Unmute microphone',
            exact: true,
        })
    ).toBeVisible();
    await alice.page
        .getByRole('button', { name: 'Turn camera off', exact: true })
        .click();
    await alice.page
        .getByRole('button', { name: 'Turn camera on', exact: true })
        .click();
    try {
        await expect(bob.page.locator('.video-tile video')).toHaveCount(1);
    } catch (error) {
        console.log(
            'CALL DIAGNOSTICS',
            await bob.page.evaluate(() => ({
                notice: document.querySelector('.toast')?.textContent,
                peers: window.__testPeers.map((pc) => ({
                    status: pc.connectionState,
                    tracks: pc.getTransceivers().map((t) => ({
                        mid: t.mid,
                        direction: t.currentDirection,
                        kind: t.receiver.track.kind,
                        state: t.receiver.track.readyState,
                        muted: t.receiver.track.muted,
                    })),
                })),
            }))
        );
        await bob.page.screenshot({ path: 'test-results/call-failure.png' });
        throw error;
    }
    await alice.page.screenshot({ path: 'test-results/desktop-call.png' });
    console.log(
        'PASS: three-person WebRTC mesh, actual inbound media packets, mute, and camera toggles'
    );

    await checkSpeaking(alice.page, bob.page);
    await checkParticipantVolume(alice.page, bob.page);
    await checkCallLayoutAndNoise(alice.page, bob.page);
    await checkScreenAudioAndPopout(alice.page, bob.page);
    for (const p of [alice, bob, charlie])
        await p.page
            .getByRole('button', { name: 'Leave', exact: true })
            .click();
    assert.equal(
        await alice.page.evaluate(() =>
            window.__testPeers.some((pc) => pc.connectionState !== 'closed')
        ),
        false
    );
    for (const p of [alice, bob, charlie]) await checkCaptureCleanup(p.page);
    console.log('PASS: screen-share start/stop, call teardown');

    const row = (page: Page, text: string) =>
        page
            .getByTestId('chat-message')
            .filter({ has: page.getByText(text, { exact: true }) });
    const originalText = 'A hello for everyone in this room.';
    await row(bob.page, originalText).click({ button: 'right' });
    await expect(
        bob.page.getByRole('menuitem', { name: 'Edit message', exact: true })
    ).toHaveCount(0);
    await expect(
        bob.page.getByRole('menuitem', { name: 'Delete message', exact: true })
    ).toHaveCount(0);
    await bob.page.keyboard.press('Escape');
    await row(alice.page, originalText).click({ button: 'right' });
    await alice.page
        .getByRole('menuitem', { name: 'Edit message', exact: true })
        .click();
    await alice.page
        .getByRole('textbox', { name: 'Edit message', exact: true })
        .fill('A room message, edited.');
    await alice.page.getByRole('button', { name: 'Save', exact: true }).click();
    for (const person of [alice, bob, charlie]) {
        await expect(row(person.page, 'A room message, edited.')).toBeVisible();
        await expect(row(person.page, originalText)).toHaveCount(0);
        await expect(row(person.page, 'A room message, edited.')).toContainText(
            'edited'
        );
    }
    await alice.page.locator('.composer textarea').fill(':smi');
    await expect(
        alice.page.getByRole('listbox', { name: 'Emoji suggestions' })
    ).toBeVisible();
    await alice.page.getByRole('option', { name: /:smile:$/ }).click();
    await expect(alice.page.locator('.composer textarea')).toHaveValue('😄 ');
    await alice.page
        .locator('.composer textarea')
        .fill('Hello :wave: :purple_heart: :not_an_emoji:');
    await alice.page.locator('.composer textarea').press('Enter');
    await expect(row(bob.page, 'Hello 👋 💜 :not_an_emoji:')).toBeVisible();
    await alice.page.locator('.composer textarea').press('ArrowUp');
    await expect(
        alice.page.getByRole('textbox', { name: 'Edit message', exact: true })
    ).toBeVisible();
    await alice.page
        .getByRole('textbox', { name: 'Edit message', exact: true })
        .press('Escape');
    await expect(alice.page.locator('.composer textarea')).toBeFocused();
    const composer = alice.page.locator('.composer textarea');
    const emojiButton = alice.page.getByRole('button', {
        name: 'Add emoji',
        exact: true,
    });
    const picker = alice.page.getByRole('dialog', {
        name: 'Emoji picker',
        exact: true,
    });
    await emojiButton.click();
    await expect(picker).toBeVisible();
    await alice.page.locator('.conversation-title').click();
    await expect(picker).toHaveCount(0);
    await emojiButton.click();
    await alice.page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect(composer).toBeFocused();
    await emojiButton.click();
    await emojiButton.click();
    await expect(picker).toHaveCount(0);
    await composer.fill('Hello there');
    await composer.evaluate((element: HTMLTextAreaElement) =>
        element.setSelectionRange(6, 11)
    );
    await emojiButton.click();
    await alice.page
        .getByRole('textbox', { name: 'Search emojis', exact: true })
        .fill('wave');
    await alice.page
        .getByRole('button', { name: 'Insert :wave:', exact: true })
        .click();
    await expect(composer).toHaveValue('Hello 👋');
    await expect(composer).toBeFocused();
    await composer.fill('');
    await emojiButton.click();
    await expect(picker.getByRole('status')).toHaveText('3,953 emoji');
    // Opening the full catalog should not mount thousands of buttons at once.
    await expect(picker.locator('.emoji-grid button')).toHaveCount(120);
    await picker.locator('.emoji-results').evaluate((element) => {
        element.scrollTop = element.scrollHeight;
    });
    await expect
        .poll(() => picker.locator('.emoji-grid button').count())
        .toBeGreaterThan(120);
    const allCategory = picker.getByRole('tab', {
        name: 'All emojis',
        exact: true,
    });
    await picker.getByRole('tab', { name: 'Flags', exact: true }).click();
    await expect(picker.getByRole('status')).toHaveText('270 emoji');
    await expect(picker.locator('.emoji-grid button')).toHaveCount(120);
    const search = picker.getByRole('textbox', { name: 'Search emojis' });
    await search.fill('Lebanon');
    await expect(allCategory).toHaveAttribute('aria-selected', 'true');
    await expect(picker.getByRole('status')).toHaveText('1 emoji');
    await search.press('ArrowDown');
    await expect(
        picker.getByRole('button', { name: 'Insert :lebanon:', exact: true })
    ).toBeFocused();
    await alice.page.keyboard.press('Enter');
    await expect(composer).toHaveValue('🇱🇧');
    await expect(composer).toBeFocused();
    await emojiButton.click();
    await search.fill(':wave_tone3:');
    await search.press('Enter');
    await expect(composer).toHaveValue('🇱🇧👋🏽');
    await expect(composer).toBeFocused();
    await emojiButton.click();
    await search.fill('distorted face');
    await picker
        .getByRole('button', { name: 'Insert :distorted_face:', exact: true })
        .click();
    await expect(composer).toHaveValue('🇱🇧👋🏽🫪');
    await expect(composer).toBeFocused();
    await composer.fill(':handshake_tone1-3');
    await alice.page
        .getByRole('option', { name: /:handshake_tone1-3:$/ })
        .click();
    await expect(composer).toHaveValue('🫱🏻‍🫲🏽 ');
    await expect(composer).toBeFocused();
    await composer.fill('');
    await emojiButton.click();
    await picker
        .getByRole('tab', { name: 'Animals & nature', exact: true })
        .click();
    await alice.page.keyboard.press('Home');
    await expect(allCategory).toBeFocused();
    await alice.page.keyboard.press('End');
    await expect(
        picker.getByRole('tab', { name: 'Flags', exact: true })
    ).toBeFocused();
    await alice.page.keyboard.press('ArrowRight');
    await expect(allCategory).toHaveAttribute('aria-selected', 'true');
    await picker
        .getByRole('tab', { name: 'Animals & nature', exact: true })
        .click();
    await picker.screenshot({ path: 'test-results/full-emoji-catalog.png' });
    await alice.page.keyboard.press('Escape');
    console.log(
        'PASS: full emoji catalog, categories, progressive scrolling, flag and skin-tone search, Unicode 17, complex shortcode autocomplete'
    );
    await alice.page
        .getByRole('button', { name: 'Search this conversation', exact: true })
        .click();
    await alice.page
        .getByRole('textbox', { name: 'Search messages', exact: true })
        .fill('no such message exists');
    await expect(
        alice.page.getByText('No messages match your search.')
    ).toBeVisible();
    await alice.page
        .getByRole('textbox', { name: 'Search messages', exact: true })
        .press('Escape');
    await expect(row(alice.page, 'A room message, edited.')).toBeVisible();
    await alice.page
        .getByRole('button', { name: 'Settings', exact: true })
        .click();
    await alice.page
        .getByRole('button', { name: 'Privacy & encryption', exact: true })
        .click();
    await expect(
        alice.page.getByRole('heading', { name: 'Private by design.' })
    ).toBeVisible();
    await alice.page.keyboard.press('Escape');
    await alice.page
        .getByRole('button', { name: 'Conversation actions', exact: true })
        .click();
    await alice.page
        .getByRole('menuitem', { name: 'Share room history', exact: true })
        .click();
    const rangeStart = row(alice.page, 'A room message, edited.');
    const rangeEnd = row(alice.page, 'Hello 👋 💜 :not_an_emoji:');
    await rangeStart.getByRole('checkbox').check();
    await rangeEnd.click({ modifiers: ['Shift'] });
    await expect(
        alice.page.getByRole('region', { name: 'Selected messages' })
    ).toContainText('3 selected');
    await expect(fontRow.getByRole('checkbox')).toBeChecked();
    await alice.page.keyboard.press('Escape');
    await expect(
        alice.page.getByRole('region', { name: 'Selected messages' })
    ).toHaveCount(0);
    await message(bob.page, 'A reply from Bob.');
    await alice.page
        .getByRole('button', { name: 'Conversation actions', exact: true })
        .click();
    await alice.page
        .getByRole('menuitem', { name: 'Share room history', exact: true })
        .click();
    await alice.page
        .getByRole('button', { name: 'Select mine', exact: true })
        .click();
    await expect(rangeStart.getByRole('checkbox')).toBeChecked();
    await expect(
        row(alice.page, 'A reply from Bob.').getByRole('checkbox')
    ).not.toBeChecked();
    await expect(fontRow.getByRole('checkbox')).not.toBeChecked();
    await expect(
        alice.page.getByRole('button', { name: 'Delete selected', exact: true })
    ).toBeEnabled();
    await alice.page.keyboard.press('Escape');
    console.log(
        'PASS: message actions, editing, emoji search/caret insertion/dismissal, search dismissal, privacy settings and range/own-message selection'
    );

    const fileContents =
        'Synthetic private file contents. Never plaintext on the relay.';
    await alice.page.getByLabel('Choose attachment').setInputFiles({
        name: 'notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from(fileContents),
    });
    await expect(alice.page.locator('.attachment-preview')).toContainText(
        'notes.txt'
    );
    await alice.page
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
    await expect(
        bob.page.getByRole('link', { name: 'Download notes.txt', exact: true })
    ).toBeVisible();
    const downloadEvent = bob.page.waitForEvent('download');
    await bob.page
        .getByRole('link', { name: 'Download notes.txt', exact: true })
        .click();
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), 'notes.txt');
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString(), fileContents);
    assert.equal(
        await alice.page.evaluate(() =>
            window.__testTraffic.some(
                (packet) =>
                    packet.includes('notes.txt') ||
                    packet.includes('Synthetic private file contents.')
            )
        ),
        false
    );
    await alice.page.getByLabel('Choose attachment').setInputFiles({
        name: 'too-big.dat',
        mimeType: 'application/octet-stream',
        buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
    });
    await expect(alice.page.locator('.toast')).toContainText('up to 5 MB');
    await expect(alice.page.locator('.attachment-preview')).toHaveCount(0);
    console.log(
        'PASS: encrypted file upload/download, filename privacy, file-size limit'
    );

    const dave = await participant('Dave');
    await expect(
        alice.page
            .locator('.presence-event')
            .filter({ hasText: 'Dave joined the room' })
    ).toBeVisible();
    await expect(dave.page.getByTestId('chat-message')).toHaveCount(0);
    await alice.page
        .getByRole('button', { name: 'Conversation actions', exact: true })
        .click();
    await alice.page
        .getByRole('menuitem', { name: 'Share room history', exact: true })
        .click();
    await row(alice.page, 'A room message, edited.')
        .getByRole('checkbox')
        .check();
    await alice.page
        .getByTestId('chat-message')
        .filter({ hasText: 'notes.txt' })
        .getByRole('checkbox')
        .check();
    await alice.page
        .getByRole('button', { name: 'Share selected', exact: true })
        .click();
    await alice.page
        .getByLabel('History recipient')
        .selectOption({ label: 'Dave' });
    await alice.page
        .getByRole('button', { name: 'Share encrypted history', exact: true })
        .click();
    await expect(alice.page.getByRole('dialog')).toHaveCount(0);
    await expect(row(dave.page, 'A room message, edited.')).toBeVisible();
    await expect(
        row(dave.page, 'A room message, edited.').locator('.author-name')
    ).toHaveText('Alice');
    await expect(row(dave.page, 'A room message, edited.')).toContainText(
        'History shared by Alice'
    );
    await expect(
        dave.page.getByRole('link', { name: 'Download notes.txt', exact: true })
    ).toBeVisible();
    assert.equal(
        await dave.page.evaluate(() =>
            window.__testTraffic.some((packet) =>
                packet.includes('Only Bob can read this private message.')
            )
        ),
        false
    );
    await dave.page.reload();
    await expect(row(dave.page, 'A room message, edited.')).toBeVisible();
    await expect(dave.page.getByTestId('chat-message')).toHaveCount(2);
    await row(alice.page, 'A room message, edited.').click({ button: 'right' });
    await alice.page
        .getByRole('menuitem', { name: 'Edit message', exact: true })
        .click();
    await alice.page
        .getByRole('textbox', { name: 'Edit message', exact: true })
        .fill('Updated for the new arrival too.');
    await alice.page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
        row(dave.page, 'Updated for the new arrival too.')
    ).toBeVisible();
    console.log(
        'PASS: join notices, explicit selected history sharing, signed original authorship, reload and edits for new recipients'
    );
    await checkFourPersonCall([alice.page, bob.page, charlie.page, dave.page]);

    // Take an existing reader offline to exercise authoritative history resync.
    await bob.context.setOffline(true);
    await bob.page.evaluate(() =>
        window.__testSockets.forEach((socket) => socket.close())
    );
    await expect(bob.page.locator('.connection-banner')).toBeVisible();
    const beforeDelete = app.stats().messages;
    await alice.page
        .getByRole('button', { name: 'Conversation actions', exact: true })
        .click();
    await alice.page
        .getByRole('menuitem', { name: 'Share room history', exact: true })
        .click();
    await row(alice.page, 'Updated for the new arrival too.')
        .getByRole('checkbox')
        .check();
    await alice.page
        .getByTestId('chat-message')
        .filter({ hasText: 'notes.txt' })
        .getByRole('checkbox')
        .check();
    await alice.page
        .getByRole('button', { name: 'Delete selected', exact: true })
        .click();
    await alice.page
        .getByRole('button', { name: 'Delete for everyone', exact: true })
        .click();
    await expect(alice.page.getByRole('dialog')).toHaveCount(0);
    await expect(dave.page.getByTestId('chat-message')).toHaveCount(0);
    assert.equal(app.stats().messages, beforeDelete - 2);
    await bob.context.setOffline(false);
    await expect(bob.page.locator('.connection-banner')).toHaveCount(0, {
        timeout: 20000,
    });
    await expect(row(bob.page, 'Updated for the new arrival too.')).toHaveCount(
        0
    );
    await expect(
        bob.page.getByRole('link', { name: 'Download notes.txt', exact: true })
    ).toHaveCount(0);
    await dave.page.reload();
    await expect(
        dave.page.getByRole('heading', { name: 'The living room', exact: true })
    ).toBeVisible();
    await expect(dave.page.getByTestId('chat-message')).toHaveCount(0);
    console.log(
        'PASS: batch deletion, shared-copy removal and no deleted-message resurrection after offline reconnect or reload'
    );

    const chatText = row(alice.page, 'Hello 👋 💜 :not_an_emoji:').locator(
        '.message-text'
    );
    assert.equal(
        await chatText.evaluate((node) => getComputedStyle(node).fontSize),
        '16px'
    );
    await alice.page
        .getByRole('button', { name: 'Switch to light mode', exact: true })
        .click();
    await expect(alice.page.locator('html')).toHaveAttribute(
        'data-theme',
        'light'
    );
    await alice.page.screenshot({ path: 'test-results/light-chat.png' });
    await alice.page
        .getByRole('button', { name: 'Settings', exact: true })
        .click();
    await alice.page
        .getByRole('dialog')
        .screenshot({ path: 'test-results/settings-light.png' });
    await alice.page.getByRole('radio', { name: 'Large', exact: true }).check();
    await alice.page.getByRole('button', { name: 'Done', exact: true }).click();
    await alice.page
        .getByRole('button', { name: 'Add emoji', exact: true })
        .click();
    await alice.page
        .getByRole('dialog', { name: 'Emoji picker', exact: true })
        .screenshot({ path: 'test-results/emoji-picker-light.png' });
    await alice.page.keyboard.press('Escape');
    await alice.page.locator('.composer textarea').click();
    await alice.page
        .locator('.composer')
        .screenshot({ path: 'test-results/composer-focused.png' });
    assert.equal(
        await chatText.evaluate((node) => getComputedStyle(node).fontSize),
        '18px'
    );
    await alice.page.reload();
    await expect(alice.page.locator('html')).toHaveAttribute(
        'data-theme',
        'light'
    );
    await expect(chatText).toBeVisible();
    assert.equal(
        await chatText.evaluate((node) => getComputedStyle(node).fontSize),
        '18px'
    );
    // 720 CSS pixels represents a 1440px window at 200% browser zoom.
    for (const viewport of [
        { width: 720, height: 475 },
        { width: 320, height: 640 },
    ]) {
        await alice.page.setViewportSize(viewport);
        assert.equal(
            await alice.page.evaluate(
                () => document.documentElement.scrollWidth > innerWidth
            ),
            false
        );
        await chatText.scrollIntoViewIfNeeded();
        await chatText.click({ button: 'right', position: { x: 5, y: 5 } });
        const box = await alice.page
            .getByRole('menu', { name: 'Message actions', exact: true })
            .boundingBox();
        assert.ok(
            box &&
                box.x >= 0 &&
                box.y >= 0 &&
                box.x + box.width <= viewport.width &&
                box.y + box.height <= viewport.height
        );
        await alice.page.keyboard.press('Escape');
        await expect(
            alice.page.getByRole('button', {
                name: 'Send message',
                exact: true,
            })
        ).toBeVisible();
        await alice.page
            .getByRole('button', { name: 'Add emoji', exact: true })
            .click();
        const emojiBox = await alice.page
            .getByRole('dialog', { name: 'Emoji picker', exact: true })
            .boundingBox();
        assert.ok(
            emojiBox &&
                emojiBox.x >= 0 &&
                emojiBox.y >= 0 &&
                emojiBox.x + emojiBox.width <= viewport.width &&
                emojiBox.y + emojiBox.height <= viewport.height
        );
        await alice.page.keyboard.press('Escape');
    }
    await alice.page.screenshot({
        path: 'test-results/light-mobile-large-text.png',
    });
    await alice.page
        .getByRole('button', { name: 'Switch to dark mode', exact: true })
        .click();
    await alice.page
        .getByRole('button', { name: 'Settings', exact: true })
        .click();
    await alice.page
        .getByRole('radio', { name: 'Comfortable', exact: true })
        .check();
    await alice.page.getByRole('button', { name: 'Done', exact: true }).click();
    await alice.page.setViewportSize({ width: 1440, height: 950 });
    await alice.page.screenshot({ path: 'test-results/dark-chat.png' });
    console.log(
        'PASS: light/dark themes, remembered text size, narrow/zoom-equivalent reflow and context-menu positioning'
    );

    await checkMarkdown(alice.page, bob.page);
    await checkClearChat(alice, bob, dave);

    await alice.page.setViewportSize({ width: 390, height: 844 });
    await expect(
        alice.page.getByRole('button', { name: 'Open navigation', exact: true })
    ).toBeVisible();
    await alice.page
        .getByRole('button', { name: 'Open navigation', exact: true })
        .click();
    await alice.page.locator('.dm-row').filter({ hasText: 'Bob' }).click();
    await expect(
        alice.page.getByRole('heading', { name: 'Bob', exact: true })
    ).toBeVisible();
    assert.equal(
        await alice.page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth
        ),
        false
    );
    await alice.page.screenshot({ path: 'test-results/mobile-chat.png' });
    await alice.page
        .getByRole('button', { name: 'Open navigation', exact: true })
        .click();
    await alice.page
        .getByRole('button', { name: 'Leave this space', exact: true })
        .click();
    const logout = alice.page.getByRole('dialog', {
        name: 'Log out of this space?',
        exact: true,
    });
    await expect(logout).toBeVisible();
    await expect(
        logout.getByRole('button', { name: 'Cancel', exact: true })
    ).toBeFocused();
    await logout.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(logout).toHaveCount(0);
    await expect(
        alice.page.getByRole('heading', { name: 'Bob', exact: true })
    ).toBeVisible();
    await alice.page
        .getByRole('button', { name: 'Leave this space', exact: true })
        .click();
    await alice.page.keyboard.press('Escape');
    await expect(logout).toHaveCount(0);
    await alice.page
        .getByRole('button', { name: 'Leave this space', exact: true })
        .click();
    await logout.getByRole('button', { name: 'Log out', exact: true }).click();
    await expect(
        alice.page.getByRole('button', {
            name: 'Enter your space',
            exact: true,
        })
    ).toBeVisible();
    assert.deepEqual(errors, []);
    console.log(
        'PASS: mobile navigation, no horizontal overflow, logout, no browser errors'
    );
} catch (error) {
    for (const context of browser.contexts())
        for (const page of context.pages()) {
            console.log(
                'BROWSER FAILURE',
                await page
                    .evaluate(() => ({
                        name: document.querySelector('.self-row strong')
                            ?.textContent,
                        notice: document.querySelector('.toast')?.textContent,
                        call: document
                            .querySelector('.call-panel')
                            ?.textContent?.slice(0, 160),
                        peers: window.__testPeers.map((peer) => ({
                            state: peer.connectionState,
                            signalling: peer.signalingState,
                        })),
                        contexts: window.__testAudioContexts.map(
                            (context) => context.state
                        ),
                    }))
                    .catch(() => ({}))
            );
        }
    console.log('Frontend errors', errors);
    throw error;
} finally {
    await browser.close();
    await app.close();
    await new Promise<void>((resolve) => ingress.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
}
