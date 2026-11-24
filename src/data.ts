import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import type { ClientSession, CollationOptions, Document, Sort } from 'mongodb';
import { z } from 'zod';
import { table, tx, users, type SyncedDoc } from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';
import { HttpError } from './errors.js';
import { SEED_EXERCISES } from './seed.js';
import { TABLE_NAMES, type TableName } from './tables.js';

/**
 * Data API: the app reads and writes everything here; MongoDB is the only copy of the data.
 *
 * Every document belongs to one user (`user_id`) and is addressed by its string `id`.
 * Rows with `deleted: true` are tombstones left by the old offline sync and are ignored.
 */

type Row = Record<string, any>;

const uidOf = (req: Request) => (req as AuthedRequest).userId;
export const newId = () => randomUUID().replace(/-/g, '');

/** Server bookkeeping fields that the app never sees. */
const HIDDEN = { _id: 0, user_id: 0, deleted: 0, version: 0, updated_at: 0 } as const;
/** Case-insensitive comparison / sorting (e.g. exercise names). */
const CI: CollationOptions = { locale: 'en', strength: 2 };

const live = (uid: string, extra: Document = {}) => ({ user_id: uid, deleted: { $ne: true }, ...extra });

type Opts = { sort?: Sort; session?: ClientSession; collation?: CollationOptions };

function list(t: TableName, uid: string, filter: Document = {}, o: Opts = {}): Promise<Row[]> {
  const c = table(t).find(live(uid, filter), { projection: HIDDEN, session: o.session, collation: o.collation });
  return (o.sort ? c.sort(o.sort) : c).toArray();
}

function one(t: TableName, uid: string, id: string, session?: ClientSession): Promise<Row | null> {
  return table(t).findOne(live(uid, { id }), { projection: HIDDEN, session });
}

async function must(t: TableName, uid: string, id: string, what: string, session?: ClientSession) {
  const r = await one(t, uid, id, session);
  if (!r) throw new HttpError(404, `${what} not found`);
  return r;
}

const doc = (uid: string, data: Row): SyncedDoc => ({
  user_id: uid,
  id: newId(),
  ...data,
  updated_at: Date.now(),
  deleted: false,
  version: 0,
});

async function insert(t: TableName, uid: string, data: Row, session?: ClientSession) {
  const d = doc(uid, data);
  await table(t).insertOne(d, { session });
  return d.id;
}

async function update(t: TableName, uid: string, id: string, data: Row, what: string, session?: ClientSession) {
  const r = await table(t).updateOne(live(uid, { id }), { $set: { ...data, updated_at: Date.now() } }, { session });
  if (!r.matchedCount) throw new HttpError(404, `${what} not found`);
}

const remove = (t: TableName, uid: string, filter: Document, session?: ClientSession) =>
  table(t).deleteMany({ user_id: uid, ...filter }, { session });

// ---------- validation ----------

const idSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'invalid id');
const pid = (req: Request, key = 'id') => idSchema.parse(req.params[key]);
const name = (max: number) => z.string().trim().min(1, 'Name is required').max(max);
const kind = z.enum(['normal', 'warmup', 'drop']);
const reps = z.number().int().min(0).max(100000);
const weight = z.number().min(0).max(100000);
/** A short note on a set, e.g. "drop 20%" (empty = no note). */
const setNote = z.string().trim().max(120);
/** One set planned in a plan day: type, weight and reps (0 = fill in from last time when starting), optional note. */
type PlannedSet = { kind: 'normal' | 'warmup' | 'drop'; reps: number; weight_kg: number; note?: string };
const plannedSet = z
  .object({ kind: kind.default('normal'), reps: reps.max(1000), weight_kg: weight, note: setNote.optional() })
  // An empty note is dropped instead of being stored.
  .transform(({ note, ...rest }): PlannedSet => (note ? { ...rest, note } : rest));
const plannedSets = z.array(plannedSet).min(1).max(20);

const exclude = (req: Request) => z.string().max(64).optional().parse(req.query.exclude) ?? '';

// ---------- accounts ----------

export async function seedExercises(uid: string, session?: ClientSession) {
  const now = Date.now();
  await table('exercises').insertMany(
    SEED_EXERCISES.map(([n, g]) => doc(uid, { name: n, muscle_group: g, created_at: now })),
    { session }
  );
}

/**
 * Move all of `from`'s data into `to` (used when a guest signs in to an existing account).
 * Exercises with the same name are merged, and everything that used them is re-pointed.
 */
export async function moveUserData(from: string, to: string, session: ClientSession) {
  for (const t of TABLE_NAMES) await table(t).deleteMany({ user_id: from, deleted: true }, { session });

  const theirs = await list('exercises', to, {}, { session });
  const byName = new Map(theirs.map((e) => [String(e.name).trim().toLowerCase(), e.id as string]));
  const remap: [string, string][] = [];
  for (const e of await list('exercises', from, {}, { session })) {
    const target = byName.get(String(e.name).trim().toLowerCase());
    if (target) remap.push([e.id, target]);
  }
  if (remap.length) await remove('exercises', from, { id: { $in: remap.map(([a]) => a) } }, session);

  for (const t of TABLE_NAMES) await table(t).updateMany({ user_id: from }, { $set: { user_id: to } }, { session });
  for (const [oldId, newId_] of remap) {
    for (const t of ['workout_sets', 'routine_day_exercises', 'exercise_videos'] as const) {
      await table(t).updateMany({ user_id: to, exercise_id: oldId }, { $set: { exercise_id: newId_ } }, { session });
    }
  }
}

