import { defineConfig } from 'vite';

export default defineConfig({
    build: {
        sourcemap: false,
        target: 'es2022',
        rollupOptions: {
            output: {
                // Cache the static catalog separately from application updates.
                manualChunks: {
                    'emoji-data': ['./src/lib/emoji-data.ts'],
                    markdown: ['react-markdown', 'remark-gfm'],
                    'message-editor': [
                        '@codemirror/commands',
                        '@codemirror/lang-markdown',
                        '@codemirror/language',
                        '@codemirror/state',
                        '@codemirror/view',
                    ],
                },
            },
        },
    },
});
