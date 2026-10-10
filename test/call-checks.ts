import assert from 'node:assert/strict';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import {
    checkSpeakingCleanup,
    speakingTile,
    voiceLevel,
} from './speaking-checks';

declare global {
    interface Window {
        __testAudioContexts: AudioContext[];
        __testWorklets: { node: AudioWorkletNode; ready: boolean }[];
        __testRawStreams: MediaStream[];
        __testToneStarts: number;
        __testScreenStream?: MediaStream;
        __testScreenContext?: AudioContext;
    }
}

export async function observeAudio(context: BrowserContext) {
    await context.addInitScript(() => {
        window.__testAudioContexts = [];
        window.__testWorklets = [];
        window.__testRawStreams = [];
        window.__testToneStarts = 0;
        const OriginalContext = window.AudioContext;
        window.AudioContext = class extends OriginalContext {
            constructor(options?: AudioContextOptions) {
                super(options);
                window.__testAudioContexts.push(this);
            }
        };
        const OriginalWorklet = window.AudioWorkletNode;
        window.AudioWorkletNode = class extends OriginalWorklet {
            constructor(
                context: BaseAudioContext,
                name: string,
                options?: AudioWorkletNodeOptions
            ) {
                super(context, name, options);
                const record = { node: this, ready: false };
                window.__testWorklets.push(record);
                this.port.addEventListener('message', (event) => {
                    if (event.data === 'ready') record.ready = true;
                });
                this.port.start();
            }
        };
        const getUserMedia = navigator.mediaDevices.getUserMedia;
        navigator.mediaDevices.getUserMedia = async function (constraints) {
            const stream = await getUserMedia.call(this, constraints);
            window.__testRawStreams.push(stream);
            return stream;
        };
        const start = OscillatorNode.prototype.start;
        OscillatorNode.prototype.start = function (when?: number) {
            window.__testToneStarts++;
            start.call(this, when);
        };
    });
}

export async function checkAudioPreferences(page: Page) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Audio', exact: true }).click();
    const before = await page.evaluate(() => window.__testToneStarts);
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect
        .poll(() => page.evaluate(() => window.__testToneStarts))
        .toBeGreaterThan(before);
    const sounds = page.getByLabel('Soft sounds for messages and calls');
    await sounds.uncheck();
    await expect(
        page.getByRole('button', { name: 'Preview', exact: true })
    ).toBeDisabled();
    await sounds.check();
    await page.getByRole('slider', { name: 'Sound effects volume' }).focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal(
        await page.evaluate(
            () => JSON.parse(localStorage.getItem('hush-audio')!).volume
        ),
        0.25
    );
    await page
        .getByRole('combobox', { name: 'Noise reduction' })
        .selectOption('enhanced');
    await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    console.log(
        'PASS: synthesized sound preview, mute, volume, and saved microphone preference'
    );
}

export async function checkEnhancedReady(page: Page, count: number) {
    await expect
        .poll(
            () =>
                page.evaluate(
                    () =>
                        window.__testWorklets.filter((record) => record.ready)
                            .length
                ),
            { timeout: 12000 }
        )
        .toBe(count);
}

async function fitsPanel(page: Page) {
    const geometry = await page.locator('.call-panel').evaluate((panel) => {
        const bounds = panel.getBoundingClientRect();
        const controls = panel
            .querySelector('.call-controls')!
            .getBoundingClientRect();
        const heading = panel
            .querySelector('.call-heading')!
            .getBoundingClientRect();
        const stage = panel
            .querySelector('.call-stage')!
            .getBoundingClientRect();
        const tiles = [...panel.querySelectorAll('.video-tile, .screen-tile')]
            .filter((tile) => getComputedStyle(tile).display !== 'none')
            .map((tile) => tile.getBoundingClientRect());
        return {
            overflow: panel.scrollHeight - panel.clientHeight,
            horizontal: document.documentElement.scrollWidth - innerWidth,
            controlsVisible:
                controls.bottom <= bounds.bottom &&
                controls.top >= heading.bottom,
            tilesFit: tiles.every(
                (tile) =>
                    tile.top >= stage.top - 1 && tile.bottom <= stage.bottom + 1
            ),
        };
    });
    assert.ok(
        geometry.overflow <= 1,
        `Call overflows: ${JSON.stringify(geometry)}`
    );
    assert.ok(geometry.horizontal <= 1, 'Call causes page overflow');
    assert.ok(geometry.controlsVisible, 'Call controls stay inside the panel');
    assert.ok(geometry.tilesFit, `Call tiles fit: ${JSON.stringify(geometry)}`);
}