// ---------- shared queries ----------

/** Per-workout totals: sets, distinct exercises, volume (warm-ups excluded). All workouts if no ids are given. */
async function workoutTotals(uid: string, workoutIds?: string[]) {
  const rows = await table('workout_sets')
    .aggregate<{ _id: string; set_count: number; exercises: string[]; volume: number }>([
      { $match: live(uid, workoutIds ? { workout_id: { $in: workoutIds } } : {}) },
      {
        $group: {
          _id: '$workout_id',
          set_count: { $sum: 1 },
          exercises: { $addToSet: '$exercise_id' },
          volume: { $sum: { $cond: [{ $eq: ['$kind', 'warmup'] }, 0, { $multiply: ['$reps', '$weight_kg'] }] } },
        },
      },
    ])
    .toArray();
  return new Map(rows.map((r) => [r._id, { set_count: r.set_count, exercise_count: r.exercises.length, volume: r.volume }]));
}

const finishedWorkouts = (uid: string, filter: Document = {}) =>
  list('workouts', uid, { finished_at: { $ne: null }, ...filter }, { sort: { date: -1 } });

/** Sets of these exercises from finished workouts (other than `excludeId`), each with its workout date. */
async function finishedSetsOf(uid: string, exerciseIds: string[], excludeId = '') {
  if (!exerciseIds.length) return [];
  // One round trip: the sets joined with their (finished) workout's date.
  return table('workout_sets')
    .aggregate<Row>([
      { $match: live(uid, { exercise_id: { $in: exerciseIds }, workout_id: { $ne: excludeId } }) },
      {
        $lookup: {
          from: 'workouts',
          let: { wid: '$workout_id' },
          pipeline: [
            { $match: live(uid, { finished_at: { $ne: null }, $expr: { $eq: ['$id', '$$wid'] } }) },
            { $project: { _id: 0, date: 1 } },
          ],
          as: 'w',
        },
      },
      { $unwind: '$w' }, // drops sets of unfinished workouts
      { $set: { date: '$w.date' } },
      { $project: { ...HIDDEN, w: 0 } },
    ])
    .toArray();
}

function estimate1RM(weight: number, r: number) {
  if (r <= 0 || weight <= 0) return 0;
  if (r === 1) return weight;
  return weight * (1 + r / 30); // Epley
}

type LastSession = { workoutId: string; date: number; sets: Row[] };
type Records = { maxWeight: number; best1RM: number; maxVolume: number; hasHistory: boolean };

/**
 * For each exercise: the sets of its latest finished workout (other than `excludeId`) and its
 * personal records (warm-ups ignored). Two database round trips however many exercises there are.
 */
async function exerciseContexts(uid: string, exerciseIds: string[], excludeId = '') {
  const byExercise = new Map<string, Row[]>(exerciseIds.map((id) => [id, []]));
  for (const s of await finishedSetsOf(uid, exerciseIds, excludeId)) byExercise.get(s.exercise_id)?.push(s);

  const out = new Map<string, { last: LastSession | null; records: Records }>();
  for (const [exerciseId, rows] of byExercise) {
    const records: Records = { maxWeight: 0, best1RM: 0, maxVolume: 0, hasHistory: false };
    let latest: Row | null = null;
    for (const r of rows) {
      if (!latest || r.date > latest.date) latest = r;
      if (r.kind === 'warmup') continue;
      records.hasHistory = true;
      records.maxWeight = Math.max(records.maxWeight, r.weight_kg);
      records.best1RM = Math.max(records.best1RM, estimate1RM(r.weight_kg, r.reps));
      records.maxVolume = Math.max(records.maxVolume, r.reps * r.weight_kg);
    }
    const last = latest && {
      workoutId: latest.workout_id as string,
      date: latest.date as number,
      sets: rows
        .filter((r) => r.workout_id === latest.workout_id)
        .map(({ date: _date, ...s }) => s)
        .sort((a, b) => a.set_number - b.set_number),
    };
    out.set(exerciseId, { last, records });
  }
  return out;
}

const lastSession = async (uid: string, exerciseId: string, excludeId: string) =>
  (await exerciseContexts(uid, [exerciseId], excludeId)).get(exerciseId)!.last;

/**
 * Plans with their days, each day's exercises, the next day in rotation and when the plan was
 * last trained. One parallel batch of queries for all of them (`routineId` limits it to one plan).
 */
