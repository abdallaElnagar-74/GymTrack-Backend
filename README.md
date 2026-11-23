# Gym Tracker — Backend

Node.js + TypeScript + Express + PostgreSQL. Provides accounts and offline-first sync for the mobile app.

## Run it (development)

Requires Node 22+ and Docker Desktop.

```bash
cd backend
npm install
npm run db:up        # starts PostgreSQL in Docker (port 5432)
npm run dev          # starts the API on port 4000 (runs migrations automatically)
```

`.env` holds `DATABASE_URL`, `JWT_SECRET` and `PORT` (see `.env.example`). A random `JWT_SECRET` was generated for you — never commit `.env`.

On start the server prints addresses like `http://192.168.x.x:4000`.
**On your phone use that address** (not `localhost`) in *Settings → Sign in to sync → Server address*.
The phone must be on the same Wi-Fi; allow Node.js through the Windows Firewall if asked.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | API with auto-reload |
| `npm test` | Integration tests (needs the DB running) |
| `npm run typecheck` | Type-check |
| `npm run build` / `npm start` | Compile to `dist/` and run the compiled server |
| `npm run migrate` | Apply SQL migrations manually |
| `npm run db:up` / `npm run db:down` | Start / stop PostgreSQL |
| `docker compose --profile full up -d --build` | Run DB **and** API in Docker |

## API

| Method | Path | Auth | Body / query | Response |
| --- | --- | --- | --- | --- |
| GET | `/health` | – | – | `{ ok: true }` |
| POST | `/auth/register` | – | `{ email, password }` (≥ 8 chars) | `{ token, user }` |
| POST | `/auth/login` | – | `{ email, password }` | `{ token, user }` |
| GET | `/auth/me` | Bearer | – | `{ user }` |
| DELETE | `/auth/me` | Bearer | – | 204, deletes account + all data |
| GET | `/sync/pull` | Bearer | `?since=<version>` | `{ changes, version, hasMore }` |
| POST | `/sync/push` | Bearer | `{ changes }` | `{ applied, version }` |

`changes` is `{ exercises, exercise_videos, routines, routine_days, routine_day_exercises, workouts, workout_sets }`, each an array of rows.
`exercise_videos` stores YouTube links, or the file name of a video uploaded on a phone (the video file itself stays on that phone).
Every row has `id` (client-generated), `updated_at` (ms) and optional `deleted: true`; references between rows use those ids.

### How sync works

- The app is offline-first: everything is stored in SQLite on the phone. Triggers give each row a global `uuid`,
  stamp `updated_at` on every edit, mark it `dirty`, and record deletes as tombstones.
- A sync **pulls** everything with a server `version` greater than the last one seen and merges it,
  then **pushes** dirty rows and tombstones.
- Conflicts: **last write wins** by `updated_at` (deletes win ties). Deleting a parent (e.g. a workout) also
  tombstones its children on the server.
- The app syncs on launch, when it returns to the foreground, after finishing a workout, and from *Sync now*.

## Project layout

```
src/
  index.ts     start server (+ migrations)
  app.ts       express app: security headers, CORS, JSON, routes, errors
  auth.ts      register / login / me, JWT middleware, rate limiting
  sync.ts      pull / push endpoints
  tables.ts    synced tables + zod validation
  db.ts        pg pool + transactions
  migrate.ts   SQL migration runner
migrations/    *.sql applied in order
test/          integration tests (node:test)
```

## Deploying

Any host that runs Docker or Node 22 works (Railway, Render, Fly.io, a VPS) with a managed Postgres (Neon, Supabase, Railway).
Set `DATABASE_URL` and a long random `JWT_SECRET`, and serve it over **HTTPS** — then put the `https://…` URL in the app.