export async function checkCallLayoutAndNoise(alice: Page, bob: Page) {
    await checkEnhancedReady(alice, 2);
    for (const size of [
        { width: 1920, height: 902 },
        { width: 720, height: 475 },
        { width: 390, height: 844 },
        { width: 1440, height: 950 },
    ]) {
        await alice.setViewportSize(size);
        await expect
            .poll(async () => {
                try {
                    await fitsPanel(alice);
                    return true;
                } catch {
                    return false;
                }
            })
            .toBe(true);
    }
    const divider = alice.getByRole('separator', { name: 'Resize call panel' });
    const initial = Number(await divider.getAttribute('aria-valuenow'));
    await divider.focus();
    await divider.press('ArrowDown');
    await expect(divider).toHaveAttribute(
        'aria-valuenow',
        String(initial + 24)
    );
    const handle = (await divider.boundingBox())!;
    await alice.mouse.move(
        handle.x + handle.width / 2,
        handle.y + handle.height / 2
    );
    await alice.mouse.down();
    await alice.mouse.move(
        handle.x + handle.width / 2,
        handle.y + handle.height / 2 + 50,
        { steps: 5 }
    );
    await alice.mouse.up();
    await expect(divider).toHaveAttribute(
        'aria-valuenow',
        String(initial + 74)
    );
    await fitsPanel(alice);
    await alice
        .getByRole('button', { name: 'Expand call', exact: true })
        .click();
    await expect(
        alice.getByRole('dialog', { name: 'Active call', exact: true })
    ).toBeVisible();
    const expanded = (await alice.locator('.call-panel').boundingBox())!;
    assert.equal(expanded.height, 950);
    assert.equal(expanded.width, 1440);
    await fitsPanel(alice);
    await alice.screenshot({ path: 'test-results/expanded-call.png' });
    await alice.keyboard.press('Escape');
    await expect(divider).toBeVisible();
    await alice
        .getByRole('button', { name: 'Audio settings', exact: true })
        .click();
    const modes = alice.getByRole('combobox', { name: 'Noise reduction' });
    for (const mode of ['off', 'browser', 'enhanced']) {
        await modes.selectOption(mode);
        await expect(
            alice.getByText('Changing microphone processing…')
        ).toHaveCount(0);
        await expect(
            alice.getByRole('button', {
                name: 'Unmute microphone',
                exact: true,
            })
        ).toBeVisible();
        assert.equal(
            await alice.evaluate(() =>
                window.__testPeers
                    .filter((pc) => pc.connectionState === 'connected')
                    .every((pc) =>
                        pc
                            .getSenders()
                            .filter((sender) => sender.track?.kind === 'audio')
                            .every((sender) => !sender.track!.enabled)
                    )
            ),
            true
        );
    }
    await checkEnhancedReady(alice, 3);
    await expect(
        alice.getByText('Using browser noise reduction for this call.')
    ).toHaveCount(0);
    await alice.screenshot({ path: 'test-results/audio-settings.png' });
    await alice.getByRole('button', { name: 'Close audio settings' }).click();
    // A failed model fetch must preserve the microphone and the peer connection.
    await bob.route('**/*gtcrn*.wasm', (route) =>
        route.fulfill({ status: 503, body: '' })
    );
    await bob
        .getByRole('button', { name: 'Audio settings', exact: true })
        .click();
    await bob
        .getByRole('combobox', { name: 'Noise reduction' })
        .selectOption('enhanced');
    await expect(
        bob.getByText('Using browser noise reduction for this call.')
    ).toBeVisible();
    assert.equal(
        await bob.evaluate(() =>
            window.__testPeers
                .filter((pc) => pc.connectionState === 'connected')
                .every((pc) =>
                    pc
                        .getSenders()
                        .some(
                            (sender) =>
                                sender.track?.kind === 'audio' &&
                                sender.track.enabled &&
                                sender.track.readyState === 'live'
                        )
                )
        ),
        true
    );
    await bob
        .getByRole('combobox', { name: 'Noise reduction' })
        .selectOption('browser');
    await bob.getByRole('button', { name: 'Close audio settings' }).click();
    await bob.unroute('**/*gtcrn*.wasm');
    await alice
        .getByRole('button', { name: 'Unmute microphone', exact: true })
        .click();
    console.log(
        'PASS: bounded/resizable/expanded lounge; live neural processing, muted mode changes, model-failure fallback'
    );
}

