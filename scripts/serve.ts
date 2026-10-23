// Usage: node --import=tsx scripts/serve.ts <command...>
// Runs Caddy with the repo's Caddyfile beside the app command. Ctrl+C stops
// both, and either one exiting stops the other. Backend restarts under
// `tsx watch` happen inside the app command, so Caddy keeps running.
import { spawn, type ChildProcess } from 'node:child_process';

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Pass the app command to run.');
const children: ChildProcess[] = [];
let stopping = false;

function stop(code: number) {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    for (const child of children)
        if (child.exitCode === null && child.signalCode === null)
            child.kill('SIGTERM');
}

function run(file: string, argv: string[], failed: (code: number) => void) {
    const child = spawn(file, argv, {
        stdio: [file === 'caddy' ? 'ignore' : 'inherit', 'inherit', 'inherit'],
    });
    child.on('error', (error) => {
        console.error(
            (error as NodeJS.ErrnoException).code === 'ENOENT'
                ? `${file} is not installed.`
                : `Unable to start ${file}.`
        );
        stop(1);
    });
    child.on('exit', (code) => {
        if (!stopping) failed(code ?? 1);
        stop(code ?? 1);
    });
    children.push(child);
}

run(
    'caddy',
    [
        'run',
        '--adapter',
        'caddyfile',
        '--config',
        'Caddyfile',
        '--envfile',
        '.env',
    ],
    () =>
        console.error(
            'Caddy stopped. If it could not use ports 80 and 443, run:\n' +
                '  sudo setcap cap_net_bind_service=+ep "$(command -v caddy)"\n' +
                'and make sure no other Caddy (such as the system service) is running.'
        )
);
run(command, args, () => {});

for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => stop(0));
