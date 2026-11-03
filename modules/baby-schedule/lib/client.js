/**
 * Client for the Baby Schedule sidecar at /api/extensions/baby-schedule/.
 *
 * `/api.js` only talks to Yuvomi's own /api/v1, so this is a small fetch
 * wrapper of its own. The session cookie goes along automatically (same
 * origin). The sidecar's CSRF token arrives in a response header on every
 * call and is held in memory only; the matching cookie is set by the sidecar.
 */

const BASE = '/api/extensions/baby-schedule';
const CSRF_HEADER = 'x-baby-schedule-csrf';

export class SidecarError extends Error {
  constructor(status, reason, message) {
    super(message || `Request failed (${status})`);
    this.status = status;
    this.reason = reason || null;
  }
}

let csrfToken = '';

async function call(method, path, body, { signal, retried = false } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers[CSRF_HEADER] = csrfToken;

  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new SidecarError(0, 'offline', null);
  }

  // Not from the sidecar: the reverse proxy has no route to it, so Yuvomi (or
  // the proxy) answered instead - Yuvomi sends a JSON 404 for unknown /api/ paths.
  if (!res.headers.get('x-baby-schedule-sidecar')) {
    throw new SidecarError(res.status, res.status === 404 ? 'not_installed' : 'unreachable', null);
  }

  const token = res.headers.get(CSRF_HEADER);
  if (token) csrfToken = token;

  let json = null;
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    try { json = await res.json(); } catch { json = null; }
  }

  if (!res.ok) {
    if (!json) throw new SidecarError(res.status, 'unreachable', null);
    // A stale token (iOS dropped the cookie, or the session changed): one
    // fresh read sets a new pair, then the write is tried once more.
    if (json.reason === 'csrf_invalid' && !retried) {
      await call('GET', '/revision', undefined, { signal });
      return call(method, path, body, { signal, retried: true });
    }
    throw new SidecarError(res.status, json.reason, json.error);
  }
  return json?.data;
}

export const sidecar = {
  state: (opts) => call('GET', '/state', undefined, opts),
  revision: (opts) => call('GET', '/revision', undefined, opts),

  createEntry: (entry, days) => call('POST', '/entries', { entry, days }),
  updateEntry: (id, entry, alsoDays = []) => call('PATCH', `/entries/${encodeURIComponent(id)}`, { entry, alsoDays }),
  deleteEntry: (id) => call('DELETE', `/entries/${encodeURIComponent(id)}`),
  moveEntry: (id, day) => call('POST', `/entries/${encodeURIComponent(id)}/move`, { day }),
  repeatEntry: (id, days) => call('POST', `/entries/${encodeURIComponent(id)}/repeat`, { days }),
  swapEntries: (id, targetId) => call('POST', `/entries/${encodeURIComponent(id)}/swap`, { targetId }),

  copyDay: (day, targets, mode) => call('POST', `/days/${day}/copy`, { targets, mode }),
  clearDay: (day) => call('DELETE', `/days/${day}`),
  clearWeek: () => call('DELETE', '/week'),
  bulk: (entries, days, mode) => call('POST', '/bulk', { entries, days, mode }),

  saveTemplate: (name) => call('POST', '/templates', { name }),
  applyTemplate: (id, mode) => call('POST', `/templates/${encodeURIComponent(id)}/apply`, { mode }),
  deleteTemplate: (id) => call('DELETE', `/templates/${encodeURIComponent(id)}`),
};
