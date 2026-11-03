/**
 * "Today at a glance" bridge.
 *
 * Yuvomi's "Today at a glance" and Wall Mode take no rows from modules, but
 * they do show open tasks due today. So this keeps exactly ONE Yuvomi task for
 * the baby: the current or next activity of today's schedule.
 *
 *   - Someone ticks it off (phone, Tasks page, wall tablet): the activity counts
 *     as done for today, the task is removed, the next activity becomes the task.
 *   - Nobody ticks it, and the following activity's time arrives: it moves on.
 *   - The schedule changes: the task is replaced if it no longer matches.
 *
 * Works without anyone having Yuvomi open, so it uses an API token (tasks:write)
 * that an admin pastes into the module's settings. The token is stored here and
 * never sent back to a browser. Runs every 30 seconds and right after edits.
 */

import { minutesOfTime } from './time.js';

const EMOJI = {
  wake: '🌅', milk: '🍼', water: '💧', breakfast: '🥣', lunch: '🍲', dinner: '🍽️',
  fruits: '🍐', vegetables: '🥕', snacks: '🍌', sleep: '😴', activity: '🧸', other: '📝',
};
const DEFAULT_TITLES = {
  wake: 'Wake up', milk: 'Milk bottle', water: 'Water', breakfast: 'Breakfast', lunch: 'Lunch',
  dinner: 'Dinner', fruits: 'Fruit', vegetables: 'Vegetables', snacks: 'Snack', sleep: 'Sleep',
  activity: 'Activity', other: 'Other',
};
const DEFAULT_UNITS = { ml: 'ml', oz: 'oz', g: 'g', pcs: 'pieces', tsp: 'tsp', tbsp: 'tbsp', cup: 'cups', min: 'min', h: 'hours' };

export class BridgeError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

/** Date, Monday-based weekday and minute of the day in a time zone. */
export function localNow(timeZone, date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    weekday: 'short', hourCycle: 'h23',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday);
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    weekday,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return typeof tz === 'string' && tz.length <= 64;
  } catch {
    return false;
  }
}

/**
 * Which of today's activities should be the task now: the first one not yet
 * done whose successor (the next activity at a later time) has not started.
 */
export function pickTarget(dayEntries, doneIds, nowMinutes) {
  for (let i = 0; i < dayEntries.length; i += 1) {
    const e = dayEntries[i];
    if (doneIds.has(e.id)) continue;
    const start = minutesOfTime(e.time);
    const successor = dayEntries.slice(i + 1).find((x) => minutesOfTime(x.time) > start);
    if (successor && minutesOfTime(successor.time) <= nowMinutes) continue;
    return e;
  }
  return null;
}

export function taskTitle(entry, labels = {}) {
  const name = entry.title || labels.catTitle?.[entry.category] || DEFAULT_TITLES[entry.category] || 'Baby';
  const unit = entry.unit ? (labels.unit?.[entry.unit] || DEFAULT_UNITS[entry.unit] || entry.unit) : '';
  const qty = typeof entry.quantity === 'number' ? `${Math.round(entry.quantity * 100) / 100}${unit ? ` ${unit}` : ''}` : '';
  return `${EMOJI[entry.category] || '👶'} ${name}${qty ? ` · ${qty}` : ''}`.slice(0, 200);
}

function taskDescription(entry, labels = {}) {
  return [entry.description, entry.notes, labels.from || 'From the Baby Schedule. Tick it off and the next activity appears.']
    .filter(Boolean).join('\n\n').slice(0, 2000);
}

