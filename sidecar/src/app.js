/**
 * The HTTP API under /api/extensions/baby-schedule/.
 *
 * Every route except /health needs a Yuvomi session with at least `read`
 * access to ext:baby-schedule. Every state-changing route additionally needs
 * `write` access, a matching Origin and this service's CSRF token
 * (see security.js). Each successful write answers with the full new state,
 * so the page never shows a half-updated week.
 */

import { API_PREFIX } from './config.js';
import { AuthError } from './identity.js';
import {
  clientIp, csrfToken, csrfCookie, csrfValid, originAllowed, createWriteLimiter, CSRF_HEADER,
} from './security.js';
import { ConflictError, NotFoundError } from './db.js';
import { validTimeZone } from './bridge.js';
import {
  ValidationError, validDay, validDays, validEntryFields, validId, validMode, validTemplateName, LIMITS,
} from './validate.js';

const MAX_BODY_BYTES = 64 * 1024;

class HttpError extends Error {
  constructor(status, reason, message) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

const BASE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  // Lets the page tell this service's answers apart from Yuvomi's own 404,
  // which is what arrives when the proxy route to this service is missing.
  'x-baby-schedule-sidecar': '1',
};

function send(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...BASE_HEADERS, 'content-length': Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

function sendError(res, status, reason, message, extra = {}) {
  send(res, status, { error: message, code: status, reason, ...extra });
}

async function readJson(req) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (!type.startsWith('application/json')) throw new HttpError(415, 'json_required', 'Send JSON.');
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'too_large', 'The request is too large.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'too_large', 'The request is too large.');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch {
    throw new HttpError(400, 'bad_json', 'The request body is not valid JSON.');
  }
}

/** Route table: [method, pattern, handler, { write }] with :params. */
function compile(routes) {
  return routes.map(([method, pattern, handler, opts = {}]) => {
    const names = [];
    const re = new RegExp(`^${pattern.replace(/:([a-z]+)/gi, (_m, name) => { names.push(name); return '([^/]+)'; })}/?$`);
    return { method, re, names, handler, write: Boolean(opts.write) };
  });
}

const TOKEN_RE = /^yuvomi_[A-Za-z0-9_-]{20,200}$/;

function cleanLabels(raw) {
  const out = { catTitle: {}, unit: {} };
  const take = (src, dst) => {
    if (!src || typeof src !== 'object') return;
    for (const [key, value] of Object.entries(src).slice(0, 40)) {
      if (/^[a-z]{1,20}$/.test(key) && typeof value === 'string') dst[key] = value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 80);
    }
  };
  take(raw?.catTitle, out.catTitle);
  take(raw?.unit, out.unit);
  if (typeof raw?.from === 'string') out.from = raw.from.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 200);
  return out;
}

