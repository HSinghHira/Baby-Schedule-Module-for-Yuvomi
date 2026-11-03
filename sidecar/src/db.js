/**
 * The sidecar's own SQLite database (node:sqlite, no native add-ons).
 *
 * This is NOT yuvomi.db. Yuvomi's database is private to Yuvomi; this service
 * keeps only the baby schedule, in its own file under DATA_DIR.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { LIMITS } from './validate.js';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export class ConflictError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

export class NotFoundError extends Error {
  constructor(message = 'Not found.') {
    super(message);
  }
}

/** Apply every migrations/NNN_*.sql that has not run yet, each in its own transaction. */
export function migrate(db, dir = MIGRATIONS_DIR) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  const files = fs.readdirSync(dir).filter((f) => /^\d{3}_[a-z0-9_-]+\.sql$/i.test(f)).sort();
  const ran = [];
  for (const file of files) {
    const version = Number(file.slice(0, 3));
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(version, file, new Date().toISOString());
      db.exec('COMMIT');
      ran.push(file);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${err.message}`);
    }
  }
  return ran;
}

export function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

const ENTRY_COLUMNS = `id, day, time, category, title, description, quantity, unit, notes, position,
  created_by_name, updated_by_name, created_at, updated_at`;

function rowToEntry(row) {
  return {
    id: row.id,
    day: row.day,
    time: row.time,
    category: row.category,
    title: row.title,
    description: row.description,
    quantity: row.quantity,
    unit: row.unit,
    notes: row.notes,
    position: row.position,
    createdByName: row.created_by_name,
    updatedByName: row.updated_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The fields that make two entries "the same activity" when copying or matching. */
function sameActivity(a, b) {
  return a.time === b.time && a.category === b.category && a.title === b.title
    && a.description === b.description && (a.quantity ?? null) === (b.quantity ?? null)
    && (a.unit ?? null) === (b.unit ?? null);
}

/** Fields stored in a template and copied between days. */
function portable(entry) {
  return {
    day: entry.day,
    time: entry.time,
    category: entry.category,
    title: entry.title,
    description: entry.description,
    quantity: entry.quantity ?? null,
    unit: entry.unit ?? null,
    notes: entry.notes ?? '',
    position: entry.position ?? 0,
  };
}

/**
 * All schedule data access for one household. Every statement filters on
 * `household`; there is no method that reads across households.
 */
export function createRepository(db, household) {
  const stmt = {
    listEntries: db.prepare(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE household = ?
      ORDER BY day, time, position, created_at`),
    getEntry: db.prepare(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE household = ? AND id = ?`),
    dayEntries: db.prepare(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE household = ? AND day = ?
      ORDER BY time, position, created_at`),
    countDay: db.prepare('SELECT COUNT(*) AS n FROM entries WHERE household = ? AND day = ?'),
    maxPosition: db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM entries WHERE household = ? AND day = ? AND time = ?'),
    insertEntry: db.prepare(`INSERT INTO entries (id, household, day, time, category, title, description, quantity,
      unit, notes, position, created_by, created_by_name, updated_by, updated_by_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateEntry: db.prepare(`UPDATE entries SET day = ?, time = ?, category = ?, title = ?, description = ?,
      quantity = ?, unit = ?, notes = ?, position = ?, updated_by = ?, updated_by_name = ?, updated_at = ?
      WHERE household = ? AND id = ?`),
    deleteEntry: db.prepare('DELETE FROM entries WHERE household = ? AND id = ?'),
    deleteDay: db.prepare('DELETE FROM entries WHERE household = ? AND day = ?'),
    deleteWeek: db.prepare('DELETE FROM entries WHERE household = ?'),
    revision: db.prepare('SELECT revision FROM households WHERE household = ?'),
    bump: db.prepare(`INSERT INTO households (household, revision) VALUES (?, 1)
      ON CONFLICT (household) DO UPDATE SET revision = revision + 1`),
    listTemplates: db.prepare(`SELECT id, name, entry_count, created_by_name, created_at FROM templates
      WHERE household = ? ORDER BY created_at DESC`),
    getTemplate: db.prepare('SELECT id, name, entries FROM templates WHERE household = ? AND id = ?'),
    countTemplates: db.prepare('SELECT COUNT(*) AS n FROM templates WHERE household = ?'),
    insertTemplate: db.prepare(`INSERT INTO templates (id, household, name, entries, entry_count, created_by,
      created_by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    deleteTemplate: db.prepare('DELETE FROM templates WHERE household = ? AND id = ?'),
    getBridge: db.prepare('SELECT * FROM bridge WHERE household = ?'),
    ensureBridge: db.prepare('INSERT OR IGNORE INTO bridge (household) VALUES (?)'),
    markDone: db.prepare('INSERT OR IGNORE INTO bridge_done (household, date, entry_id) VALUES (?, ?, ?)'),
    doneIds: db.prepare('SELECT entry_id FROM bridge_done WHERE household = ? AND date = ?'),
    pruneDone: db.prepare('DELETE FROM bridge_done WHERE household = ? AND date < ?'),
  };

  const BRIDGE_FIELDS = new Set(['enabled', 'api_token', 'time_zone', 'labels', 'task_id', 'task_entry_id',
    'task_date', 'task_time', 'task_title', 'last_error', 'last_run_at', 'updated_by_name', 'updated_at']);

  /** Run `fn` in one transaction and raise the household revision with it. */
  function write(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      stmt.bump.run(household);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function requireEntry(id) {
    const row = stmt.getEntry.get(household, id);
    if (!row) throw new NotFoundError('This activity no longer exists. It may have been removed on another phone.');
    return rowToEntry(row);
  }

  function ensureRoom(day, adding) {
    const { n } = stmt.countDay.get(household, day);
    if (n + adding > LIMITS.entriesPerDay) {
      throw new ConflictError('day_full', `A day can hold at most ${LIMITS.entriesPerDay} activities.`);
    }
  }

  function insert(fields, day, actor, now, position) {
    const id = crypto.randomUUID();
    const pos = position ?? stmt.maxPosition.get(household, day, fields.time).p + 1;
    stmt.insertEntry.run(
      id, household, day, fields.time, fields.category, fields.title ?? '', fields.description ?? '',
      fields.quantity ?? null, fields.unit ?? null, fields.notes ?? '', pos,
      actor.id, actor.name, actor.id, actor.name, now, now,
    );
    return id;
  }

  function update(entry, actor, now) {
    stmt.updateEntry.run(
      entry.day, entry.time, entry.category, entry.title, entry.description, entry.quantity ?? null,
      entry.unit ?? null, entry.notes, entry.position, actor.id, actor.name, now, household, entry.id,
    );
  }

  /** Add `entries` (portable fields) to each day in `days`, optionally replacing what is there. */
  function fillDays(entries, days, mode, actor, now) {
    let created = 0;
    for (const day of days) {
      if (mode === 'replace') stmt.deleteDay.run(household, day);
      const existing = mode === 'replace' ? [] : stmt.dayEntries.all(household, day).map(rowToEntry);
      const fresh = entries.filter((e) => !existing.some((x) => sameActivity(x, e)));
      ensureRoom(day, fresh.length);
      for (const e of fresh) {
        insert(e, day, actor, now);
        created += 1;
      }
    }
    return created;
  }

  return {
    revision() {
      return stmt.revision.get(household)?.revision ?? 0;
    },

    listEntries() {
      return stmt.listEntries.all(household).map(rowToEntry);
    },

    listTemplates() {
      return stmt.listTemplates.all(household).map((r) => ({
        id: r.id,
        name: r.name,
        entryCount: r.entry_count,
        createdByName: r.created_by_name,
        createdAt: r.created_at,
      }));
    },

    /** Create one activity on every day in `days`. */
    createEntries(fields, days, actor) {
      const now = new Date().toISOString();
      return write(() => {
        for (const day of days) ensureRoom(day, 1);
        return days.map((day) => insert(fields, day, actor, now));
      });
    },

    /**
     * Change one activity. With `alsoDays`, the same change goes to the
     * matching activity on those days (same time, category and name as before
     * the edit); a day without a match gets a new copy.
     */
    updateEntry(id, changes, alsoDays, actor) {
      const now = new Date().toISOString();
      return write(() => {
        const before = requireEntry(id);
        const after = { ...before, ...changes };
        if (changes.time !== undefined && changes.time !== before.time) {
          after.position = stmt.maxPosition.get(household, before.day, changes.time).p + 1;
        }
        update(after, actor, now);
        let updated = 1;
        let created = 0;
        for (const day of alsoDays.filter((d) => d !== before.day)) {
          const match = stmt.dayEntries.all(household, day).map(rowToEntry)
            .find((e) => e.time === before.time && e.category === before.category && e.title === before.title);
          if (match) {
            const next = { ...match, ...changes };
            if (next.time !== match.time) next.position = stmt.maxPosition.get(household, day, next.time).p + 1;
            update(next, actor, now);
            updated += 1;
          } else {
            ensureRoom(day, 1);
            insert(portable(after), day, actor, now);
            created += 1;
          }
        }
        return { updated, created };
      });
    },

    deleteEntry(id) {
      return write(() => {
        requireEntry(id);
        stmt.deleteEntry.run(household, id);
      });
    },

    moveEntry(id, day, actor) {
      const now = new Date().toISOString();
      return write(() => {
        const entry = requireEntry(id);
        if (entry.day === day) return;
        ensureRoom(day, 1);
        const position = stmt.maxPosition.get(household, day, entry.time).p + 1;
        update({ ...entry, day, position }, actor, now);
      });
    },

    /** Copy one activity onto other days, skipping days that already have it. */
    repeatEntry(id, days, actor) {
      const now = new Date().toISOString();
      return write(() => {
        const entry = requireEntry(id);
        return fillDays([portable(entry)], days.filter((d) => d !== entry.day), 'append', actor, now);
      });
    },

    /**
     * Swap the places of two activities on the same day. Activities at the
     * same time swap their order; otherwise they swap their times.
     */
    swapEntries(id, targetId, actor) {
      const now = new Date().toISOString();
      return write(() => {
        const a = requireEntry(id);
        const b = requireEntry(targetId);
        if (a.day !== b.day) throw new ConflictError('different_days', 'Only activities on the same day can swap places.');
        if (a.time === b.time) {
          const pa = a.position === b.position ? b.position + 1 : b.position;
          update({ ...a, position: pa }, actor, now);
          update({ ...b, position: a.position }, actor, now);
        } else {
          update({ ...a, time: b.time, position: b.position }, actor, now);
          update({ ...b, time: a.time, position: a.position }, actor, now);
        }
      });
    },

    copyDay(sourceDay, targets, mode, actor) {
      const now = new Date().toISOString();
      return write(() => {
        const source = stmt.dayEntries.all(household, sourceDay).map(rowToEntry).map(portable);
        return fillDays(source, targets.filter((d) => d !== sourceDay), mode, actor, now);
      });
    },

    /** Write a list of activities onto several days at once (example schedule, quick planning). */
    bulkFill(entries, days, mode, actor) {
      const now = new Date().toISOString();
      return write(() => fillDays(entries, days, mode, actor, now));
    },

    clearDay(day) {
      return write(() => stmt.deleteDay.run(household, day).changes);
    },

    clearWeek() {
      return write(() => stmt.deleteWeek.run(household).changes);
    },

    saveTemplate(name, actor) {
      const now = new Date().toISOString();
      return write(() => {
        if (stmt.countTemplates.get(household).n >= LIMITS.templates) {
          throw new ConflictError('too_many_templates', `You can keep at most ${LIMITS.templates} templates. Delete one first.`);
        }
        const entries = stmt.listEntries.all(household).map(rowToEntry).map(portable);
        if (!entries.length) throw new ConflictError('week_empty', 'The week has no activities to save yet.');
        const id = crypto.randomUUID();
        stmt.insertTemplate.run(id, household, name, JSON.stringify(entries), entries.length, actor.id, actor.name, now);
        return id;
      });
    },

    /** Write a template's week back. With `replace`, the whole current week is cleared first. */
    applyTemplate(id, mode, actor) {
      const now = new Date().toISOString();
      return write(() => {
        const row = stmt.getTemplate.get(household, id);
        if (!row) throw new NotFoundError('This template no longer exists.');
        const entries = JSON.parse(row.entries);
        if (mode === 'replace') stmt.deleteWeek.run(household);
        let created = 0;
        for (let day = 0; day < 7; day += 1) {
          const forDay = entries.filter((e) => e.day === day);
          if (forDay.length) created += fillDays(forDay, [day], 'append', actor, now);
        }
        return created;
      });
    },

    deleteTemplate(id) {
      return write(() => {
        if (!stmt.deleteTemplate.run(household, id).changes) throw new NotFoundError('This template no longer exists.');
      });
    },

    // ---- "Today at a glance" bridge (bridge.js). Not schedule data, so no revision bump.

    getBridge() {
      stmt.ensureBridge.run(household);
      const row = stmt.getBridge.get(household);
      let labels = {};
      try { labels = JSON.parse(row.labels || '{}'); } catch { labels = {}; }
      return { ...row, enabled: Boolean(row.enabled), labels };
    },

    /** Update some bridge fields. Column names come only from BRIDGE_FIELDS. */
    saveBridge(fields) {
      stmt.ensureBridge.run(household);
      const keys = Object.keys(fields).filter((key) => BRIDGE_FIELDS.has(key));
      if (!keys.length) return;
      const values = keys.map((key) => {
        const v = fields[key];
        if (key === 'labels') return JSON.stringify(v || {});
        if (key === 'enabled') return v ? 1 : 0;
        return v ?? null;
      });
      db.prepare(`UPDATE bridge SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE household = ?`)
        .run(...values, household);
    },

    markDone(date, entryId) {
      stmt.markDone.run(household, date, entryId);
    },

    doneIds(date) {
      stmt.pruneDone.run(household, date);
      return new Set(stmt.doneIds.all(household, date).map((r) => r.entry_id));
    },
  };
}