export function createTaskBridge({ repo, yuvomiUrl, fetchImpl = globalThis.fetch, now = () => new Date(), logger = console, timeoutMs = 8000 }) {
  let running = false;
  let again = false;
  let pokeTimer = null;
  let interval = null;

  async function call(token, method, path, body) {
    let res;
    try {
      res = await fetchImpl(`${yuvomiUrl}/api/v1${path}`, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new BridgeError('yuvomi_unreachable', 'Yuvomi did not answer.');
    }
    if (res.status === 401) throw new BridgeError('token_invalid', 'The API token is not valid (any more).');
    if (res.status === 403) throw new BridgeError('token_forbidden', 'The API token may not change tasks, or the Tasks module is switched off.');
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, ok: res.ok, data: json?.data ?? json };
  }

  /** Check a token before it is saved. */
  async function testToken(token) {
    const r = await call(token, 'GET', '/tasks?limit=1');
    if (!r.ok) throw new BridgeError('yuvomi_unavailable', `Yuvomi answered ${r.status}.`);
  }

  async function removeTask(token, id) {
    if (!id) return;
    const r = await call(token, 'DELETE', `/tasks/${id}`);
    if (!r.ok && r.status !== 404) throw new BridgeError('yuvomi_unavailable', `Removing the task failed (${r.status}).`);
  }

  const clearTask = { task_id: null, task_entry_id: null, task_date: null, task_time: null, task_title: null };

  async function runOnce() {
    const b = repo.getBridge();
    const stamp = now().toISOString();

    if (!b.enabled || !b.api_token) {
      // Switched off: take our task out of Yuvomi if one is left.
      if (b.task_id && b.api_token) {
        try { await removeTask(b.api_token, b.task_id); } catch { /* try again next time */ return; }
      }
      if (b.task_id) repo.saveBridge(clearTask);
      return;
    }

    try {
      const { dateKey, weekday, minutes } = localNow(b.time_zone || 'UTC', now());
      let current = b.task_id ? { ...b } : null;

      // 1. Was the task ticked off, or removed by someone?
      if (current) {
        const r = await call(b.api_token, 'GET', `/tasks/${current.task_id}`);
        const gone = r.status === 404;
        const done = r.ok && r.data?.status === 'done';
        if (gone || done) {
          if (current.task_date === dateKey && current.task_entry_id) repo.markDone(dateKey, current.task_entry_id);
          if (done) await removeTask(b.api_token, current.task_id); // keep the Tasks list clean
          repo.saveBridge(clearTask);
          current = null;
        } else if (!r.ok) {
          throw new BridgeError('yuvomi_unavailable', `Yuvomi answered ${r.status}.`);
        }
      }

      // 2. What should the task be now?
      const today = repo.listEntries()
        .filter((e) => e.day === weekday)
        .sort((x, y) => minutesOfTime(x.time) - minutesOfTime(y.time) || x.position - y.position);
      const target = pickTarget(today, repo.doneIds(dateKey), minutes);
      const wantTitle = target ? taskTitle(target, b.labels) : null;

      // 3. Replace a task that no longer matches.
      if (current && (!target || current.task_entry_id !== target.id || current.task_date !== dateKey
        || current.task_time !== target.time || current.task_title !== wantTitle)) {
        await removeTask(b.api_token, current.task_id);
        repo.saveBridge(clearTask);
        current = null;
      }

      // 4. Create the task for the target.
      if (!current && target) {
        const r = await call(b.api_token, 'POST', '/tasks', {
          title: wantTitle,
          description: taskDescription(target, b.labels),
          due_date: dateKey,
          due_time: target.time,
          priority: 'none',
          points: 0,
          visibility: 'all',
        });
        if (!r.ok || !r.data?.id) throw new BridgeError('yuvomi_unavailable', `Creating the task failed (${r.status}).`);
        repo.saveBridge({
          task_id: r.data.id, task_entry_id: target.id, task_date: dateKey, task_time: target.time, task_title: wantTitle,
        });
      }

      repo.saveBridge({ last_error: null, last_run_at: stamp });
    } catch (err) {
      const reason = err instanceof BridgeError ? err.reason : 'internal';
      if (!(err instanceof BridgeError)) logger.error('[baby-schedule] bridge failed', err);
      repo.saveBridge({ last_error: reason, last_run_at: stamp });
    }
  }

  /** One pass at a time; a request during a pass runs one more pass after it. */
  async function tick() {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        await runOnce();
      } while (again);
    } finally {
      running = false;
    }
  }

  return {
    tick,
    testToken,
    removeTask,
    /** Run soon (after schedule edits), without blocking the request. */
    poke() {
      clearTimeout(pokeTimer);
      pokeTimer = setTimeout(() => { tick().catch(() => {}); }, 300);
      pokeTimer.unref?.();
    },
    start(everyMs = 30000) {
      interval = setInterval(() => { tick().catch(() => {}); }, everyMs);
      interval.unref?.();
      tick().catch(() => {});
    },
    stop() {
      clearInterval(interval);
      clearTimeout(pokeTimer);
    },
  };
}