async function routinesFull(uid: string, routineId?: string) {
  const sortPos: Opts = { sort: { position: 1, _id: 1 } };
  const [routines, days, links, exercises, lastByDay] = await Promise.all([
    list('routines', uid, routineId ? { id: routineId } : {}, { sort: { created_at: 1, _id: 1 } }),
    list('routine_days', uid, routineId ? { routine_id: routineId } : {}, sortPos),
    list('routine_day_exercises', uid, {}, sortPos),
    table('exercises').find(live(uid), { projection: { _id: 0, id: 1, name: 1, muscle_group: 1 } }).toArray(),
    // Most recent finished workout per plan day.
    table('workouts')
      .aggregate<{ _id: string; date: number }>([
        { $match: live(uid, { finished_at: { $ne: null }, day_id: { $nin: [null, ''] } }) },
        { $group: { _id: '$day_id', date: { $max: '$date' } } },
      ])
      .toArray(),
  ]);
  const exs = new Map(exercises.map((e) => [e.id, e]));
  const lastDate = new Map(lastByDay.map((d) => [d._id, d.date]));

  return routines.map((routine) => {
    const full: Row[] = days
      .filter((d) => d.routine_id === routine.id)
      .map((d) => ({
        ...d,
        exercises: links
          .filter((l) => l.day_id === d.id && exs.has(l.exercise_id))
          .map((l) => ({ ...l, name: exs.get(l.exercise_id)!.name, muscle_group: exs.get(l.exercise_id)!.muscle_group })),
      }));

    // Next day in rotation = the day after the most recently finished one.
    let lastDone: number | null = null;
    let lastIndex = -1;
    full.forEach((d, i) => {
      const t = lastDate.get(d.id);
      if (t !== undefined && (lastDone === null || t > lastDone)) {
        lastDone = t;
        lastIndex = i;
      }
    });
    const nextDayId: string | null = full.length ? full[(lastIndex + 1) % full.length].id : null;
    return { ...routine, days: full, nextDayId, lastDone };
  });
}

async function assertUniqueExerciseName(uid: string, n: string, exceptId?: string) {
  const clash = await table('exercises').findOne(
    live(uid, { name: n, ...(exceptId ? { id: { $ne: exceptId } } : {}) }),
    { collation: CI, projection: { _id: 1 } }
  );
  if (clash) throw new HttpError(409, 'An exercise with that name already exists');
}

// ---------- routes ----------

export const dataRouter = Router();
dataRouter.use(requireAuth);

// Exercises

dataRouter.get('/exercises', async (req, res) => {
  res.json(await list('exercises', uidOf(req), {}, { sort: { muscle_group: 1, name: 1 }, collation: CI }));
});

const exerciseBody = z.object({ name: name(100), muscle_group: z.string().trim().min(1).max(40).default('Other') });

dataRouter.post('/exercises', async (req, res) => {
  const uid = uidOf(req);
  const b = exerciseBody.parse(req.body);
  await assertUniqueExerciseName(uid, b.name);
  res.status(201).json({ id: await insert('exercises', uid, { ...b, created_at: Date.now() }) });
});

dataRouter.get('/exercises/:id', async (req, res) => {
  res.json(await must('exercises', uidOf(req), pid(req), 'Exercise'));
});

dataRouter.patch('/exercises/:id', async (req, res) => {
  const uid = uidOf(req);
  const id = pid(req);
  const b = exerciseBody.parse(req.body);
  await assertUniqueExerciseName(uid, b.name, id);
  await update('exercises', uid, id, b, 'Exercise');
  res.status(204).end();
});

dataRouter.delete('/exercises/:id', async (req, res) => {
  const uid = uidOf(req);
  const id = pid(req);
  await tx(async (s) => {
    await remove('workout_sets', uid, { exercise_id: id }, s);
    await remove('routine_day_exercises', uid, { exercise_id: id }, s);
    await remove('exercise_videos', uid, { exercise_id: id }, s);
    await remove('exercises', uid, { id }, s);
  });
  res.status(204).end();
});

dataRouter.get('/exercises/:id/records', async (req, res) => {
  const id = pid(req);
  res.json((await exerciseContexts(uidOf(req), [id], exclude(req))).get(id)!.records);
});

dataRouter.get('/exercises/:id/history', async (req, res) => {
  const rows = await finishedSetsOf(uidOf(req), [pid(req)]);
  rows.sort((a, b) => b.date - a.date || a.set_number - b.set_number);
  const map = new Map<string, { workoutId: string; date: number; sets: Row[] }>();
  for (const { date, ...s } of rows) {
    let g = map.get(s.workout_id);
    if (!g) map.set(s.workout_id, (g = { workoutId: s.workout_id, date, sets: [] }));
    g.sets.push(s);
  }
  res.json([...map.values()]);
});

dataRouter.get('/exercises/:id/last-session', async (req, res) => {
  res.json(await lastSession(uidOf(req), pid(req), exclude(req)));
});

// Exercise videos

dataRouter.get('/exercises/:id/videos', async (req, res) => {
  res.json(await list('exercise_videos', uidOf(req), { exercise_id: pid(req) }, { sort: { position: 1, _id: 1 } }));
});

