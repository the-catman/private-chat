# Hush

End-to-end encrypted chat for small groups, with DMs, file sharing, voice/video calls and screen sharing. Messages and files stay in server RAM until deleted or the server stops.

## How to run

Requires Node.js 22.12+ and Caddy (or any other reverse proxy) forwarding your HTTPS domain to `127.0.0.1:5173`.

Copy `.env.example` to `.env` if it doesn't already exist. Set `APP_PASSWORD` (at least 16 characters) and `APP_ORIGIN` (your HTTPS address), then run:

```bash
npm ci
npm run dev
```

Open the address in `APP_ORIGIN`. It will not open on localhost.

Project code: [MIT](LICENSE). [Third-party licenses](THIRD_PARTY_NOTICES.md).

## Note

This is a personal, and a **completely** AI-generated project.

I do not take suggestions or contributions.

If that's not your cup of tea, I do not care.
