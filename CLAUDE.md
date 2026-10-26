> **Warning:** This file is public. Never add personal information, secrets,
> hostnames, IP addresses, or other private deployment details here. Put
> machine-specific notes in an ignored `CLAUDE.local.md` instead.

# Project Overview

Hush is a private, end-to-end encrypted chat app for a small group. It has one
shared room, private DMs, Markdown messages, files, voice notes, voice/video
calls, and screen sharing. Message and file ciphertext lives only in server RAM
until deletion or shutdown; there is no message database.

## Architecture

- React and TypeScript in `src/`, with Vite for development and builds.
- Express and WebSockets in `server/` handle authentication, presence, encrypted
  message relay, and in-memory history. Calls go through a mediasoup SFU
  (`server/calls.ts`); media frames are DAVE-encrypted with MLS keys in the
  browser, and the server only orders MLS commits.
- Messages use Signal's X3DH and Double Ratchet (`src/lib/signal.ts`); the
  server stores public prekeys and hands out each one-time prekey once.
- Client encryption and networking live in `src/lib/`; reusable UI is in
  `src/components/`. Tests are in `test/`.
- Browsers retain identity keys, preferences, and Signal session and message
  keys for the current server boot, never message contents.
- Caddy terminates HTTPS and forwards to Node on `127.0.0.1:PORT` (5173 by
  default). The tracked
  `Caddyfile` reads `APP_ORIGIN` and `PORT` from `.env`; `scripts/serve.ts`
  runs it beside the app for `npm run dev` and `npm start`; do not rely on a
  system Caddy service. The same machine may also open `http://localhost:PORT`
  directly; requests with forwarding headers or other hosts never count as local.

## Public Repository and Privacy

- Assume every tracked file, commit, PR, screenshot, and published artifact is
  public. Include only information intended for public distribution.
- Never commit passwords, tokens, private keys, cookies, real conversations,
  personal data, or private deployment details. Do not print secrets in logs
  or tool output. Use generic placeholders in examples and documentation.
- Keep `.env`, local agent instructions, dependencies, build output, and test
  artifacts ignored. `.env.example` may contain safe placeholders only.
- Preserve the user's existing `.env`. Do not copy its values into source,
  documentation, fixtures, screenshots, or reports.
- Review the diff and staged files before committing. Stage only intended files;
  do not sweep unrelated changes into a commit.
- Commit, push, or rewrite history only when requested. Use force-with-lease for
  requested remote history rewrites. Never silently overwrite remote changes.
- Keep the MIT license for project code and preserve all third-party notices
  and attribution; bundled assets retain their own licenses.

## Project Rules

- Use TypeScript, four-space indentation, and the existing Prettier conventions.
- Keep changes focused. Preserve the user's work and avoid unrelated refactors
  or new dependencies unless they materially help the task.
- Run with `npm run dev`; do not install a user service. Keep the repo's Caddy
  setup and localhost port unless the user asks to change them.
- Public access must remain HTTPS-only; plain HTTP is for localhost only. Read the shared login password from
  `.env`, never from frontend source or a `VITE_` environment variable.
- Never persist messages or files, including encrypted copies, to disk or browser
  storage. Keep DMs limited to their participants and history sharing explicit.
- Preserve identity checks, encryption, input validation, and replay protection.
  Fix development problems without disabling these safeguards.
- Anyone in the room may clear room history; either DM participant may clear
  that DM. Keep the confirmation step and offline/reconnect behavior correct.
- Prefer compact, readable UI with little decorative text. Respect browser zoom,
  keyboard navigation, reduced motion, and light/dark themes.
- Keep message contents selectable and avatars/interface chrome nonselectable.
  Popovers should close on outside click and Escape. Keep composer focus after
  sending, and avoid stealing focus after the user switches conversations.
- Per-person volume is a listener preference and covers voice and shared audio.
  Keep locally bundled fonts, emoji, and audio processing local.
- Keep the README very short: a brief description and how to run.

## Development and Verification

- `npm ci` installs dependencies; `npm run dev` starts Express with Vite.
- `npm run typecheck` checks TypeScript; `npm test` covers client/server logic.
- Use `npm run test:browser` for relevant browser behavior, with an up-to-date
  build. `TEST_DEV=1 npm run test:browser` uses an isolated Vite copy instead.
- `TEST_COMPOSER=1` limits browser checks to sending and composer focus.
- `TEST_FILES=1` limits browser checks to large files and DM images.
- `TEST_CALLS=1` limits browser checks to calls.
- Run checks appropriate to the change. Add regression coverage for meaningful
  bugs; documentation or cosmetic edits do not need a new test suite.
- Use isolated servers, synthetic messages/media, and temporary credentials in
  tests. Never exercise destructive operations against the user's live chat.
- Do not restart the user's running app during routine verification. Frontend
  changes refresh through Vite; `npm run dev` restarts itself on backend or
  `.env` changes, which clears the current RAM history. Mention when an edit
  will trigger that restart.