dataRouter.post('/exercises/:id/videos', async (req, res) => {
  const uid = uidOf(req);
  const exerciseId = pid(req);
  const b = z
    .object({
      source: z.enum(['youtube', 'file']),
      url: z.string().min(1).max(2000),
      title: z.string().trim().max(200).default(''),
    })
    .parse(req.body);
  const [, top] = await Promise.all([
    must('exercises', uid, exerciseId, 'Exercise'),
    table('exercise_videos').findOne(live(uid, { exercise_id: exerciseId }), { sort: { position: -1 }, projection: { position: 1 } }),
  ]);
  const position = top ? (top.position as number) + 1 : 0;
  const id = await insert('exercise_videos', uid, { exercise_id: exerciseId, ...b, position, created_at: Date.now() });
  res.status(201).json({ id });
});

dataRouter.patch('/videos/:id', async (req, res) => {
  const b = z.object({ title: z.string().trim().max(200) }).parse(req.body);
  await update('exercise_videos', uidOf(req), pid(req), b, 'Video');
  res.status(204).end();
});

dataRouter.delete('/videos/:id', async (req, res) => {
  await remove('exercise_videos', uidOf(req), { id: pid(req) });
  res.status(204).end();
});

// Workouts

dataRouter.get('/workouts/active', async (req, res) => {
  const w = await table('workouts').findOne(live(uidOf(req), { finished_at: null }), {
    projection: HIDDEN,
    sort: { date: -1 },
  });
  res.json(w);
});

dataRouter.get('/workouts/summaries', async (req, res) => {
  const uid = uidOf(req);
  const [ws, totals] = await Promise.all([finishedWorkouts(uid), workoutTotals(uid)]);
  res.json(ws.map((w) => ({ ...w, ...(totals.get(w.id) ?? { set_count: 0, exercise_count: 0, volume: 0 }) })));
});

dataRouter.get('/stats/dashboard', async (req, res) => {
  const uid = uidOf(req);
  // The phone's UTC offset in minutes (as from Date#getTimezoneOffset), so weeks start on its local Monday.
  const tz = z.coerce.number().int().min(-900).max(900).default(0).parse(req.query.tz);
  const shift = (ts: number) => ts - tz * 60000; // local wall-clock time expressed as UTC
  const [ws, totals] = await Promise.all([finishedWorkouts(uid), workoutTotals(uid)]);
  const rows = ws.map((w) => ({ date: w.date as number, volume: totals.get(w.id)?.volume ?? 0 }));

  const sow = (ts: number) => {
    const d = new Date(shift(ts));
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.getTime();
  };
  const week = sow(Date.now());
  const thisWeek = rows.filter((r) => sow(r.date) >= week);
  const weeks = new Set(rows.map((r) => sow(r.date)));
  const WEEK = 7 * 24 * 3600 * 1000;
  let cursor = weeks.has(week) ? week : week - WEEK;
  let streak = 0;
  while (weeks.has(cursor)) {
    streak++;
    cursor -= WEEK;
  }
  res.json({
    total: rows.length,
    thisWeek: thisWeek.length,
    weekVolume: thisWeek.reduce((a, r) => a + r.volume, 0),
    streakWeeks: streak,
    lastDate: rows[0]?.date ?? null,
  });
});

dataRouter.post('/workouts', async (req, res) => {
  const uid = uidOf(req);
  const b = z
    .object({ title: z.string().trim().max(100).default(''), day_id: idSchema.nullable().default(null) })
    .parse(req.body ?? {});
  const id = await insert('workouts', uid, { date: Date.now(), notes: '', finished_at: null, ...b });
  res.status(201).json({ id });
});

/** Start a workout from a plan day: creates its sets, pre-filled from last time. */
dataRouter.post('/workouts/from-day', async (req, res) => {
  const uid = uidOf(req);
  const { day_id } = z.object({ day_id: idSchema }).parse(req.body);
  const [day, links] = await Promise.all([
    must('routine_days', uid, day_id, 'Day'),
    list('routine_day_exercises', uid, { day_id }, { sort: { position: 1, _id: 1 } }),
  ]);
  const exIds = [...new Set(links.map((l) => l.exercise_id as string))];
  const [existingRows, context] = await Promise.all([
    table('exercises').find(live(uid, { id: { $in: exIds } }), { projection: { _id: 0, id: 1 } }).toArray(),
    exerciseContexts(uid, exIds),
  ]);
  const existing = new Set(existingRows.map((e) => e.id));

  const workout = doc(uid, { date: Date.now(), notes: '', finished_at: null, title: day.name, day_id });
  const workoutId = workout.id;
  const sets: SyncedDoc[] = [];
  let t = Date.now();
  for (const link of links) {
    if (!existing.has(link.exercise_id)) continue;
    const last = context.get(link.exercise_id)?.last;
    const planned = link.sets as PlannedSet[] | undefined;
    if (planned?.length) {
      const working = last?.sets.filter((s) => s.kind !== 'warmup') ?? [];
      planned.forEach((ps, i) => {
        // Empty planned values fall back to the same set last time, then to the last working set.
        const prev = last?.sets[i] ?? working.at(-1) ?? last?.sets.at(-1);
        sets.push(
          doc(uid, {
            workout_id: workoutId,
            exercise_id: link.exercise_id,
            set_number: i + 1,
            reps: ps.reps || (prev?.reps ?? 0),
            weight_kg: ps.weight_kg || (prev?.weight_kg ?? 0),
            created_at: t++, // keeps the plan's exercise order
            done: 0,
            kind: ps.kind ?? 'normal',
            note: ps.note ?? '',
          })
        );
      });
      continue;
    }
    for (let i = 0; i < link.target_sets; i++) {
      // Same set types as last time (e.g. your 2 warm-ups), so you don't re-mark them every session.
      const same = last?.sets[i];
      const p = same ?? last?.sets.filter((s) => s.kind !== 'warmup').at(-1) ?? last?.sets.at(-1);
      sets.push(
        doc(uid, {
          workout_id: workoutId,
          exercise_id: link.exercise_id,
          set_number: i + 1,
          reps: p?.reps ?? 0,
          weight_kg: p?.weight_kg ?? 0,
          created_at: t++, // keeps the plan's exercise order
          done: 0,
          kind: same?.kind ?? 'normal',
          note: '',
        })
      );
    }
  }
  await Promise.all([
    table('workouts').insertOne(workout),
    sets.length ? table('workout_sets').insertMany(sets) : null,
  ]);
  res.status(201).json({ id: workoutId });
});

