-- Videos attached to an exercise: a YouTube link, or a file saved on the phone that added it.
CREATE TABLE exercise_videos (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  exercise_id TEXT,
  source      TEXT NOT NULL DEFAULT 'youtube' CHECK (source IN ('youtube', 'file')),
  url         TEXT NOT NULL DEFAULT '',
  title       TEXT NOT NULL DEFAULT '',
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  BIGINT NOT NULL DEFAULT 0,
  updated_at  BIGINT NOT NULL,
  deleted     BOOLEAN NOT NULL DEFAULT false,
  version     BIGINT NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX exercise_videos_user_version ON exercise_videos (user_id, version);
