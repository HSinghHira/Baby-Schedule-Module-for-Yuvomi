-- Baby Schedule sidecar: initial schema.
--
-- Every row carries `household`. One sidecar serves one Yuvomi installation
-- (one household), and every query filters on this column, so a second
-- household can never read or change rows that are not its own.

-- One row per scheduled activity. `day` is the weekday, 0 = Monday ... 6 = Sunday.
CREATE TABLE entries (
  id               TEXT    PRIMARY KEY,
  household        TEXT    NOT NULL,
  day              INTEGER NOT NULL CHECK (day BETWEEN 0 AND 6),
  time             TEXT    NOT NULL CHECK (time GLOB '[0-2][0-9]:[0-5][0-9]'),
  category         TEXT    NOT NULL,
  title            TEXT    NOT NULL DEFAULT '',
  description      TEXT    NOT NULL DEFAULT '',
  quantity         REAL,
  unit             TEXT,
  notes            TEXT    NOT NULL DEFAULT '',
  -- Tie-breaker for activities at the same time; the list is sorted by time first.
  position         INTEGER NOT NULL DEFAULT 0,
  created_by       INTEGER,
  created_by_name  TEXT,
  updated_by       INTEGER,
  updated_by_name  TEXT,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);

CREATE INDEX idx_entries_household_day ON entries (household, day, time, position);

-- A saved copy of a whole week. `entries` is a JSON array of entry fields
-- (without ids); applying a template writes fresh rows from it.
CREATE TABLE templates (
  id               TEXT    PRIMARY KEY,
  household        TEXT    NOT NULL,
  name             TEXT    NOT NULL,
  entries          TEXT    NOT NULL,
  entry_count      INTEGER NOT NULL,
  created_by       INTEGER,
  created_by_name  TEXT,
  created_at       TEXT    NOT NULL
);

CREATE INDEX idx_templates_household ON templates (household, created_at);

-- A change counter per household. Every write raises it, and the browser
-- polls it to pick up the other parent's changes.
CREATE TABLE households (
  household        TEXT    PRIMARY KEY,
  revision         INTEGER NOT NULL DEFAULT 0
);
