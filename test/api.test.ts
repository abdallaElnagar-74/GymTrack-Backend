import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';

let server: Server;
let base = '';

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const email = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

async function newUser() {
  const r = await call('POST', '/auth/register', { email: email(), password: 'password123' });
  assert.equal(r.status, 201);
  return r.body.token as string;
}

before(async () => {
  await migrate();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => {
  await pool.query("DELETE FROM users WHERE email LIKE 'test-%@example.com'");
  server.close();
  await pool.end();
});

describe('auth', () => {
  test('register, login, me', async () => {
    const e = email();
    const reg = await call('POST', '/auth/register', { email: e, password: 'password123' });
    assert.equal(reg.status, 201);
    assert.ok(reg.body.token);

    const dup = await call('POST', '/auth/register', { email: e.toUpperCase(), password: 'password123' });
    assert.equal(dup.status, 409);

    const bad = await call('POST', '/auth/login', { email: e, password: 'wrong-password' });
    assert.equal(bad.status, 401);

    const login = await call('POST', '/auth/login', { email: e, password: 'password123' });
    assert.equal(login.status, 200);

    const me = await call('GET', '/auth/me', undefined, login.body.token);
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, e);
  });

  test('rejects short passwords and missing tokens', async () => {
    const r = await call('POST', '/auth/register', { email: email(), password: 'short' });
    assert.equal(r.status, 400);
    assert.equal((await call('GET', '/sync/pull')).status, 401);
    assert.equal((await call('GET', '/sync/pull', undefined, 'garbage')).status, 401);
  });
});

describe('sync', () => {
  test('push then pull returns rows; pull since version returns nothing new', async () => {
    const token = await newUser();
    const now = Date.now();
    const push = await call(
      'POST',
      '/sync/push',
      {
        changes: {
          exercises: [{ id: 'ex1', name: 'Bench Press', muscle_group: 'Chest', created_at: now, updated_at: now }],
          workouts: [{ id: 'w1', date: now, finished_at: now + 1000, title: 'Push', updated_at: now }],
          workout_sets: [
            { id: 's1', workout_id: 'w1', exercise_id: 'ex1', set_number: 1, reps: 10, weight_kg: 60, created_at: now, done: 1, kind: 'warmup', updated_at: now },
          ],
        },
      },
      token
    );
    assert.equal(push.status, 200);
    assert.equal(push.body.applied, 3);

    const pull = await call('GET', '/sync/pull?since=0', undefined, token);
    assert.equal(pull.status, 200);
    assert.equal(pull.body.changes.exercises[0].name, 'Bench Press');
    assert.equal(pull.body.changes.workout_sets[0].weight_kg, 60);
    assert.equal(pull.body.changes.workout_sets[0].kind, 'warmup');
    assert.equal(pull.body.hasMore, false);

    const again = await call('GET', `/sync/pull?since=${pull.body.version}`, undefined, token);
    const total = Object.values(again.body.changes as Record<string, unknown[]>).reduce((n, r) => n + r.length, 0);
    assert.equal(total, 0);
  });

  test('last write wins', async () => {
    const token = await newUser();
    const t = Date.now();
    await call('POST', '/sync/push', { changes: { exercises: [{ id: 'e', name: 'New', updated_at: t }] } }, token);
    const stale = await call('POST', '/sync/push', { changes: { exercises: [{ id: 'e', name: 'Old', updated_at: t - 5000 }] } }, token);
    assert.equal(stale.body.applied, 0);
    const pull = await call('GET', '/sync/pull?since=0', undefined, token);
    assert.equal(pull.body.changes.exercises[0].name, 'New');
  });

  test('deleting a workout tombstones its sets', async () => {
    const token = await newUser();
    const t = Date.now();
    await call(
      'POST',
      '/sync/push',
      {
        changes: {
          workouts: [{ id: 'w', date: t, updated_at: t }],
          workout_sets: [{ id: 's', workout_id: 'w', exercise_id: 'x', reps: 5, weight_kg: 50, updated_at: t }],
        },
      },
      token
    );
    const first = await call('GET', '/sync/pull?since=0', undefined, token);
    await call('POST', '/sync/push', { changes: { workouts: [{ id: 'w', updated_at: t + 1, deleted: true }] } }, token);
    const pull = await call('GET', `/sync/pull?since=${first.body.version}`, undefined, token);
    assert.equal(pull.body.changes.workouts[0].deleted, true);
    assert.equal(pull.body.changes.workout_sets[0].id, 's');
    assert.equal(pull.body.changes.workout_sets[0].deleted, true);
  });

  test('exercise videos sync and are removed with their exercise', async () => {
    const token = await newUser();
    const t = Date.now();
    const push = await call(
      'POST',
      '/sync/push',
      {
        changes: {
          exercises: [{ id: 'ex', name: 'Squat', updated_at: t }],
          exercise_videos: [
            { id: 'v1', exercise_id: 'ex', source: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ', title: 'Form', updated_at: t },
            { id: 'v2', exercise_id: 'ex', source: 'file', url: '123-abc.mp4', updated_at: t },
          ],
        },
      },
      token
    );
    assert.equal(push.status, 200);
    const first = await call('GET', '/sync/pull?since=0', undefined, token);
    assert.equal(first.body.changes.exercise_videos.length, 2);
    assert.equal(first.body.changes.exercise_videos.find((v: any) => v.id === 'v1').title, 'Form');

    const bad = await call(
      'POST',
      '/sync/push',
      { changes: { exercise_videos: [{ id: 'v3', exercise_id: 'ex', source: 'vimeo', url: 'x', updated_at: t }] } },
      token
    );
    assert.equal(bad.status, 400);

    await call('POST', '/sync/push', { changes: { exercises: [{ id: 'ex', updated_at: t + 1, deleted: true }] } }, token);
    const pull = await call('GET', `/sync/pull?since=${first.body.version}`, undefined, token);
    assert.equal(pull.body.changes.exercise_videos.length, 2);
    assert.ok(pull.body.changes.exercise_videos.every((v: any) => v.deleted === true));
  });

  test('users cannot see each other’s data', async () => {
    const a = await newUser();
    const b = await newUser();
    await call('POST', '/sync/push', { changes: { exercises: [{ id: 'secret', name: 'A only', updated_at: Date.now() }] } }, a);
    const pull = await call('GET', '/sync/pull?since=0', undefined, b);
    assert.equal(pull.body.changes.exercises.length, 0);
  });

  test('validates input', async () => {
    const token = await newUser();
    const r = await call('POST', '/sync/push', { changes: { exercises: [{ id: 'bad id!', updated_at: 1 }] } }, token);
    assert.equal(r.status, 400);
  });
});
