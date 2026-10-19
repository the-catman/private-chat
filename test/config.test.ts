import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readConfig } from '../server/config';

const password = 'synthetic-password-for-config-tests';

test('configuration requires an explicit HTTPS origin', () => {
    for (const origin of [undefined, '', '   '])
        assert.throws(
            () => readConfig({ APP_PASSWORD: password, APP_ORIGIN: origin }),
            /Set APP_ORIGIN/
        );

    const config = readConfig({
        APP_PASSWORD: password,
        APP_ORIGIN: 'https://chat.example.com',
    });
    assert.equal(config.origin, 'https://chat.example.com');
    assert.equal(config.host, 'chat.example.com');
    assert.equal(config.port, 5173);
});

test('configuration rejects origins with HTTP, credentials, paths or queries', () => {
    for (const origin of [
        'http://chat.example.com',
        'https://user:synthetic-password@chat.example.com',
        'https://chat.example.com/chat',
        'https://chat.example.com/?token=synthetic',
        'https://chat.example.com/#fragment',
    ])
        assert.throws(
            () => readConfig({ APP_PASSWORD: password, APP_ORIGIN: origin }),
            /APP_ORIGIN must be an HTTPS origin without a path/
        );
});

test('media settings default to every interface and reject invalid addresses', () => {
    const base = {
        APP_PASSWORD: password,
        APP_ORIGIN: 'https://chat.example.com',
    };
    const config = readConfig(base);
    assert.equal(config.mediaPort, 44444);
    assert.equal(config.mediaListenIp, '0.0.0.0');
    assert.equal(config.mediaAddress, '');
    assert.equal(
        readConfig({ ...base, MEDIA_ANNOUNCED_ADDRESS: 'media.example.com' })
            .mediaAddress,
        'media.example.com'
    );
    for (const env of [
        { MEDIA_LISTEN_IP: 'everywhere' },
        { MEDIA_ANNOUNCED_ADDRESS: 'https://media.example.com' },
        { MEDIA_PORT: '70000' },
    ])
        assert.throws(() => readConfig({ ...base, ...env }), /Invalid MEDIA/);
});
