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
    const turnUrls = (env.TURN_URLS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const stunUrls = (env.STUN_URLS ?? 'stun:stun.l.google.com:19302')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (
        turnUrls.some((s) => !/^turns?:[^\s]+$/.test(s)) ||
        stunUrls.some((s) => !/^stuns?:[^\s]+$/.test(s))
    )
        throw new Error('Invalid ICE server URL.');
    if (turnUrls.length && !env.TURN_SECRET)
        throw new Error('TURN_SECRET is required when TURN_URLS is set.');
    if (env.RELAY_ONLY === 'true' && !turnUrls.length)
        throw new Error('RELAY_ONLY requires a configured TURN relay.');
    return {
        password,
        origin: url.origin,
        host: url.host,
        port: integer('PORT', 5173, 1, 65535),
        maxClients: integer('MAX_CLIENTS', 4, 2, 8),
        maxHistoryBytes: integer('MAX_HISTORY_MB', 64, 1, 512) * 1024 * 1024,
        turnUrls,
        stunUrls,
        turnSecret: env.TURN_SECRET || '',
        relayOnly: env.RELAY_ONLY === 'true',
    };
}
export type Config = ReturnType<typeof readConfig>;