export async function checkScreenAudioAndPopout(alice: Page, bob: Page) {
    // Headless capture has no system audio. Supply a synthetic track to exercise
    // the same controls used when a browser offers tab/system sound.
    await alice.evaluate(() => {
        const original = navigator.mediaDevices.getDisplayMedia;
        navigator.mediaDevices.getDisplayMedia = async function (options) {
            const stream = await original.call(this, options);
            if (options?.audio) {
                stream.getAudioTracks().forEach((track) => {
                    stream.removeTrack(track);
                    track.stop();
                });
                const context = new AudioContext();
                const destination = context.createMediaStreamDestination();
                const oscillator = context.createOscillator();
                oscillator.connect(destination);
                oscillator.start();
                await context.resume();
                stream.addTrack(destination.stream.getAudioTracks()[0]);
                window.__testScreenContext = context;
            }
            window.__testScreenStream = stream;
            return stream;
        };
    });
    await alice
        .getByRole('button', { name: 'Share screen', exact: true })
        .click();
    const mute = alice.getByRole('button', {
        name: 'Mute screen-share audio',
        exact: true,
    });
    await expect(mute).toBeVisible({ timeout: 15000 });
    await expect(bob.locator('.screen-tile video')).toHaveCount(1);
    await fitsPanel(alice);
    const aliceId = await alice.evaluate(
        () =>
            JSON.parse(
                window.__testTraffic.find(
                    (packet) => JSON.parse(packet).type === 'join'
                )!
            ).id as string
    );
    const aliceAudio = bob.locator(`[data-peer-audio="${aliceId}"] audio`);
    await expect(aliceAudio).toHaveCount(2);
    await bob
        .locator('.call-panel')
        .getByRole('button', { name: 'Volume for Alice', exact: true })
        .click();
    await bob
        .getByRole('slider', { name: 'Alice volume', exact: true })
        .fill('45');
    await expect
        .poll(() =>
            aliceAudio.evaluateAll((nodes) =>
                nodes.every(
                    (node) => (node as HTMLAudioElement).volume === 0.45
                )
            )
        )
        .toBe(true);
    await bob
        .locator('.volume-popover:popover-open')
        .getByRole('button', { name: 'Reset', exact: true })
        .click();
    await bob.keyboard.press('Escape');
    await mute.click();
    assert.equal(
        await alice.evaluate(
            () => window.__testScreenStream!.getAudioTracks()[0].enabled
        ),
        false
    );
    await alice
        .getByRole('button', { name: 'Unmute screen-share audio', exact: true })
        .click();
    assert.equal(
        await alice.evaluate(
            () => window.__testScreenStream!.getAudioTracks()[0].enabled
        ),
        true
    );
    await alice
        .getByRole('button', { name: 'Stop sharing', exact: true })
        .click();
    await expect(bob.locator('.screen-tile video')).toHaveCount(0);
    assert.equal(
        await alice.evaluate(() =>
            window
                .__testScreenStream!.getTracks()
                .every((track) => track.readyState === 'ended')
        ),
        true
    );
    await alice.evaluate(() => window.__testScreenContext!.close());

    const peersBefore = await alice.evaluate(() => window.__testPeers.length);
    const socketsBefore = await alice.evaluate(
        () => window.__testSockets.length
    );
    const popupEvent = alice.waitForEvent('popup');
    await alice
        .getByRole('button', { name: 'Pop out call', exact: true })
        .click();
    const popup = await popupEvent;
    const popupErrors: string[] = [];
    popup.on('pageerror', (error) => popupErrors.push(error.message));
    await expect(
        popup.getByRole('region', { name: 'Active call' })
    ).toBeVisible();
    await voiceLevel(bob, 0.12);
    await expect(speakingTile(popup, 'Bob')).toHaveAttribute(
        'data-speaking',
        'true'
    );
    await voiceLevel(bob, 0);
    await expect(speakingTile(popup, 'Bob')).toHaveAttribute(
        'data-speaking',
        'false'
    );
    await expect(
        alice.getByText('Your call is in another window', { exact: true })
    ).toBeVisible();
    await fitsPanel(popup);
    await (await import('./qol-checks')).checkPopoutVolume(popup, alice);
    await popup
        .getByRole('button', { name: 'Mute microphone', exact: true })
        .click();
    await expect(
        popup.getByRole('button', { name: 'Unmute microphone', exact: true })
    ).toBeVisible();
    await popup
        .getByRole('button', { name: 'Unmute microphone', exact: true })
        .click();
    await popup
        .getByRole('button', { name: 'Share screen', exact: true })
        .click();
    await expect(
        popup.getByRole('button', { name: 'Stop sharing', exact: true })
    ).toBeVisible({ timeout: 15000 });
    await expect(bob.locator('.screen-tile video')).toHaveCount(1);
    await fitsPanel(popup);
    await popup.screenshot({ path: 'test-results/call-popout.png' });
    await popup
        .getByRole('button', { name: 'Stop sharing', exact: true })
        .click();
    await popup.close();
    await expect(
        alice.getByRole('region', { name: 'Active call' })
    ).toBeVisible();
    assert.equal(
        await alice.evaluate(() => window.__testPeers.length),
        peersBefore
    );
    assert.equal(
        await alice.evaluate(() => window.__testSockets.length),
        socketsBefore
    );
    assert.equal(
        await alice.evaluate(
            () =>
                window.__testPeers.filter(
                    (pc) => pc.connectionState === 'connected'
                ).length
        ),
        2
    );
    assert.deepEqual(popupErrors, []);
    console.log(
        'PASS: screen-audio mute/unmute/track cleanup; pop-out capture and closing preserve the same call'
    );
}

