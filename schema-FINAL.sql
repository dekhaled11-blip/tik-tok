CREATE TABLE IF NOT EXISTS users (
  username              TEXT PRIMARY KEY NOT NULL,
  gold_points_weekly    INTEGER NOT NULL DEFAULT 0 CHECK (gold_points_weekly >= 0),
  silver_points_weekly  INTEGER NOT NULL DEFAULT 0 CHECK (silver_points_weekly >= 0),
  total_gold_all_time   INTEGER NOT NULL DEFAULT 0 CHECK (total_gold_all_time >= 0),
  total_silver_all_time INTEGER NOT NULL DEFAULT 0 CHECK (total_silver_all_time >= 0),
  referred_by           TEXT,
  ip                    TEXT NOT NULL,
  created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_active           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_weekly_reset     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_deleted            INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(referred_by) REFERENCES users(username) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS weekly_challenges (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  username           TEXT NOT NULL,
  challenge_targets  TEXT NOT NULL,
  completed_targets  TEXT NOT NULL DEFAULT '[]',
  claimed            INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  week_number        INTEGER NOT NULL,
  FOREIGN KEY(username) REFERENCES users(username) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS weekly_leaderboard (
  username       TEXT NOT NULL,
  week_number    INTEGER NOT NULL,
  gold_points    INTEGER NOT NULL DEFAULT 0,
  silver_points  INTEGER NOT NULL DEFAULT 0,
  rank           INTEGER,
  PRIMARY KEY(username, week_number),
  FOREIGN KEY(username) REFERENCES users(username) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_users_gold        ON users(gold_points_weekly DESC);
CREATE INDEX IF NOT EXISTS idx_users_silver      ON users(silver_points_weekly DESC);
CREATE INDEX IF NOT EXISTS idx_users_total_gold  ON users(total_gold_all_time DESC);
CREATE INDEX IF NOT EXISTS idx_users_deleted     ON users(is_deleted);
CREATE INDEX IF NOT EXISTS idx_users_active      ON users(last_active DESC);
CREATE INDEX IF NOT EXISTS idx_challenges_user   ON weekly_challenges(username);
CREATE INDEX IF NOT EXISTS idx_challenges_week   ON weekly_challenges(week_number);
CREATE INDEX IF NOT EXISTS idx_leaderboard_week  ON weekly_leaderboard(week_number);
CREATE INDEX IF NOT EXISTS idx_leaderboard_week_gold   ON weekly_leaderboard(week_number, gold_points DESC);
CREATE INDEX IF NOT EXISTS idx_leaderboard_week_silver ON weekly_leaderboard(week_number, silver_points DESC);
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at DESC);
