import { z } from 'zod';

const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'invalid id');
const ref = id.nullable().optional();
const ms = z.number().int().nonnegative().max(8.64e15);
const text = (max: number) => z.string().max(max);

/** Columns common to every synced row. */
const base = {
  id,
  updated_at: ms,
  deleted: z.boolean().optional().default(false),
};

/**
 * Synced tables, in dependency order (parents first).
 * `columns` are the data columns (besides id/updated_at/deleted) stored for the row.
 */
export const TABLES = {
  exercises: {
    columns: ['name', 'muscle_group', 'created_at'],
    schema: z.object({
      ...base,
      name: text(100).default(''),
      muscle_group: text(40).default('Other'),
      created_at: ms.default(0),
    }),
  },
  exercise_videos: {
    columns: ['exercise_id', 'source', 'url', 'title', 'position', 'created_at'],
    schema: z.object({
      ...base,
      exercise_id: ref,
      source: z.enum(['youtube', 'file']).default('youtube'),
      // YouTube link, or the uri of a file stored on the phone that added it (the file itself is not uploaded)
      url: text(2000).default(''),
      title: text(200).default(''),
      position: z.number().int().min(0).max(1000).default(0),
      created_at: ms.default(0),
    }),
  },
  routines: {
    columns: ['name', 'created_at'],
    schema: z.object({ ...base, name: text(100).default(''), created_at: ms.default(0) }),
  },
  routine_days: {
    columns: ['routine_id', 'name', 'position'],
    schema: z.object({
      ...base,
      routine_id: ref,
      name: text(100).default(''),
      position: z.number().int().min(0).max(1000).default(0),
    }),
  },
  routine_day_exercises: {
    columns: ['day_id', 'exercise_id', 'position', 'target_sets'],
    schema: z.object({
      ...base,
      day_id: ref,
      exercise_id: ref,
      position: z.number().int().min(0).max(1000).default(0),
      target_sets: z.number().int().min(1).max(50).default(3),
    }),
  },
  workouts: {
    columns: ['date', 'notes', 'finished_at', 'title', 'day_id'],
    schema: z.object({
      ...base,
      date: ms.default(0),
      notes: text(5000).default(''),
      finished_at: ms.nullable().optional(),
      title: text(100).default(''),
      day_id: ref,
    }),
  },
  workout_sets: {
    columns: ['workout_id', 'exercise_id', 'set_number', 'reps', 'weight_kg', 'created_at', 'done', 'kind'],
    schema: z.object({
      ...base,
      workout_id: ref,
      exercise_id: ref,
      set_number: z.number().int().min(0).max(1000).default(1),
      reps: z.number().int().min(0).max(100000).default(0),
      weight_kg: z.number().min(0).max(100000).default(0),
      created_at: ms.default(0),
      done: z.number().int().min(0).max(1).default(1),
      kind: z.enum(['normal', 'warmup', 'drop']).default('normal'),
    }),
  },
} as const;

export type TableName = keyof typeof TABLES;
export const TABLE_NAMES = Object.keys(TABLES) as TableName[];

/** Children to tombstone when a parent row is deleted: [childTable, foreignKeyColumn]. */
export const CASCADES: Partial<Record<TableName, [TableName, string][]>> = {
  exercises: [
    ['workout_sets', 'exercise_id'],
    ['routine_day_exercises', 'exercise_id'],
    ['exercise_videos', 'exercise_id'],
  ],
  routines: [['routine_days', 'routine_id']],
  routine_days: [['routine_day_exercises', 'day_id']],
  workouts: [['workout_sets', 'workout_id']],
};

const MAX_ROWS_PER_PUSH = 5000;

export const pushSchema = z
  .object({
    changes: z.object(
      Object.fromEntries(TABLE_NAMES.map((t) => [t, z.array(TABLES[t].schema).optional().default([])])) as {
        [K in TableName]: z.ZodDefault<z.ZodOptional<z.ZodArray<(typeof TABLES)[K]['schema']>>>;
      }
    ),
  })
  .refine(
    (b) => TABLE_NAMES.reduce((n, t) => n + b.changes[t].length, 0) <= MAX_ROWS_PER_PUSH,
    `At most ${MAX_ROWS_PER_PUSH} rows per push`
  );

export type PushBody = z.infer<typeof pushSchema>;
