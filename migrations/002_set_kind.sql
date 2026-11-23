-- Set type chosen by the user: normal working set, warm-up or drop set.
ALTER TABLE workout_sets
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal'
  CHECK (kind IN ('normal', 'warmup', 'drop'));
