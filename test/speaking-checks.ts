import assert from 'node:assert/strict';
import { expect, type BrowserContext, type Page } from '@playwright/test';

declare global {
    interface Window {
        __testAnalysers: AnalyserNode[];
        __testAudioSources: MediaStreamAudioSourceNode[];
        __testSyntheticMic?: boolean;
        __testVoice?: {
            context: AudioContext;
            gain: GainNode;
            oscillator: OscillatorNode;
        };
    }
}

export async function observeSpeaking(context: BrowserContext) {
    await context.addInitScript(() => {
        window.__testAnalysers = [];
        window.__testAudioSources = [];
        const analyse = AudioContext.prototype.createAnalyser;
        AudioContext.prototype.createAnalyser = function () {
            const node = analyse.call(this);
            window.__testAnalysers.push(node);
            return node;
        };
        const source = AudioContext.prototype.createMediaStreamSource;
        AudioContext.prototype.createMediaStreamSource = function (stream) {
            const node = source.call(this, stream);
            window.__testAudioSources.push(node);
            return node;
        };
        const capture = navigator.mediaDevices.getUserMedia;
        navigator.mediaDevices.getUserMedia = async function (constraints) {
            const stream = await capture.call(this, constraints);
            if (constraints?.audio && window.__testSyntheticMic) {
                const context = new AudioContext();
                const oscillator = context.createOscillator();
                const gain = context.createGain();
                const destination = context.createMediaStreamDestination();
                oscillator.type = 'sawtooth';
                oscillator.frequency.value = 220;
                gain.gain.value = 0;
                oscillator.connect(gain).connect(destination);
                oscillator.start();
                await context.resume();
                for (const track of stream.getAudioTracks()) {
                    track.stop();
                    stream.removeTrack(track);
                }
                const track = destination.stream.getAudioTracks()[0];
                // Synthetic Web Audio tracks cannot accept device constraints.
                // There is no hardware or browser noise filter to configure here.
                track.applyConstraints = async () => {};
                stream.addTrack(track);
                window.__testVoice = { context, gain, oscillator };
            }
            return stream;
        };
    });
}

export const speakingTile = (page: Page, name: string) =>
    page
        .locator('.video-tile')
        .filter({ has: page.locator('.video-name').filter({ hasText: name }) });

export async function voiceLevel(page: Page, value: number) {
    await page.evaluate((level) => {
        window.__testVoice!.gain.gain.setValueAtTime(
            level,
            window.__testVoice!.context.currentTime
        );
    }, value);
}

export async function checkSpeaking(alice: Page, bob: Page) {
    const local = speakingTile(bob, 'Bob');
    const remote = speakingTile(alice, 'Bob');
    await expect(local).toHaveAttribute('data-speaking', 'false');
    await expect(remote).toHaveAttribute('data-speaking', 'false');
    await voiceLevel(bob, 0.16);
    for (const tile of [local, remote]) {
        await expect(tile).toHaveAttribute('data-speaking', 'true');
        await expect(tile.locator('.speaking-indicator')).toBeVisible();
        await expect(tile.locator('.voice-wave')).toHaveAttribute('d', /^M/);
    }
    const firstWave = await local.locator('.voice-wave').getAttribute('d');
    await bob.evaluate(() =>
        window.__testVoice!.oscillator.frequency.setValueAtTime(
            1600,
            window.__testVoice!.context.currentTime
        )
    );
    await expect
        .poll(() => local.locator('.voice-wave').getAttribute('d'))
        .not.toBe(firstWave);
    // The local analyser follows the actual processed sender track, not the raw
    // microphone input to the neural filter.
    assert.equal(
        await alice.evaluate(() => {
            const mic = window.__testPeers
                .find((pc) => pc.connectionState === 'connected')!
                .getSenders()[0].track;
            return window.__testAudioSources.some(
                (source) =>
                    source.context.state === 'running' &&
                    source.mediaStream.getAudioTracks()[0] === mic
            );
        }),
        true
    );
    await alice.screenshot({ path: 'test-results/speaking-call.png' });
    await bob
        .getByRole('button', { name: 'Mute microphone', exact: true })
        .click();
    for (const tile of [local, remote])
        await expect(tile).toHaveAttribute('data-speaking', 'false');
    await bob
        .getByRole('button', { name: 'Unmute microphone', exact: true })
        .click();
    for (const tile of [local, remote])
        await expect(tile).toHaveAttribute('data-speaking', 'true');
    await bob.getByRole('button', { name: 'Deafen', exact: true }).click();
    for (const tile of [local, remote])
        await expect(tile).toHaveAttribute('data-speaking', 'false');
    await bob.getByRole('button', { name: 'Undeafen', exact: true }).click();
    await expect(remote).toHaveAttribute('data-speaking', 'true');
    await bob
        .getByRole('button', { name: 'Turn camera on', exact: true })
        .click();
    await expect(remote.locator('video')).toBeVisible();
    await expect(remote.locator('.speaking-indicator')).toBeVisible();
    await bob
        .getByRole('button', { name: 'Turn camera off', exact: true })
        .click();
    await expect(remote.locator('.voice-ring')).toBeVisible();
    await alice.emulateMedia({ reducedMotion: 'reduce' });
    await expect(remote).toHaveAttribute('data-speaking', 'true');
    await expect(remote.locator('.voice-wave')).toBeHidden();
    await expect(remote.locator('.voice-halo')).toBeVisible();
    await alice.emulateMedia({ reducedMotion: 'no-preference' });
    await voiceLevel(bob, 0);
    for (const tile of [local, remote])
        await expect(tile).toHaveAttribute('data-speaking', 'false');
    assert.equal(
        await alice.locator('.avatar:visible').evaluateAll((avatars) =>
            avatars.every((avatar) => {
                const size = avatar.getBoundingClientRect();
                return (
                    getComputedStyle(avatar).borderTopLeftRadius === '50%' &&
                    Math.abs(size.width - size.height) < 1
                );
            })
        ),
        true
    );
    console.log(
        'PASS: real local/remote audio-reactive rings, silence/mute/deafen, camera indicators, processed microphone and reduced motion'
    );
}

export async function checkSpeakingCleanup(page: Page) {
    await expect
        .poll(() =>
            page.evaluate(() =>
                window.__testAnalysers.every(
                    (analyser) => analyser.context.state === 'closed'
                )
            )
        )
        .toBe(true);
    await page.evaluate(async () => {
        if (!window.__testVoice) return;
        await window.__testVoice.context.close();
        window.__testVoice = undefined;
    });
}
