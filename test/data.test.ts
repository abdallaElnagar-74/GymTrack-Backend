import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { client, table, users } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { TABLE_NAMES } from '../src/tables.js';

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

const rand = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const email = () => `test-${rand()}@example.com`;
const guestEmail = () => `test-${rand()}@devices.gymtracker.app`;

async function newUser() {
  const r = await call('POST', '/auth/register', { email: email(), password: 'password123' });
  assert.equal(r.status, 201);
  return r.body.token as string;
}

const api = (token: string) => ({
  get: (p: string) => call('GET', `/api${p}`, undefined, token),
  post: (p: string, b?: unknown) => call('POST', `/api${p}`, b ?? {}, token),
  patch: (p: string, b: unknown) => call('PATCH', `/api${p}`, b, token),
  put: (p: string, b: unknown) => call('PUT', `/api${p}`, b, token),
  del: (p: string) => call('DELETE', `/api${p}`, undefined, token),
});

before(async () => {
  await migrate();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => {
  const testUsers = { email: { $regex: /^test-/ } };
  const ids = (await users.find(testUsers, { projection: { _id: 1 } }).toArray()).map((u) => u._id);
  for (const t of TABLE_NAMES) await table(t).deleteMany({ user_id: { $in: ids } });
  await users.deleteMany({ _id: { $in: ids } });
  server.close();
  await client.close();
});

describe('data api', () => {
  test('new accounts start with the starter exercises; names are unique (case-insensitive)', async () => {
    const a = api(await newUser());
    const list = await a.get('/exercises');
    assert.equal(list.status, 200);
    assert.ok(list.body.some((e: any) => e.name === 'Bench Press'));
    assert.equal(list.body[0].user_id, undefined);
    assert.equal((await a.post('/exercises', { name: 'bench press', muscle_group: 'Chest' })).status, 409);
    const add = await a.post('/exercises', { name: 'Cable Row', muscle_group: 'Back' });
    assert.equal(add.status, 201);
    assert.equal((await a.get(`/exercises/${add.body.id}`)).body.name, 'Cable Row');
  });

  test('technique links per set type: saved on the exercise, validated, kept by backup', async () => {
    const a = api(await newUser());
    const bench = (await a.get('/exercises')).body.find((e: any) => e.name === 'Bench Press');
    const path = `/exercises/${bench.id}/technique-links`;
    assert.equal((await a.put(path, { kind: 'drop', link: 'https://youtu.be/abc123' })).status, 204);
    assert.equal((await a.put(path, { kind: 'warmup', link: 'https://example.com/x' })).status, 400);
    assert.equal((await a.put(path, { kind: 'heavy', link: 'https://youtu.be/abc123' })).status, 400);
    let ex = (await a.get(`/exercises/${bench.id}`)).body;
    assert.deepEqual(ex.technique_links, { drop: 'https://youtu.be/abc123' });

    // Name edits keep the links.
    assert.equal((await a.patch(`/exercises/${bench.id}`, { name: 'Bench Press', muscle_group: 'Chest' })).status, 204);
    const backup = (await a.get('/backup')).body;
    assert.equal((await a.post('/backup', backup)).status, 200);
    ex = (await a.get('/exercises')).body.find((e: any) => e.name === 'Bench Press');
    assert.deepEqual(ex.technique_links, { drop: 'https://youtu.be/abc123' });

    // Empty link clears it.
    assert.equal((await a.put(`/exercises/${ex.id}/technique-links`, { kind: 'drop', link: '' })).status, 204);
    assert.equal((await a.get(`/exercises/${ex.id}`)).body.technique_links.drop, '');
  });

  test('plan -> start day -> log -> finish -> history, records, stats', async () => {
    const a = api(await newUser());
    const bench = (await a.get('/exercises')).body.find((e: any) => e.name === 'Bench Press');

    const plan = await a.post('/routines/from-template', { name: 'Upper / Lower', days: ['Upper', 'Lower'] });
    assert.equal(plan.body.existed, false);
    assert.equal((await a.post('/routines/from-template', { name: 'upper / lower', days: [] })).body.existed, true);
    let full = (await a.get(`/routines/${plan.body.id}`)).body;
    const [upper, lower] = full.days;
    assert.equal(full.nextDayId, upper.id);
    await a.post(`/days/${upper.id}/exercises`, { exercise_id: bench.id, target_sets: 2 });

    const w = await a.post('/workouts/from-day', { day_id: upper.id });
    assert.equal(w.status, 201);
    assert.equal((await a.get('/workouts/active')).body.id, w.body.id);
    const groups = (await a.get(`/workouts/${w.body.id}/exercises`)).body;
    assert.equal(groups.length, 1);
    assert.equal(groups[0].sets.length, 2);
    const [s1, s2] = groups[0].sets;
    assert.equal(s2.set_number, 2);
    await a.patch(`/sets/${s1.id}`, { reps: 8, weight_kg: 80, done: true });
    assert.equal((await a.get(`/workouts/${w.body.id}/undone-count`)).body.count, 1);

    const fin = await a.post(`/workouts/${w.body.id}/finish`);
    assert.equal(fin.body.saved, true);
    assert.equal((await a.get('/workouts/active')).body, null);

    const sums = (await a.get('/workouts/summaries')).body;
    assert.equal(sums.length, 1);
    assert.equal(sums[0].set_count, 1);
    assert.equal(sums[0].volume, 640);
    const rec = (await a.get(`/exercises/${bench.id}/records`)).body;
    assert.equal(rec.maxWeight, 80);
    assert.equal(rec.hasHistory, true);
    assert.equal((await a.get(`/exercises/${bench.id}/history`)).body[0].sets.length, 1);
    const stats = (await a.get('/stats/dashboard?tz=0')).body;
    assert.equal(stats.total, 1);
    assert.equal(stats.thisWeek, 1);
    assert.equal(stats.streakWeeks, 1);
    full = (await a.get(`/routines/${plan.body.id}`)).body;
    assert.equal(full.nextDayId, lower.id);

    // Next time, the plan pre-fills from the last session.
    const w2 = await a.post('/workouts/from-day', { day_id: upper.id });
    const g2 = (await a.get(`/workouts/${w2.body.id}/exercises`)).body[0];
    assert.equal(g2.sets[0].weight_kg, 80);
    const last = (await a.get(`/exercises/${bench.id}/last-session?exclude=${w2.body.id}`)).body;
    assert.equal(last.workoutId, w.body.id);
    // ?context=1 returns the same last session and records in the one workout request.
    const ctx = (await a.get(`/workouts/${w2.body.id}/exercises?context=1`)).body[0];
    assert.deepEqual(ctx.last, last);
    assert.deepEqual(ctx.records, (await a.get(`/exercises/${bench.id}/records?exclude=${w2.body.id}`)).body);
    assert.equal(ctx.records.maxWeight, 80);
    assert.equal(g2.last, undefined); // not without ?context=1
    const all = (await a.get('/routines')).body;
    assert.deepEqual(all.find((p: any) => p.id === plan.body.id), full);
    assert.equal(full.lastDone, sums[0].date);

    // A workout with nothing ticked is discarded on finish.
    assert.equal((await a.post(`/workouts/${w2.body.id}/finish`)).body.saved, false);
    assert.equal((await a.get(`/workouts/${w2.body.id}`)).status, 404);

    // Deleting the plan keeps the history.
    assert.equal((await a.del(`/routines/${plan.body.id}`)).status, 204);
    assert.equal((await a.get('/workouts/summaries')).body.length, 1);
  });

  test('plan days store every set (type, weight, reps) and starting uses them', async () => {
    const a = api(await newUser());
    const exs = (await a.get('/exercises')).body;
    const bench = exs.find((e: any) => e.name === 'Bench Press');
    const squat = exs.find((e: any) => e.name === 'Squat');
    const plan = await a.post('/routines/from-template', { name: 'Planned', days: ['A'] });
    const day = (await a.get(`/routines/${plan.body.id}`)).body.days[0];

    // No history yet: the plan starts with empty working sets.
    await a.post(`/days/${day.id}/exercises`, { exercise_id: bench.id, target_sets: 2 });
    let de = (await a.get(`/routines/${plan.body.id}`)).body.days[0].exercises[0];
    assert.deepEqual(de.sets, [
      { kind: 'normal', reps: 0, weight_kg: 0 },
      { kind: 'normal', reps: 0, weight_kg: 0 },
    ]);

    // Plan every set; reps 0 on the last one = fill in from last time.
    const planned = [
      { kind: 'warmup', reps: 12, weight_kg: 40 },
      { kind: 'normal', reps: 10, weight_kg: 60 },
      { kind: 'drop', reps: 0, weight_kg: 45 },
    ];
    assert.equal((await a.patch(`/day-exercises/${de.id}`, { sets: planned })).status, 204);
    de = (await a.get(`/routines/${plan.body.id}`)).body.days[0].exercises[0];
    assert.deepEqual(de.sets, planned);
    assert.equal(de.target_sets, 3);
    assert.equal((await a.patch(`/day-exercises/${de.id}`, { sets: [] })).status, 400);

    // A previous session whose 3rd set had 7 reps.
    const w0 = await a.post('/workouts', {});
    for (const r of [5, 5, 7]) await a.post(`/workouts/${w0.body.id}/sets`, { exercise_id: bench.id, reps: r, weight_kg: 50 });
    for (const g of (await a.get(`/workouts/${w0.body.id}/exercises`)).body) {
      for (const x of g.sets) await a.patch(`/sets/${x.id}`, { done: true });
    }
    await a.post(`/workouts/${w0.body.id}/finish`);

    // Starting the day uses the plan; the empty reps come from last time.
    const w = await a.post('/workouts/from-day', { day_id: day.id });
    const g = (await a.get(`/workouts/${w.body.id}/exercises`)).body[0];
    assert.deepEqual(
      g.sets.map((x: any) => [x.kind, x.weight_kg, x.reps]),
      [
        ['warmup', 40, 12],
        ['normal', 60, 10],
        ['drop', 45, 7],
      ]
    );
    await a.del(`/workouts/${w.body.id}`);

    // A note on a planned set is kept in the plan and copied to the workout's set.
    const withNote = [
      { kind: 'normal', reps: 10, weight_kg: 60 },
      { kind: 'drop', reps: 8, weight_kg: 45, note: '  drop 20%  ' },
      { kind: 'normal', reps: 8, weight_kg: 60, note: '' },
    ];
    assert.equal((await a.patch(`/day-exercises/${de.id}`, { sets: withNote })).status, 204);
    const deNote = (await a.get(`/routines/${plan.body.id}`)).body.days[0].exercises[0];
    assert.deepEqual(deNote.sets, [
      { kind: 'normal', reps: 10, weight_kg: 60 },
      { kind: 'drop', reps: 8, weight_kg: 45, note: 'drop 20%' },
      { kind: 'normal', reps: 8, weight_kg: 60 },
    ]);
    const wn = await a.post('/workouts/from-day', { day_id: day.id });
    const gn = (await a.get(`/workouts/${wn.body.id}/exercises`)).body[0];
    assert.deepEqual(
      gn.sets.map((x: any) => x.note),
      ['', 'drop 20%', '']
    );
    assert.equal((await a.patch(`/sets/${gn.sets[0].id}`, { note: 'slow' })).status, 204);
    const gn2 = (await a.get(`/workouts/${wn.body.id}/exercises`)).body[0];
    assert.equal(gn2.sets[0].note, 'slow');
    assert.equal((await a.patch(`/sets/${gn.sets[0].id}`, { note: 'x'.repeat(121) })).status, 400);
    await a.del(`/workouts/${wn.body.id}`);

    // A YouTube link on a planned set (e.g. how to do the drop set) is kept and copied to the workout's set.
    const yt = 'https://youtu.be/dQw4w9WgXcQ';
    const withLink = [
      { kind: 'normal', reps: 0, weight_kg: 0 },
      { kind: 'drop', reps: 0, weight_kg: 0, link: `  ${yt}  ` },
      { kind: 'normal', reps: 0, weight_kg: 0, link: '' },
    ];
    assert.equal((await a.patch(`/day-exercises/${de.id}`, { sets: withLink })).status, 204);
    const deLink = (await a.get(`/routines/${plan.body.id}`)).body.days[0].exercises[0];
    assert.deepEqual(deLink.sets, [
      { kind: 'normal', reps: 0, weight_kg: 0 },
      { kind: 'drop', reps: 0, weight_kg: 0, link: yt },
      { kind: 'normal', reps: 0, weight_kg: 0 },
    ]);
    const wl = await a.post('/workouts/from-day', { day_id: day.id });
    const gl = (await a.get(`/workouts/${wl.body.id}/exercises`)).body[0];
    assert.deepEqual(
      gl.sets.map((x: any) => x.link),
      ['', yt, '']
    );
    await a.del(`/workouts/${wl.body.id}`);
    // Only YouTube links are accepted.
    const badLink = [{ kind: 'drop', reps: 0, weight_kg: 0, link: 'https://evil.example.com/x' }];
    assert.equal((await a.patch(`/day-exercises/${de.id}`, { sets: badLink })).status, 400);

    // Adding an exercise that has history starts its plan from last time.
    const w1 = await a.post('/workouts', {});
    await a.post(`/workouts/${w1.body.id}/sets`, { exercise_id: squat.id, reps: 8, weight_kg: 100 });
    const sq = (await a.get(`/workouts/${w1.body.id}/exercises`)).body[0].sets[0];
    await a.patch(`/sets/${sq.id}`, { done: true });
    await a.post(`/workouts/${w1.body.id}/finish`);
    await a.post(`/days/${day.id}/exercises`, { exercise_id: squat.id });
    const sqPlan = (await a.get(`/routines/${plan.body.id}`)).body.days[0].exercises.find(
      (x: any) => x.exercise_id === squat.id
    );
    assert.deepEqual(sqPlan.sets, [{ kind: 'normal', reps: 8, weight_kg: 100 }]);
  });

  test('sets renumber on delete; settings; videos', async () => {
    const a = api(await newUser());
    const ex = (await a.get('/exercises')).body[0];
    const w = (await a.post('/workouts', {})).body.id;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await a.post(`/workouts/${w}/sets`, { exercise_id: ex.id, reps: 5, weight_kg: 50 })).body.id);
    }
    await a.del(`/sets/${ids[0]}`);
    const sets = (await a.get(`/workouts/${w}/exercises`)).body[0].sets;
    assert.deepEqual(sets.map((s: any) => s.set_number), [1, 2]);

    assert.equal((await a.get('/settings')).body.unit, 'kg');
    await a.put('/settings', { unit: 'lb' });
    assert.equal((await a.get('/settings')).body.unit, 'lb');
    assert.equal((await a.get('/settings')).body.rest_seconds, 60);
    await a.put('/settings', { rest_seconds: 120 });
    assert.deepEqual((await a.get('/settings')).body, { unit: 'lb', rest_seconds: 120 }); // unit kept
    assert.equal((await a.put('/settings', { rest_seconds: 9999 })).status, 400);

    const v = await a.post(`/exercises/${ex.id}/videos`, { source: 'youtube', url: 'https://youtu.be/x', title: 'Form' });
    assert.equal(v.status, 201);
    assert.equal((await a.get(`/exercises/${ex.id}/videos`)).body.length, 1);
    await a.del(`/exercises/${ex.id}`);
    assert.equal(await table('exercise_videos').countDocuments({ id: v.body.id }), 0);
  });

  test('backup export -> import round-trips (and accepts old numeric ids)', async () => {
    const a = api(await newUser());
    const ex = (await a.get('/exercises')).body[0];
    const w = (await a.post('/workouts', {})).body.id;
    await a.post(`/workouts/${w}/sets`, { exercise_id: ex.id, reps: 5, weight_kg: 50 });
    const backup = (await a.get('/backup')).body;
    const imp = await a.post('/backup', backup);
    assert.equal(imp.status, 200);
    assert.equal((await a.get('/exercises')).body.length, backup.exercises.length);

    const old = {
      app: 'gymapp',
      version: 2,
      exercises: [{ id: 1, name: 'Squat', muscle_group: 'Legs', created_at: 1 }],
      workouts: [{ id: 7, date: 1000, notes: '', finished_at: 2000, title: '', day_id: null }],
      workout_sets: [
        { id: 3, workout_id: 7, exercise_id: 1, set_number: 1, reps: 5, weight_kg: 100, created_at: 1, done: 1, kind: 'normal' },
      ],
    };
    assert.equal((await a.post('/backup', old)).body.imported, 3);
    assert.equal((await a.get('/workouts/summaries')).body[0].volume, 500);
  });

  test('guest upgrade keeps the account; guest merge moves data into an existing account', async () => {
    const g1 = await call('POST', '/auth/register', { email: guestEmail(), password: 'password123' });
    const up = await call('POST', '/auth/upgrade', { email: email(), password: 'password123' }, g1.body.token);
    assert.equal(up.status, 200);
    assert.equal(up.body.user.id, g1.body.user.id);
    assert.equal((await call('POST', '/auth/upgrade', { email: email(), password: 'password123' }, up.body.token)).status, 400);

    const targetEmail = email();
    const target = await call('POST', '/auth/register', { email: targetEmail, password: 'password123' });
    const g2 = await call('POST', '/auth/register', { email: guestEmail(), password: 'password123' });
    const ga = api(g2.body.token);
    const bench = (await ga.get('/exercises')).body.find((e: any) => e.name === 'Bench Press');
    const w = (await ga.post('/workouts', {})).body.id;
    await ga.post(`/workouts/${w}/sets`, { exercise_id: bench.id, reps: 5, weight_kg: 50 });

    const bad = await call('POST', '/auth/merge', { email: targetEmail, password: 'wrong-password' }, g2.body.token);
    assert.equal(bad.status, 401);
    const m = await call('POST', '/auth/merge', { email: targetEmail, password: 'password123' }, g2.body.token);
    assert.equal(m.status, 200);
    assert.equal(m.body.user.id, target.body.user.id);

    const ta = api(m.body.token);
    const exsRes = await ta.get("/exercises");
    assert.equal(exsRes.status, 200, JSON.stringify(exsRes.body));
    const exs = exsRes.body;
    assert.equal(exs.filter((e: any) => e.name === 'Bench Press').length, 1); // merged by name
    const groups = (await ta.get(`/workouts/${w}/exercises`)).body;
    assert.equal(groups[0].exercise.name, 'Bench Press');
    assert.equal((await call('GET', '/auth/me', undefined, g2.body.token)).status, 401);
  });

  test('guest accounts: server-made credentials, optional starter exercises', async () => {
    const g = await call('POST', '/auth/guest', {});
    assert.equal(g.status, 201);
    assert.match(g.body.user.email, /@devices\.gymtracker\.app$/);
    assert.ok(g.body.password.length >= 32);
    const relogin = await call('POST', '/auth/login', { email: g.body.user.email, password: g.body.password });
    assert.equal(relogin.status, 200);
    assert.ok((await api(g.body.token).get('/exercises')).body.length > 0);

    const empty = await call('POST', '/auth/guest', { seed: false });
    assert.equal((await api(empty.body.token).get('/exercises')).body.length, 0);
    // Clean up (their emails don't start with "test-").
    await call('DELETE', '/auth/me', undefined, g.body.token);
    await call('DELETE', '/auth/me', undefined, empty.body.token);
  });

  test("cannot read or change another user's rows", async () => {
    const a = api(await newUser());
    const b = api(await newUser());
    const ex = (await a.get('/exercises')).body[0];
    assert.equal((await b.get(`/exercises/${ex.id}`)).status, 404);
    await b.del(`/exercises/${ex.id}`);
    assert.equal((await a.get(`/exercises/${ex.id}`)).status, 200);
    assert.equal((await b.patch(`/exercises/${ex.id}`, { name: 'Hacked' })).status, 404);
  });
});