export async function checkCaptureCleanup(page: Page) {
    await checkSpeakingCleanup(page);
    assert.equal(
        await page.evaluate(() =>
            window.__testRawStreams.every((stream) =>
                stream
                    .getTracks()
                    .every((track) => track.readyState === 'ended')
            )
        ),
        true
    );
    await expect
        .poll(() =>
            page.evaluate(() =>
                window.__testWorklets.every(
                    (record) => record.node.context.state === 'closed'
                )
            )
        )
        .toBe(true);
}

export async function checkFourPersonCall(pages: Page[]) {
    for (const page of pages) {
        await page
            .getByRole('button', { name: 'Start voice call', exact: true })
            .click();
        await expect(
            page.getByRole('region', { name: 'Active call' })
        ).toBeVisible();
    }
    const page = pages[0];
    await expect(page.locator('.video-tile')).toHaveCount(4);
    await expect
        .poll(
            () =>
                page.evaluate(
                    () =>
                        window.__testPeers.filter(
                            (pc) => pc.connectionState === 'connected'
                        ).length
                ),
            { timeout: 15000 }
        )
        .toBe(3);
    for (const viewport of [
        { width: 720, height: 475 },
        { width: 320, height: 640 },
    ]) {
        await page.setViewportSize(viewport);
        await page
            .getByRole('separator', { name: 'Resize call panel' })
            .press('Home');
        await fitsPanel(page);
    }
    await page.screenshot({ path: 'test-results/four-person-small-call.png' });
    await page.setViewportSize({ width: 1440, height: 950 });
    // Leaving from the detached window should close it and release capture.
    const popupEvent = page.waitForEvent('popup');
    await page
        .getByRole('button', { name: 'Pop out call', exact: true })
        .click();
    const popup = await popupEvent;
    await popup.getByRole('button', { name: 'Leave', exact: true }).click();
    await expect.poll(() => popup.isClosed()).toBe(true);
    await expect(page.locator('.call-panel')).toHaveCount(0);
    for (const remaining of pages.slice(1))
        await remaining
            .getByRole('button', { name: 'Leave', exact: true })
            .click();
    for (const member of pages) await checkCaptureCleanup(member);
    console.log(
        'PASS: four-person mesh at minimum panel height/mobile sizes; leaving from pop-out ends capture'
    );
}
