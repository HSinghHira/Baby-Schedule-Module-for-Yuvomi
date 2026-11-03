/**
 * Who is calling? Answered by Yuvomi, never by the browser.
 *
 * Every request forwards the caller's Yuvomi session cookie to
 * GET /api/v1/auth/me on the internal Yuvomi URL. Only that answer decides the
 * user id, the name and the access level. A user id or role in a request body
 * is never read.
 *
 * Answers are cached for a few seconds per session (AUTH_CACHE_SECONDS),
 * because Yuvomi rate-limits /api/ per IP and polling from two phones would
 * otherwise spend that budget quickly. A sign-out takes effect after at most
 * that many seconds.
 */

import crypto from 'node:crypto';
import { PERMISSION_KEY } from './config.js';

/** Yuvomi's session cookies: current, legacy (Oikos) and wall-display. */
export const SESSION_COOKIES = Object.freeze(['yuvomi.sid', 'oikos.sid', 'yuvomi.display']);

export class AuthError extends Error {
  constructor(status, reason, message) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

export function parseCookies(header) {
  const out = new Map();
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name && !out.has(name)) out.set(name, value);
  }
  return out;
}

/**
 * The Cookie header to forward to Yuvomi: only its session cookies, nothing
 * else the browser happens to hold for this host. Empty when there is none.
 */
export function sessionCookieHeader(cookies) {
  return SESSION_COOKIES
    .filter((name) => cookies.has(name))
    .map((name) => `${name}=${cookies.get(name)}`)
    .join('; ');
}

/**
 * Turn an /auth/me answer into this module's access level.
 * Fails closed: an unknown shape or a missing permission key means no access.
 * The `ext:baby-schedule` key exists only while the module is enabled in
 * Yuvomi, so disabling the module also locks this API.
 */
export function accessFromMe(me) {
  const user = me?.user;
  if (!user || (typeof user.id !== 'number' && typeof user.id !== 'string')) {
    throw new AuthError(502, 'yuvomi_bad_answer', 'Yuvomi sent an answer this service does not understand.');
  }
  if (user.deactivated_at) throw new AuthError(403, 'account_inactive', 'This account is no longer active.');
  // A guest invited only to split expenses is not a household member.
  if (user.access_scope === 'split_guest') {
    throw new AuthError(403, 'module_forbidden', 'This account has no access to the baby schedule.');
  }
  const level = me.permissions?.modules?.[PERMISSION_KEY];
  if (level !== 'read' && level !== 'write') {
    throw new AuthError(403, 'module_forbidden', 'Your household role has no access to the baby schedule, or the module is disabled.');
  }
  return {
    userId: user.id,
    name: String(user.display_name || user.username || 'Parent').slice(0, 80),
    role: user.role === 'admin' ? 'admin' : 'member',
    level,
  };
}

export function createIdentityResolver({ yuvomiUrl, cacheSeconds, timeoutMs, fetchImpl = globalThis.fetch }) {
  const cache = new Map(); // key -> { expires, identity }
  const inflight = new Map(); // key -> Promise<identity>
  const MAX_CACHE = 1000;
  const ttl = cacheSeconds * 1000;

  async function lookup(cookieHeader, clientIp) {
    let res;
    try {
      res = await fetchImpl(`${yuvomiUrl}/api/v1/auth/me`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          cookie: cookieHeader,
          // Yuvomi rate-limits per IP: pass the caller's address on, so the
          // limit applies per phone instead of to this container for everyone.
          ...(clientIp ? { 'x-forwarded-for': clientIp } : {}),
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new AuthError(502, 'yuvomi_unreachable', 'The baby schedule cannot reach Yuvomi right now.');
    }
    if (res.status === 401) throw new AuthError(401, 'not_signed_in', 'Please sign in to Yuvomi again.');
    if (res.status === 429) throw new AuthError(503, 'yuvomi_busy', 'Yuvomi is busy. Try again in a minute.');
    if (!res.ok) throw new AuthError(502, 'yuvomi_unavailable', `Yuvomi answered ${res.status}.`);
    let body;
    try {
      body = await res.json();
    } catch {
      throw new AuthError(502, 'yuvomi_bad_answer', 'Yuvomi sent an answer this service does not understand.');
    }
    return accessFromMe(body);
  }

  return {
    /** Resolve the caller of `req`, or throw an AuthError. */
    async resolve(req, clientIp) {
      const cookieHeader = sessionCookieHeader(parseCookies(req.headers.cookie));
      if (!cookieHeader) throw new AuthError(401, 'not_signed_in', 'Please sign in to Yuvomi.');
      const key = crypto.createHash('sha256').update(cookieHeader).digest('hex');
      const now = Date.now();
      const hit = cache.get(key);
      if (hit && hit.expires > now) return { ...hit.identity, sessionKey: key };

      let pending = inflight.get(key);
      if (!pending) {
        pending = lookup(cookieHeader, clientIp).finally(() => inflight.delete(key));
        inflight.set(key, pending);
      }
      const identity = await pending;
      if (ttl > 0) {
        if (cache.size >= MAX_CACHE) {
          for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
          if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
        }
        cache.set(key, { expires: now + ttl, identity });
      }
      return { ...identity, sessionKey: key };
    },
    /** For tests. */
    clear() {
      cache.clear();
    },
  };
}
