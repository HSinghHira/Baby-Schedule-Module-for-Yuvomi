/**
 * Runtime configuration, read once from the environment.
 */

import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';

export const MODULE_ID = 'baby-schedule';
export const API_PREFIX = `/api/extensions/${MODULE_ID}`;
export const PERMISSION_KEY = `ext:${MODULE_ID}`;

function intEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function listEnv(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/**
 * The secret that signs CSRF tokens. Taken from CSRF_SECRET when set,
 * otherwise generated once and kept next to the database, so tokens stay
 * valid across restarts.
 */
function loadSecret(dataDir) {
  if (process.env.CSRF_SECRET) {
    if (process.env.CSRF_SECRET.length < 32) throw new Error('CSRF_SECRET must be at least 32 characters.');
    return process.env.CSRF_SECRET;
  }
  const file = path.join(dataDir, '.csrf_secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch { /* first start */ }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function loadConfig() {
  const yuvomiUrl = String(process.env.YUVOMI_INTERNAL_URL || 'http://yuvomi:3000').replace(/\/+$/, '');
  try {
    const parsed = new URL(yuvomiUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad protocol');
  } catch {
    throw new Error('YUVOMI_INTERNAL_URL must be an http(s) URL, for example http://yuvomi:3000.');
  }

  const dataDir = path.resolve(process.env.DATA_DIR || './data');
  fs.mkdirSync(dataDir, { recursive: true });

  const household = String(process.env.HOUSEHOLD_ID || 'default').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(household)) {
    throw new Error('HOUSEHOLD_ID may contain letters, numbers, "-" and "_" (max 64 characters).');
  }

  return {
    port: intEnv('PORT', 8080, { min: 1, max: 65535 }),
    host: process.env.HOST || '0.0.0.0',
    yuvomiUrl,
    dataDir,
    dbFile: path.join(dataDir, 'baby-schedule.db'),
    household,
    // Exact origins (scheme://host[:port]) the browser may send writes from.
    // Empty: the origin is derived from the proxy headers of each request.
    allowedOrigins: listEnv('ALLOWED_ORIGINS'),
    // How many reverse proxies sit in front of this service (for the client IP).
    trustProxyHops: intEnv('TRUST_PROXY_HOPS', 1, { min: 0, max: 10 }),
    // Seconds an /auth/me answer is reused for the same session.
    authCacheSeconds: intEnv('AUTH_CACHE_SECONDS', 10, { min: 0, max: 60 }),
    authTimeoutMs: intEnv('AUTH_TIMEOUT_MS', 5000, { min: 500, max: 30000 }),
    writesPerMinute: intEnv('WRITES_PER_MINUTE', 240, { min: 10, max: 10000 }),
    secureCookies: process.env.COOKIE_SECURE === undefined ? null : process.env.COOKIE_SECURE === 'true',
    csrfSecret: loadSecret(dataDir),
    logRequests: process.env.LOG_REQUESTS === 'true',
  };
}
