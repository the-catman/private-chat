import { readConfig } from './config.ts';
import { createChatServer } from './app.ts';

try {
    const config = readConfig();
    const development = process.argv.includes('--dev');
    const frontend = development
        ? await (await import('./frontend.ts')).createDevFrontend(config)
        : undefined;
    const app = createChatServer(config, { frontend });
    app.server.on('error', (error) => {
        console.error(
            (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
                ? `Port ${config.port} is already in use.`
                : 'Unable to start the server.'
        );
        process.exit(1);
    });
    app.server.listen(config.port, '127.0.0.1', () => {
        console.log(
            `Hush is ready at ${config.origin} (Caddy → 127.0.0.1:${config.port}).`
        );
        if (development)
            console.log(
                'Vite is watching frontend changes. Restart for backend or .env changes.'
            );
        console.log(
            'Messages stay in application memory until shutdown. No message files, database, or message logs.'
        );
    });
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM'])
        process.on(signal, async () => {
            if (stopping) return;
            stopping = true;
            const force = setTimeout(() => process.exit(0), 3000);
            force.unref();
            await app.close();
            process.exit(0);
        });
} catch (error) {
    console.error(
        error instanceof Error ? error.message : 'Unable to start Hush.'
    );
    process.exitCode = 1;
}