export function createApp({ config, repo, identity, bridge = null, logger = console }) {
  const limiter = createWriteLimiter(config.writesPerMinute);

  function bridgeStatus() {
    const b = repo.getBridge();
    return {
      enabled: b.enabled,
      hasToken: Boolean(b.api_token),
      timeZone: b.time_zone,
      task: b.task_id ? { title: b.task_title, date: b.task_date, time: b.task_time } : null,
      lastError: b.last_error,
      lastRunAt: b.last_run_at,
      updatedByName: b.updated_by_name,
    };
  }

  const requireAdmin = (who) => {
    if (who.role !== 'admin') throw new HttpError(403, 'admin_only', 'Only a household admin can change this.');
  };

  function state(who) {
    return {
      entries: repo.listEntries(),
      templates: repo.listTemplates(),
      revision: repo.revision(),
      access: who.level,
      user: { id: who.userId, name: who.name },
      limits: { entriesPerDay: LIMITS.entriesPerDay, templates: LIMITS.templates },
    };
  }

  const actor = (who) => ({ id: typeof who.userId === 'number' ? who.userId : null, name: who.name });

  const routes = compile([
    ['GET', '/state', ({ who }) => state(who)],
    ['GET', '/revision', () => ({ revision: repo.revision() })],

    ['POST', '/entries', ({ who, body }) => {
      const fields = validEntryFields(body.entry);
      const days = validDays(body.days);
      const ids = repo.createEntries(fields, days, actor(who));
      return { ...state(who), result: { created: ids.length, ids } };
    }, { write: true }],

    ['PATCH', '/entries/:id', ({ who, body, params }) => {
      const id = validId(params.id);
      const changes = validEntryFields(body.entry, { partial: true });
      if (changes.quantity === null && changes.unit === undefined) changes.unit = null;
      const alsoDays = body.alsoDays === undefined ? [] : validDays(body.alsoDays, 'alsoDays', { allowEmpty: true });
      const result = repo.updateEntry(id, changes, alsoDays, actor(who));
      return { ...state(who), result };
    }, { write: true }],

    ['DELETE', '/entries/:id', ({ who, params }) => {
      repo.deleteEntry(validId(params.id));
      return state(who);
    }, { write: true }],

    ['POST', '/entries/:id/move', ({ who, body, params }) => {
      repo.moveEntry(validId(params.id), validDay(body.day), actor(who));
      return state(who);
    }, { write: true }],

    ['POST', '/entries/:id/repeat', ({ who, body, params }) => {
      const created = repo.repeatEntry(validId(params.id), validDays(body.days), actor(who));
      return { ...state(who), result: { created } };
    }, { write: true }],

    ['POST', '/entries/:id/swap', ({ who, body, params }) => {
      repo.swapEntries(validId(params.id), validId(body.targetId, 'targetId'), actor(who));
      return state(who);
    }, { write: true }],

    ['POST', '/days/:day/copy', ({ who, body, params }) => {
      const created = repo.copyDay(validDay(params.day), validDays(body.targets, 'targets'), validMode(body.mode), actor(who));
      return { ...state(who), result: { created } };
    }, { write: true }],

    ['DELETE', '/days/:day', ({ who, params }) => {
      const removed = repo.clearDay(validDay(params.day));
      return { ...state(who), result: { removed } };
    }, { write: true }],

    ['DELETE', '/week', ({ who }) => {
      const removed = repo.clearWeek();
      return { ...state(who), result: { removed } };
    }, { write: true }],

    ['POST', '/bulk', ({ who, body }) => {
      if (!Array.isArray(body.entries) || !body.entries.length || body.entries.length > LIMITS.bulkEntries) {
        throw new ValidationError('entries', `Send between 1 and ${LIMITS.bulkEntries} activities.`);
      }
      const entries = body.entries.map((e) => validEntryFields(e));
      const created = repo.bulkFill(entries, validDays(body.days), validMode(body.mode), actor(who));
      return { ...state(who), result: { created } };
    }, { write: true }],

    ['POST', '/templates', ({ who, body }) => {
      const id = repo.saveTemplate(validTemplateName(body.name), actor(who));
      return { ...state(who), result: { id } };
    }, { write: true }],

    ['POST', '/templates/:id/apply', ({ who, body, params }) => {
      const created = repo.applyTemplate(validId(params.id), validMode(body.mode), actor(who));
      return { ...state(who), result: { created } };
    }, { write: true }],

    ['DELETE', '/templates/:id', ({ who, params }) => {
      repo.deleteTemplate(validId(params.id));
      return state(who);
    }, { write: true }],

    // ---- "Today at a glance" bridge settings (admin only) ----
    ['GET', '/bridge', ({ who }) => {
      requireAdmin(who);
      return bridgeStatus();
    }],

    ['PUT', '/bridge', async ({ who, body }) => {
      requireAdmin(who);
      if (!bridge) throw new HttpError(503, 'bridge_unavailable', 'The task bridge is not running.');
      const before = repo.getBridge();
      const fields = { updated_by_name: who.name, updated_at: new Date().toISOString() };

      if (body.timeZone !== undefined) {
        if (!validTimeZone(body.timeZone)) throw new ValidationError('timeZone', 'Unknown time zone.');
        fields.time_zone = body.timeZone;
      }
      if (body.labels !== undefined) fields.labels = cleanLabels(body.labels);
      if (body.token !== undefined && body.token !== '') {
        const token = String(body.token).trim();
        if (!TOKEN_RE.test(token)) throw new ValidationError('token', 'That does not look like a Yuvomi API token (it starts with "yuvomi_").');
        try {
          await bridge.testToken(token);
        } catch (err) {
          throw new HttpError(422, err.reason || 'token_invalid', err.message);
        }
        // A new token: the old task belongs to the old token's account.
        if (before.task_id && before.api_token && before.api_token !== token) {
          try { await bridge.removeTask(before.api_token, before.task_id); } catch { /* left behind, harmless */ }
          Object.assign(fields, { task_id: null, task_entry_id: null, task_date: null, task_time: null, task_title: null });
        }
        fields.api_token = token;
      }
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== 'boolean') throw new ValidationError('enabled', 'enabled must be true or false.');
        if (body.enabled && !fields.api_token && !before.api_token) {
          throw new ValidationError('token', 'Paste an API token first.');
        }
        fields.enabled = body.enabled;
      }
      repo.saveBridge(fields);
      await bridge.tick();
      return bridgeStatus();
    }, { write: true }],
  ]);

  return async function handle(req, res) {
    const started = Date.now();
    let url;
    try {
      url = new URL(req.url, 'http://sidecar.local');
    } catch {
      return sendError(res, 400, 'bad_url', 'Bad request.');
    }
    const pathname = url.pathname;

    if (pathname === `${API_PREFIX}/health` && (req.method === 'GET' || req.method === 'HEAD')) {
      return send(res, 200, { ok: true });
    }
    if (!pathname.startsWith(`${API_PREFIX}/`)) return sendError(res, 404, 'not_found', 'Not found.');

    const sub = pathname.slice(API_PREFIX.length);
    const candidates = routes.filter((r) => r.re.test(sub));
    if (!candidates.length) return sendError(res, 404, 'not_found', 'Not found.');
    const route = candidates.find((r) => r.method === req.method);
    if (!route) {
      res.setHeader('allow', candidates.map((r) => r.method).join(', '));
      return sendError(res, 405, 'method_not_allowed', 'Method not allowed.');
    }

    try {
      const ip = clientIp(req, config.trustProxyHops);
      const who = await identity.resolve(req, ip);

      // A fresh CSRF cookie on every read keeps the pair alive on iOS, which
      // may drop cookies of a resumed PWA. The token is bound to the session.
      const token = csrfToken(config.csrfSecret, who.sessionKey);
      const extraHeaders = { [CSRF_HEADER]: token };

      let body = {};
      if (route.write) {
        if (!originAllowed(req, config)) throw new HttpError(403, 'bad_origin', 'This request did not come from your Yuvomi page.');
        if (!csrfValid(req, config.csrfSecret, who.sessionKey)) {
          throw new HttpError(403, 'csrf_invalid', 'Your page is out of date. Please try again.');
        }
        if (who.level !== 'write') throw new HttpError(403, 'read_only', 'You can view the baby schedule but not change it.');
        if (!limiter.allow(String(who.userId))) throw new HttpError(429, 'rate_limited', 'Too many changes at once. Wait a moment.');
        if (req.method !== 'DELETE') body = await readJson(req);
      }

      const params = {};
      const match = sub.match(route.re);
      route.names.forEach((name, i) => { params[name] = decodeURIComponent(match[i + 1]); });

      const data = await route.handler({ who, body, params, query: url.searchParams });
      // A schedule change may change today's baby task.
      if (route.write && bridge && !sub.startsWith('/bridge')) bridge.poke();
      res.setHeader('set-cookie', csrfCookie(token, req, config));
      send(res, 200, { data }, extraHeaders);
    } catch (err) {
      if (err instanceof AuthError || err instanceof HttpError) {
        sendError(res, err.status, err.reason, err.message);
      } else if (err instanceof ValidationError) {
        sendError(res, 422, 'invalid', err.message, { field: err.field });
      } else if (err instanceof NotFoundError) {
        sendError(res, 404, 'gone', err.message);
      } else if (err instanceof ConflictError) {
        sendError(res, 409, err.reason, err.message);
      } else {
        logger.error('[baby-schedule] unexpected error', err);
        sendError(res, 500, 'server_error', 'Something went wrong in the baby schedule service.');
      }
    } finally {
      if (config.logRequests) logger.log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  };
}
