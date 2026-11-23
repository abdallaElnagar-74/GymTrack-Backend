-- Users
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower ON users (lower(email));

-- Every write to a synced row takes the next value of this sequence.
-- Clients pull "everything with version > my last version".
CREATE SEQUENCE sync_version;

-- Synced tables. Common columns:
--   user_id    owner
--   id         client-generated id (uuid/hex string), unique per user
--   updated_at client timestamp (ms) of the last edit -> last-write-wins
--   deleted    tombstone flag (rows are never hard-deleted so other devices learn about deletes)
--   version    server sync version (from sync_version)
-- References between rows use the client ids (TEXT) and are intentionally not
-- foreign keys, so rows may arrive in any order from offline devices.

CREATE TABLE exercises (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id           TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  muscle_group TEXT NOT NULL DEFAULT 'Other',
  created_at   BIGINT NOT NULL DEFAULT 0,
  updated_at   BIGINT NOT NULL,
  deleted      BOOLEAN NOT NULL DEFAULT false,
  version      BIGINT NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE routines (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id         TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  deleted    BOOLEAN NOT NULL DEFAULT false,
  version    BIGINT NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE routine_days (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id         TEXT NOT NULL,
  routine_id TEXT,
  name       TEXT NOT NULL DEFAULT '',
  position   INTEGER NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  deleted    BOOLEAN NOT NULL DEFAULT false,
  version    BIGINT NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE routine_day_exercises (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  day_id      TEXT,
  exercise_id TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  target_sets INTEGER NOT NULL DEFAULT 3,
  updated_at  BIGINT NOT NULL,
  deleted     BOOLEAN NOT NULL DEFAULT false,
  version     BIGINT NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE workouts (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  date        BIGINT NOT NULL DEFAULT 0,
  notes       TEXT NOT NULL DEFAULT '',
  finished_at BIGINT,
  title       TEXT NOT NULL DEFAULT '',
  day_id      TEXT,
  updated_at  BIGINT NOT NULL,
  deleted     BOOLEAN NOT NULL DEFAULT false,
  version     BIGINT NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE workout_sets (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  workout_id  TEXT,
  exercise_id TEXT,
  set_number  INTEGER NOT NULL DEFAULT 1,
  reps        INTEGER NOT NULL DEFAULT 0,
  weight_kg   DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at  BIGINT NOT NULL DEFAULT 0,
  done        INTEGER NOT NULL DEFAULT 1,
  updated_at  BIGINT NOT NULL,
  deleted     BOOLEAN NOT NULL DEFAULT false,
  version     BIGINT NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX exercises_user_version             ON exercises (user_id, version);
CREATE INDEX routines_user_version              ON routines (user_id, version);
CREATE INDEX routine_days_user_version          ON routine_days (user_id, version);
CREATE INDEX routine_day_exercises_user_version ON routine_day_exercises (user_id, version);
CREATE INDEX workouts_user_version              ON workouts (user_id, version);
CREATE INDEX workout_sets_user_version          ON workout_sets (user_id, version);
