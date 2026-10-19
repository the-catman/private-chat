import { isIP } from 'node:net';

export function readConfig(
    env: Record<string, string | undefined> = process.env
) {
    const password = env.APP_PASSWORD || '';
    if (
        password.length < 16 ||
        password === 'replace-with-a-long-unique-password'
    )
        throw new Error(
            'Set APP_PASSWORD in .env to a unique password of at least 16 characters.'
        );
    const origin = env.APP_ORIGIN?.trim();
    if (!origin)
        throw new Error('Set APP_ORIGIN in .env to your HTTPS address.');
    const url = new URL(origin);
    if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
    )
        throw new Error('APP_ORIGIN must be an HTTPS origin without a path.');
    const integer = (
        name: string,
        fallback: number,
        min: number,
        max: number
    ) => {
        const value = Number(env[name] || fallback);
        if (!Number.isInteger(value) || value < min || value > max)
            throw new Error(`Invalid ${name}.`);
        return value;
    };
    const mediaListenIp = env.MEDIA_LISTEN_IP?.trim() || '0.0.0.0';
    const mediaAddress = env.MEDIA_ANNOUNCED_ADDRESS?.trim() || '';
    if (
        !isIP(mediaListenIp) ||
        (mediaAddress &&
            !isIP(mediaAddress) &&
            !/^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(mediaAddress))
    )
        throw new Error('Invalid MEDIA_LISTEN_IP or MEDIA_ANNOUNCED_ADDRESS.');
    return {
        password,
        origin: url.origin,
        host: url.host,
        port: integer('PORT', 5173, 1, 65535),
        maxClients: integer('MAX_CLIENTS', 4, 2, 8),
        maxHistoryBytes: integer('MAX_HISTORY_MB', 512, 1, 8192) * 1024 * 1024,
        // Browsers send call media here directly, over UDP or TCP.
        mediaPort: integer('MEDIA_PORT', 44444, 0, 65535),
        mediaListenIp,
        mediaAddress,
    };
}
export type Config = ReturnType<typeof readConfig>;
