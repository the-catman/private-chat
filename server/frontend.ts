import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { RequestHandler } from 'express';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config';

export type Frontend = {
    allows: (pathname: string) => boolean;
    middleware: RequestHandler;
    upgradePath: string;
    upgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
    close: () => Promise<void>;
};

export async function createDevFrontend(
    config: Config,
    root = resolve('.')
): Promise<Frontend> {
    const { createServer: createViteServer } = await import('vite');
    // This server never listens. Express forwards only origin-checked
    // development WebSockets here; Vite doesn't open a second public port.
    // The browser reaches it at whichever address it opened.
    const updates = createServer();
    const upgradePath = '/__vite_hmr';
    const origin = new URL(config.origin);
    const viteEnv = fileURLToPath(
        new URL('../client/env.mjs', import.meta.resolve('vite'))
    ).replaceAll('\\', '/');
    const viteEnvPath = '/@fs/' + viteEnv.replace(/^\//, '');
    const vite = await createViteServer({
        root,
        configFile: false,
        appType: 'custom',
        publicDir: false,
        envFile: false,
        cacheDir: resolve(root, '.vite'),
        logLevel: 'warn',
        optimizeDeps: {
            include: [
                'react',
                'react-dom/client',
                'react/jsx-dev-runtime',
                'react-markdown',
                'remark-gfm',
                '@codemirror/commands',
                '@codemirror/lang-markdown',
                '@codemirror/language',
                '@codemirror/state',
                '@codemirror/view',
                'pdfjs-dist',
                'pdfjs-dist/build/pdf.worker.mjs',
            ],
        },
        server: {
            middlewareMode: true,
            host: '127.0.0.1',
            cors: false,
            allowedHosts: [origin.hostname],
            hmr: {
                server: updates,
                path: upgradePath,
            },
            fs: {
                strict: true,
                allow: [
                    resolve(root, 'src'),
                    resolve(root, 'node_modules'),
                    resolve(root, '.vite'),
                    viteEnv,
                ],
                deny: [
                    '.env',
                    '.env.*',
                    '**/.git/**',
                    '*.{pem,key,crt,p12}',
                    '**/server/**',
                    '**/test/**',
                ],
            },
        },
    });
    // Vite uses a root-relative URL when its runtime is inside this project,
    // and /@fs/ when it is outside (for example, in an isolated test root).
    // Permit this one runtime module, not arbitrary files in node_modules.
    const publicEnvPath = viteEnv.startsWith(`${vite.config.root}/`)
        ? viteEnv.slice(vite.config.root.length)
        : viteEnvPath;
    const allows = (path: string) =>
        path === '/' ||
        path === '/@vite/client' ||
        path === '/@vite/env' ||
        path === viteEnvPath ||
        path === publicEnvPath ||
        path === '/src/assets/audio/gtcrn-worklet.js' ||
        path === '/src/assets/audio/gtcrn.wasm' ||
        /^\/src\/assets\/fonts\/[a-z0-9-]+\.woff2$/.test(path) ||
        /^\/src\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(tsx?|css)$/.test(
            path
        ) ||
        /^\/\.vite\/deps\/@?[a-zA-Z0-9_.-]+\.js(?:\.map)?$/.test(path);
    return {
        allows,
        upgradePath,
        upgrade(request, socket, head) {
            if (
                !['vite-hmr', 'vite-ping'].includes(
                    String(request.headers['sec-websocket-protocol'])
                )
            ) {
                socket.destroy();
                return;
            }
            updates.emit('upgrade', request, socket, head);
        },
        middleware: async (request, response, next) => {
            const path = new URL(request.url, config.origin).pathname;
            if (!allows(path)) {
                response.status(404).end();
                return;
            }
            if (path === '/') {
                try {
                    const html = await readFile(
                        resolve(root, 'index.html'),
                        'utf8'
                    );
                    response
                        .type('html')
                        .send(await vite.transformIndexHtml('/', html));
                } catch (error) {
                    next(error);
                }
                return;
            }
            vite.middlewares(request, response, next);
        },
        close: () => vite.close(),
    };
}