dataRouter.get('/workouts/:id', async (req, res) => {
  res.json(await must('workouts', uidOf(req), pid(req), 'Workout'));
});

dataRouter.patch('/workouts/:id', async (req, res) => {
  const b = z.object({ notes: z.string().max(5000) }).parse(req.body);
  await update('workouts', uidOf(req), pid(req), b, 'Workout');
  res.status(204).end();
});

dataRouter.delete('/workouts/:id', async (req, res) => {
  const uid = uidOf(req);
  const id = pid(req);
  await tx(async (s) => {
    await remove('workout_sets', uid, { workout_id: id }, s);
    await remove('workouts', uid, { id }, s);
  });
  res.status(204).end();
});

/** Sets of a workout grouped by exercise, in the order each exercise was first logged. */
dataRouter.get('/workouts/:id/exercises', async (req, res) => {
  const uid = uidOf(req);
  const workoutId = pid(req);
  const withContext = req.query.context === '1';
  const sets = await list('workout_sets', uid, { workout_id: workoutId }, { sort: { created_at: 1, _id: 1 } });
  const exIds = [...new Set(sets.map((s) => s.exercise_id as string))];
  const [exercises, context] = await Promise.all([
    list('exercises', uid, { id: { $in: exIds } }),
    withContext ? exerciseContexts(uid, exIds, workoutId) : null,
  ]);
  const byId = new Map(exercises.map((e) => [e.id, e]));
  const groups = new Map<string, { exercise: Row; sets: Row[]; last?: LastSession | null; records?: Records }>();
  for (const s of sets) {
    const ex = byId.get(s.exercise_id);
    if (!ex) continue;
    let g = groups.get(s.exercise_id);
    if (!g) groups.set(s.exercise_id, (g = { exercise: ex, sets: [], ...context?.get(s.exercise_id) }));
    g.sets.push(s);
  }
  for (const g of groups.values()) g.sets.sort((a, b) => a.set_number - b.set_number);
  res.json([...groups.values()]);
});

dataRouter.get('/workouts/:id/undone-count', async (req, res) => {
  const count = await table('workout_sets').countDocuments(live(uidOf(req), { workout_id: pid(req), done: 0 }));
  res.json({ count });
});

/** Drop sets not ticked as done, renumber, and save. `saved: false` = nothing was logged, workout discarded. */
dataRouter.post('/workouts/:id/finish', async (req, res) => {
  const uid = uidOf(req);
  const id = pid(req);
  const saved = await tx(async (s) => {
    const now = Date.now();
    await update('workouts', uid, id, { finished_at: now }, 'Workout', s);
    await remove('workout_sets', uid, { workout_id: id, done: 0 }, s);
    const remaining = await list('workout_sets', uid, { workout_id: id }, {
      sort: { exercise_id: 1, set_number: 1, _id: 1 },
      session: s,
    });
    if (!remaining.length) {
      await remove('workouts', uid, { id }, s);
      return false;
    }
    const counters = new Map<string, number>();
    const ops = remaining.map((r) => {
      const n = (counters.get(r.exercise_id) ?? 0) + 1;
      counters.set(r.exercise_id, n);
      return { updateOne: { filter: { user_id: uid, id: r.id }, update: { $set: { set_number: n, updated_at: now } } } };
    });
    await table('workout_sets').bulkWrite(ops, { session: s });
    return true;
  });
  res.json({ saved });
});

