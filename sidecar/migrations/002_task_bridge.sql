-- "Today at a glance" bridge: keeps one Yuvomi task for the baby's current or
-- next activity. Settings per household, plus which activities were ticked off.

CREATE TABLE bridge (
  household        TEXT    PRIMARY KEY,
  enabled          INTEGER NOT NULL DEFAULT 0,
  -- Yuvomi API token with tasks:write. Never sent back to the browser.
  api_token        TEXT,
  time_zone        TEXT    NOT NULL DEFAULT 'UTC',
  -- Category titles and unit names in the household's language (JSON).
  labels           TEXT    NOT NULL DEFAULT '{}',
  -- The task currently shown in Yuvomi, and which activity it stands for.
  task_id          INTEGER,
  task_entry_id    TEXT,
  task_date        TEXT,
  task_time        TEXT,
  task_title       TEXT,
  last_error       TEXT,
  last_run_at      TEXT,
  updated_by_name  TEXT,
  updated_at       TEXT
);

-- Activities already handled today (ticked off, or removed by someone).
CREATE TABLE bridge_done (
  household        TEXT    NOT NULL,
  date             TEXT    NOT NULL,
  entry_id         TEXT    NOT NULL,
  PRIMARY KEY (household, date, entry_id)
);
