# Gym Tracker — Backend

Node.js + TypeScript + Express + MongoDB (Atlas in production). Provides accounts and offline-first sync for the mobile app.

## Run it (development)

Requires Node 22+. Either point `MONGODB_URI` at MongoDB Atlas, or run MongoDB locally with Docker Desktop.

```bash
cd backend
npm install
npm run db:up        # optional: local MongoDB replica set in Docker (port 27017)
npm run dev          # starts the API on port 4000 (creates indexes automatically)
```

`.env` holds `MONGODB_URI`, `MONGODB_DB`, `JWT_SECRET` and `PORT` (see `.env.example`). A random `JWT_SECRET` was generated for you — never commit `.env`.

On start the server prints addresses like `http://192.168.x.x:4000`.
**On your phone use that address** (not `localhost`) in *Settings → Sign in to sync → Server address*.
The phone must be on the same Wi-Fi; allow Node.js through the Windows Firewall if asked.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | API with auto-reload |
| `npm test` | Integration tests (needs MongoDB; use a separate `MONGODB_DB`, e.g. `gymapp_test`) |
| `npm run typecheck` | Type-check |
| `npm run build` / `npm start` | Compile to `dist/` and run the compiled server |
| `npm run migrate` | Create the MongoDB indexes manually |
| `npm run db:up` / `npm run db:down` | Start / stop local MongoDB |
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
  db.ts        MongoDB client, collections, transactions, indexes
  migrate.ts   index setup (`npm run migrate`)
test/          integration tests (node:test)
```

## Deploying

Any host that runs Docker or Node 22 works (Railway, Render, Fly.io, a VPS) with MongoDB Atlas.
Set `MONGODB_URI` and a long random `JWT_SECRET`, and serve it over **HTTPS** — then put the `https://…` URL in the app.

### Database notes

- MongoDB must be a **replica set** (Atlas always is; `docker-compose.yml` runs a one-node one) because push/pull use transactions.
- Collections: `users` plus one per synced table (`exercises`, `workouts`, …). Each synced document is a row with `user_id`, `id`, its columns, `updated_at`, `deleted` and `version`.
- `version` is per user: every write takes the next value of `users.sync_version`. A push runs in a transaction that writes the user document first, so pushes from several devices of one user are applied one at a time; pulls read from a single snapshot.
- In Atlas → **Network Access**, allow the IP of wherever the API runs (`0.0.0.0/0` for Render's free plan, which has no fixed IP).