dataRouter.post('/workouts/:id/sets', async (req, res) => {
  const uid = uidOf(req);
  const workoutId = pid(req);
  const b = z
    .object({ exercise_id: idSchema, reps, weight_kg: weight, kind: kind.default('normal'), note: setNote.default('') })
    .parse(req.body);
  const [, , top] = await Promise.all([
    must('workouts', uid, workoutId, 'Workout'),
    must('exercises', uid, b.exercise_id, 'Exercise'),
    table('workout_sets').findOne(live(uid, { workout_id: workoutId, exercise_id: b.exercise_id }), {
      sort: { set_number: -1 },
      projection: { set_number: 1 },
    }),
  ]);
  const id = await insert('workout_sets', uid, {
    workout_id: workoutId,
    exercise_id: b.exercise_id,
    set_number: ((top?.set_number as number) ?? 0) + 1,
    reps: b.reps,
    weight_kg: b.weight_kg,
    created_at: Date.now(),
    done: 0,
    kind: b.kind,
    note: b.note,
  });
  res.status(201).json({ id });
});

dataRouter.delete('/workouts/:id/exercises/:exerciseId', async (req, res) => {
  await remove('workout_sets', uidOf(req), { workout_id: pid(req), exercise_id: pid(req, 'exerciseId') });
  res.status(204).end();
});

// Sets

dataRouter.patch('/sets/:id', async (req, res) => {
  const b = z
    .object({
      reps: reps.optional(),
      weight_kg: weight.optional(),
      kind: kind.optional(),
      note: setNote.optional(),
      done: z.boolean().optional(),
    })
    .parse(req.body);
  const { done, ...rest } = b;
  await update('workout_sets', uidOf(req), pid(req), { ...rest, ...(done === undefined ? {} : { done: done ? 1 : 0 }) }, 'Set');
  res.status(204).end();
});

/** Delete a set and close the gap in the numbering. */
dataRouter.delete('/sets/:id', async (req, res) => {
  const uid = uidOf(req);
  const id = pid(req);
  await tx(async (s) => {
    const set = await one('workout_sets', uid, id, s);
    if (!set) return;
    await remove('workout_sets', uid, { id }, s);
    await table('workout_sets').updateMany(
      live(uid, { workout_id: set.workout_id, exercise_id: set.exercise_id, set_number: { $gt: set.set_number } }),
      { $inc: { set_number: -1 }, $set: { updated_at: Date.now() } },
      { session: s }
    );
  });
  res.status(204).end();
});

// Settings

dataRouter.get('/settings', async (req, res) => {
  const u = await users.findOne({ _id: uidOf(req) }, { projection: { settings: 1 } });
  res.json({
    unit: u?.settings?.unit === 'lb' ? 'lb' : 'kg',
    rest_seconds: u?.settings?.rest_seconds ?? DEFAULT_REST_SECONDS,
  });
});

const DEFAULT_REST_SECONDS = 60;

/** Change one or more settings; fields left out keep their value. */
dataRouter.put('/settings', async (req, res) => {
  const b = z
    .object({
      unit: z.enum(['kg', 'lb']).optional(),
      // Rest timer after a ticked set; 0 = off.
      rest_seconds: z.number().int().min(0).max(600).optional(),
    })
    .parse(req.body);
  const set = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined).map(([k, v]) => [`settings.${k}`, v]));
  if (Object.keys(set).length) await users.updateOne({ _id: uidOf(req) }, { $set: set });
  res.status(204).end();
});

// Plans: routines -> days -> exercises

dataRouter.get('/routines', async (req, res) => {
  const uid = uidOf(req);
  res.json(await routinesFull(uid));
});

dataRouter.post('/routines', async (req, res) => {
  const b = z.object({ name: name(100) }).parse(req.body);
  res.status(201).json({ id: await insert('routines', uidOf(req), { ...b, created_at: Date.now() }) });
});

/** Create a plan with empty days. If a plan with that name exists, return it instead. */
dataRouter.post('/routines/from-template', async (req, res) => {
  const uid = uidOf(req);
  const b = z.object({ name: name(100), days: z.array(name(100)).max(14) }).parse(req.body);
  const existing = await table('routines').findOne(live(uid, { name: b.name }), {
    collation: CI,
    sort: { created_at: 1 },
    projection: { id: 1 },
  });
  if (existing) return void res.json({ id: existing.id, existed: true });
  const routineId = newId();
  await tx(async (s) => {
    await table('routines').insertOne({ ...doc(uid, { name: b.name, created_at: Date.now() }), id: routineId }, { session: s });
    if (b.days.length) {
      await table('routine_days').insertMany(
        b.days.map((d, i) => doc(uid, { routine_id: routineId, name: d, position: i })),
        { session: s }
      );
    }
  });
  res.status(201).json({ id: routineId, existed: false });
});

dataRouter.get('/routines/:id', async (req, res) => {
  const [plan] = await routinesFull(uidOf(req), pid(req));
  if (!plan) throw new HttpError(404, 'Plan not found');
  res.json(plan);
});

dataRouter.patch('/routines/:id', async (req, res) => {
  const b = z.object({ name: name(100) }).parse(req.body);
  await update('routines', uidOf(req), pid(req), b, 'Plan');
  res.status(204).end();
});

