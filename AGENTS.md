# Gym Tracker API — agent notes

This is the backend of the Gym Tracker app (Express 5 + MongoDB, deployed on Cloudflare Workers via a Durable Object).
The project memory lives in the app repo, which contains this folder on the dev machine:

- [../TECHNOLOGY.md](../TECHNOLOGY.md) — architecture, data model, API, Cloudflare deployment, local dev, gotchas.
- [../BUSINESS.md](../BUSINESS.md) — product rules and features the API must support.

(GitHub copy of the app repo: `abdallaElnagar-74/GymTrack-FrontEnd`.)

## Rules that matter most here
- Run tests only against the test database: `MONGODB_DB=gymapp_test npm test` (never the real `gymapp`).
- Before declaring work done: `npm run typecheck` and the relevant tests.
- Nothing may do random/timer/I/O work at module load (Cloudflare Workers forbids it) — create such things on first use.
- Keep sequential MongoDB round trips per request low (Atlas is far away): `Promise.all`, batching, `$lookup`.
- Never commit `.env`, `.dev.vars` or any secret; production secrets are Cloudflare **Secrets**.
- Pushing `main` deploys to production (Cloudflare Workers Builds).
