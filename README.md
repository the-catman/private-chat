# Hush

End-to-end encrypted chat for small groups, with DMs, file sharing, voice/video calls and screen sharing. Messages and files stay in server RAM until deleted or the server stops.

## How to run

Requires Node.js 22.12+ and [Caddy](https://caddyserver.com/), which `npm run dev` starts with the included `Caddyfile`. To let it use ports 80 and 443, run `sudo setcap cap_net_bind_service=+ep "$(command -v caddy)"` once (and after Caddy upgrades), and stop any other Caddy.

Copy `.env.example` to `.env` if it doesn't already exist. Set `APP_PASSWORD` (at least 16 characters) and `APP_ORIGIN` (your HTTPS address), then run:

```bash
npm ci
npm run dev
```

Open the address in `APP_ORIGIN`, or `http://localhost:5173` (your `PORT`) on the same machine.

Calls go through the server: open port 44444 (`MEDIA_PORT`) for UDP and TCP to this machine.

Project code: [MIT](LICENSE). [Third-party licenses](THIRD_PARTY_NOTICES.md).

## Note

This is a personal, and a **completely** AI-generated project.

I do not take suggestions or contributions.

If that's not your cup of tea, I do not care.