/** Delete a plan and its days. Workouts done from it are kept (they just lose the link). */
dataRouter.delete('/routines/:id', async (req, res) => {
  const uid = uidOf(req);
  const id = pid(req);
  await tx(async (s) => {
    const dayIds = (await list('routine_days', uid, { routine_id: id }, { session: s })).map((d) => d.id);
    await table('workouts').updateMany({ user_id: uid, day_id: { $in: dayIds } }, { $set: { day_id: null } }, { session: s });
    await remove('routine_day_exercises', uid, { day_id: { $in: dayIds } }, s);
    await remove('routine_days', uid, { routine_id: id }, s);
    await remove('routines', uid, { id }, s);
  });
  res.status(204).end();
});

dataRouter.post('/routines/:id/days', async (req, res) => {
  const uid = uidOf(req);
  const routineId = pid(req);
  const b = z.object({ name: name(100) }).parse(req.body);
  const [, top] = await Promise.all([
    must('routines', uid, routineId, 'Plan'),
    table('routine_days').findOne(live(uid, { routine_id: routineId }), { sort: { position: -1 }, projection: { position: 1 } }),
  ]);
  const position = top ? (top.position as number) + 1 : 0;
  res.status(201).json({ id: await insert('routine_days', uid, { routine_id: routineId, name: b.name, position }) });
});

dataRouter.patch('/days/:id', async (req, res) => {
  const b = z.object({ name: name(100) }).parse(req.body);
  await update('routine_days', uidOf(req), pid(req), b, 'Day');
  res.status(204).end();
});

dataRouter.delete('/days/:id', async (req, res) => {
  const uid = uidOf(req);
  const id = pid(req);
  await tx(async (s) => {
    await table('workouts').updateMany({ user_id: uid, day_id: id }, { $set: { day_id: null } }, { session: s });
    await remove('routine_day_exercises', uid, { day_id: id }, s);
    await remove('routine_days', uid, { id }, s);
  });
  res.status(204).end();
});

dataRouter.post('/days/:id/exercises', async (req, res) => {
  const uid = uidOf(req);
  const dayId = pid(req);
  const b = z
    .object({
      exercise_id: idSchema,
      target_sets: z.number().int().min(1).max(20).default(3),
      sets: plannedSets.optional(),
    })
    .parse(req.body);
  const [, , top, context] = await Promise.all([
    must('routine_days', uid, dayId, 'Day'),
    must('exercises', uid, b.exercise_id, 'Exercise'),
    table('routine_day_exercises').findOne(live(uid, { day_id: dayId }), { sort: { position: -1 }, projection: { position: 1 } }),
    b.sets ? null : exerciseContexts(uid, [b.exercise_id]),
  ]);
  // The plan starts as what you did last time (same set types, weights and reps), else empty working sets.
  const last = context?.get(b.exercise_id)?.last;
  const sets: PlannedSet[] =
    b.sets ??
    (last?.sets.length
      ? last.sets.slice(0, 20).map((x) => ({ kind: x.kind ?? 'normal', reps: x.reps, weight_kg: x.weight_kg }))
      : Array.from({ length: b.target_sets }, () => ({ kind: 'normal' as const, reps: 0, weight_kg: 0 })));
  const position = top ? (top.position as number) + 1 : 0;
  const id = await insert('routine_day_exercises', uid, {
    day_id: dayId,
    exercise_id: b.exercise_id,
    target_sets: sets.length,
    sets,
    position,
  });
  res.status(201).json({ id });
});

/** Reorder a day's exercises: `ids` in their new order. */
dataRouter.put('/days/:id/order', async (req, res) => {
  const uid = uidOf(req);
  const dayId = pid(req);
  const { ids } = z.object({ ids: z.array(idSchema).max(200) }).parse(req.body);
  const now = Date.now();
  if (ids.length) {
    await table('routine_day_exercises').bulkWrite(
      ids.map((id, position) => ({
        updateOne: { filter: { user_id: uid, day_id: dayId, id }, update: { $set: { position, updated_at: now } } },
      }))
    );
  }
  res.status(204).end();
});

dataRouter.patch('/day-exercises/:id', async (req, res) => {
  const b = z
    .object({ target_sets: z.number().int().min(1).max(20).optional(), sets: plannedSets.optional() })
    .refine((x) => x.target_sets !== undefined || x.sets !== undefined, 'Nothing to change')
    .parse(req.body);
  const data = b.sets ? { sets: b.sets, target_sets: b.sets.length } : { target_sets: b.target_sets };
  await update('routine_day_exercises', uidOf(req), pid(req), data, 'Exercise');
  res.status(204).end();
});

dataRouter.delete('/day-exercises/:id', async (req, res) => {
  await remove('routine_day_exercises', uidOf(req), { id: pid(req) });
  res.status(204).end();
});

// Backup file (export / restore)

const BACKUP_FIELDS: Record<TableName, string[]> = {
  exercises: ['name', 'muscle_group', 'created_at'],
  exercise_videos: ['exercise_id', 'source', 'url', 'title', 'position', 'created_at'],
  routines: ['name', 'created_at'],
  routine_days: ['routine_id', 'name', 'position'],
  routine_day_exercises: ['day_id', 'exercise_id', 'position', 'target_sets', 'sets'],
  workouts: ['date', 'notes', 'finished_at', 'title', 'day_id'],
  workout_sets: ['workout_id', 'exercise_id', 'set_number', 'reps', 'weight_kg', 'created_at', 'done', 'kind'],
};

