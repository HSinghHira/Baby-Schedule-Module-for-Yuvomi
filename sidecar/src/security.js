/**
 * Request protection for state-changing routes.
 *
 * Yuvomi's own CSRF token protects Yuvomi's endpoints, not this service's.
 * A write here must therefore pass, in this order:
 *   1. a valid Yuvomi session (identity.js),
 *   2. an Origin header that matches the public host,
 *   3. this service's own CSRF token, as cookie AND header (double submit),
 *      where the token is an HMAC of the session, so it cannot be planted,
 *   4. `write` access to ext:baby-schedule (routes.js).
 */

import crypto from 'node:crypto';
import { API_PREFIX } from './config.js';
import { parseCookies } from './identity.js';

export const CSRF_COOKIE = 'bs_csrf';
export const CSRF_HEADER = 'x-baby-schedule-csrf';

function firstHeader(req, name) {
  const value = req.headers[name];
  return String(Array.isArray(value) ? value[0] : value || '').split(',')[0].trim();
}

/** The caller's address, read from X-Forwarded-For as far as the proxies are trusted. */
export function clientIp(req, trustProxyHops) {
  const socketIp = req.socket?.remoteAddress || '';
  if (!trustProxyHops) return socketIp;
  const chain = String(req.headers['x-forwarded-for'] || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!chain.length) return socketIp;
  // Each trusted proxy appends the address it saw; the one `hops` from the end
  // is the address our outermost trusted proxy received the request from.
  return chain[Math.max(0, chain.length - trustProxyHops)] || socketIp;
}

export function requestProto(req) {
  const forwarded = firstHeader(req, 'x-forwarded-proto').toLowerCase();
  if (forwarded === 'https' || forwarded === 'http') return forwarded;
  return req.socket?.encrypted ? 'https' : 'http';
}

/** The origins a write may come from. */
export function allowedOrigins(req, config) {
  if (config.allowedOrigins.length) return config.allowedOrigins;
  const host = firstHeader(req, 'x-forwarded-host') || firstHeader(req, 'host');
  return host ? [`${requestProto(req)}://${host}`] : [];
}

export function originAllowed(req, config) {
  // A browser marks cross-site requests; refuse them before looking further.
  const site = firstHeader(req, 'sec-fetch-site');
  if (site && site !== 'same-origin') return false;
  const origin = firstHeader(req, 'origin').replace(/\/+$/, '');
  if (!origin || origin === 'null') return false;
  return allowedOrigins(req, config).includes(origin);
}

export function csrfToken(secret, sessionKey) {
  return crypto.createHmac('sha256', secret).update(`baby-schedule-csrf:${sessionKey}`).digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function csrfValid(req, secret, sessionKey) {
  const expected = csrfToken(secret, sessionKey);
  const header = firstHeader(req, CSRF_HEADER);
  const cookie = parseCookies(req.headers.cookie).get(CSRF_COOKIE) || '';
  return safeEqual(header, expected) && safeEqual(cookie, expected);
}

export function csrfCookie(token, req, config) {
  const secure = config.secureCookies ?? requestProto(req) === 'https';
  return [
    `${CSRF_COOKIE}=${token}`,
    `Path=${API_PREFIX}`,
    'SameSite=Strict',
    `Max-Age=${60 * 60 * 24 * 30}`,
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

/** A small fixed-window counter per user for writes. */
export function createWriteLimiter(perMinute) {
  const windows = new Map(); // userKey -> { start, count }
  return {
    allow(userKey) {
      const now = Date.now();
      const w = windows.get(userKey);
      if (!w || now - w.start >= 60000) {
        if (windows.size > 5000) windows.clear();
        windows.set(userKey, { start: now, count: 1 });
        return true;
      }
      w.count += 1;
      return w.count <= perMinute;
    },
  };
}