dataRouter.get('/backup', async (req, res) => {
  const uid = uidOf(req);
  const out: Row = { app: 'gymapp', version: 3, exportedAt: Date.now() };
  for (const t of TABLE_NAMES) out[t] = await list(t, uid);
  res.json(out);
});

// Ids in older backup files are numbers; references are mapped to new ids on import.
const anyId = z.union([z.string().max(64), z.number()]).transform(String);
const ref = anyId.nullable().optional();
const num = z.number().finite();
const backupSchema = z.object({
  app: z.literal('gymapp', { message: 'This file is not a GymApp backup.' }),
  exercises: z.array(
    z.object({ id: anyId, name: z.string().trim().min(1).max(100), muscle_group: z.string().max(40).default('Other'), created_at: num.default(0) })
  ),
  exercise_videos: z
    .array(
      z.object({
        id: anyId,
        exercise_id: ref,
        source: z.string().transform((s) => (s === 'file' ? 'file' : 'youtube')),
        url: z.string().max(2000),
        title: z.string().max(200).nullish().transform((s) => s ?? ''),
        position: num.default(0),
        created_at: num.default(0),
      })
    )
    .default([]),
  routines: z.array(z.object({ id: anyId, name: z.string().max(100), created_at: num.default(0) })).default([]),
  routine_days: z.array(z.object({ id: anyId, routine_id: ref, name: z.string().max(100), position: num.default(0) })).default([]),
  routine_day_exercises: z
    .array(
      z.object({
        id: anyId,
        day_id: ref,
        exercise_id: ref,
        position: num.default(0),
        target_sets: num.default(3),
        sets: plannedSets.optional(),
      })
    )
    .default([]),
  workouts: z.array(
    z.object({
      id: anyId,
      date: num,
      notes: z.string().max(5000).nullish().transform((s) => s ?? ''),
      finished_at: num.nullish().transform((v) => v ?? null),
      title: z.string().max(100).nullish().transform((s) => s ?? ''),
      day_id: ref,
    })
  ),
  workout_sets: z.array(
    z.object({
      id: anyId,
      workout_id: ref,
      exercise_id: ref,
      set_number: num,
      reps: num,
      weight_kg: num,
      created_at: num.default(0),
      done: num.nullish().transform((v) => (v === 0 ? 0 : 1)),
      kind: z.string().nullish().transform((k) => (k === 'warmup' || k === 'drop' ? k : 'normal')),
      note: z.string().max(120).nullish().transform((s) => s ?? ''),
    })
  ),
});

/** Replace ALL of the user's data with a backup file. */
dataRouter.post('/backup', async (req, res) => {
  const uid = uidOf(req);
  const data = backupSchema.parse(req.body);
  const ids = Object.fromEntries(TABLE_NAMES.map((t) => [t, new Map<string, string>()])) as Record<TableName, Map<string, string>>;
  const docs = Object.fromEntries(TABLE_NAMES.map((t) => [t, [] as SyncedDoc[]])) as Record<TableName, SyncedDoc[]>;

  // Parents first; a row whose required parent is missing is skipped.
  const refsOf: Record<TableName, Record<string, TableName>> = {
    exercises: {},
    exercise_videos: { exercise_id: 'exercises' },
    routines: {},
    routine_days: { routine_id: 'routines' },
    routine_day_exercises: { day_id: 'routine_days', exercise_id: 'exercises' },
    workouts: { day_id: 'routine_days' },
    workout_sets: { workout_id: 'workouts', exercise_id: 'exercises' },
  };
  const optional = new Set(['workouts.day_id']);
  const names = new Map<string, string>();

  for (const t of TABLE_NAMES) {
    for (const row of data[t] as Row[]) {
      if (t === 'exercises') {
        // Same name twice in the file -> one exercise.
        const key = String(row.name).trim().toLowerCase();
        const same = names.get(key);
        if (same) {
          ids.exercises.set(row.id, same);
          continue;
        }
      }
      const out: Row = {};
      let ok = true;
      for (const f of BACKUP_FIELDS[t]) {
        const parent = refsOf[t][f];
        if (!parent) {
          out[f] = row[f];
          continue;
        }
        const mapped = row[f] != null ? ids[parent].get(String(row[f])) : undefined;
        if (!mapped && !optional.has(`${t}.${f}`)) ok = false;
        out[f] = mapped ?? null;
      }
      if (!ok) continue;
      const d = doc(uid, out);
      ids[t].set(row.id, d.id);
      if (t === 'exercises') names.set(String(row.name).trim().toLowerCase(), d.id);
      docs[t].push(d);
    }
  }

  await tx(async (s) => {
    for (const t of TABLE_NAMES) await remove(t, uid, {}, s);
    for (const t of TABLE_NAMES) if (docs[t].length) await table(t).insertMany(docs[t], { session: s });
  });
  res.json({ imported: TABLE_NAMES.reduce((n, t) => n + docs[t].length, 0) });
});
