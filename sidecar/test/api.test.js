/**
 * End-to-end tests: a mock Yuvomi answers /api/v1/auth/me, the real sidecar
 * app runs on a real HTTP server with a real SQLite file.
 *
 *   node --test test/
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createRepository } from '../src/db.js';
import { createIdentityResolver } from '../src/identity.js';
import { createApp } from '../src/app.js';

const ORIGIN = 'https://home.example';
const PREFIX = '/api/extensions/baby-schedule';

// --- mock Yuvomi -----------------------------------------------------------
const accounts = {
  'sid-anna': { user: { id: 1, username: 'anna', display_name: 'Anna', role: 'admin', access_scope: 'family' }, permissions: { admin: true, modules: { 'ext:baby-schedule': 'write' } } },
  'sid-ben': { user: { id: 2, username: 'ben', display_name: 'Ben', role: 'member', access_scope: 'family' }, permissions: { admin: false, modules: { 'ext:baby-schedule': 'write' } } },
  'sid-grandma': { user: { id: 3, username: 'oma', display_name: 'Grandma', role: 'member', access_scope: 'family' }, permissions: { admin: false, modules: { 'ext:baby-schedule': 'read' } } },
  'sid-kid': { user: { id: 4, username: 'kid', display_name: 'Kid', role: 'member', access_scope: 'family' }, permissions: { admin: false, modules: { 'ext:baby-schedule': 'none' } } },
  'sid-guest': { user: { id: 5, username: 'guest', display_name: 'Guest', role: 'member', access_scope: 'split_guest' }, permissions: { admin: false, modules: { 'ext:baby-schedule': 'write' } } },
  // Module disabled in Yuvomi: the permission key is missing altogether.
  'sid-disabled': { user: { id: 6, username: 'x', display_name: 'X', role: 'admin', access_scope: 'family' }, permissions: { admin: true, modules: {} } },
};
const seenByYuvomi = [];
let yuvomiDown = false;

const yuvomi = http.createServer((req, res) => {
  seenByYuvomi.push({ cookie: req.headers.cookie, xff: req.headers['x-forwarded-for'] });
  if (yuvomiDown) { res.writeHead(500); return res.end(); }
  const sid = /(?:^|;\s*)yuvomi\.sid=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  const me = accounts[sid];
  if (req.url !== '/api/v1/auth/me' || !me) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end('{"error":"Not signed in"}');
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(me));
});

// --- sidecar ---------------------------------------------------------------
let dataDir;
let db;
let sidecar;
let base;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

before(async () => {
  const yPort = await listen(yuvomi);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baby-schedule-test-'));
  db = openDatabase(path.join(dataDir, 'test.db'));
  const config = {
    allowedOrigins: [ORIGIN],
    trustProxyHops: 1,
    writesPerMinute: 1000,
    secureCookies: true,
    csrfSecret: 'test-secret-test-secret-test-secret-1234',
    logRequests: false,
  };
  const identity = createIdentityResolver({ yuvomiUrl: `http://127.0.0.1:${yPort}`, cacheSeconds: 0, timeoutMs: 2000 });
  const handle = createApp({ config, repo: createRepository(db, 'default'), identity, logger: { error() {}, log() {} } });
  sidecar = http.createServer((req, res) => { handle(req, res); });
  base = `http://127.0.0.1:${await listen(sidecar)}${PREFIX}`;
});

after(() => {
  sidecar.close();
  yuvomi.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** A browser for one Yuvomi account: keeps the session and the CSRF pair. */
function browser(sid) {
  let csrf = '';
  async function call(method, route, body, { origin = ORIGIN, withCsrf = true, headers = {} } = {}) {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: {
        cookie: [`yuvomi.sid=${sid}`, 'other=keep-me-private', csrf && withCsrf ? `bs_csrf=${csrf}` : ''].filter(Boolean).join('; '),
        ...(origin ? { origin } : {}),
        ...(csrf && withCsrf ? { 'x-baby-schedule-csrf': csrf } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        'x-forwarded-for': '203.0.113.7',
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const token = res.headers.get('x-baby-schedule-csrf');
    if (token) csrf = token;
    const json = await res.json();
    return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
  }
  return {
    call,
    get: (r) => call('GET', r),
    post: (r, b = {}) => call('POST', r, b),
    patch: (r, b = {}) => call('PATCH', r, b),
    del: (r) => call('DELETE', r),
    get csrf() { return csrf; },
  };
}

const anna = browser('sid-anna');
const ben = browser('sid-ben');
const bottle = { time: '07:15', category: 'milk', title: '', description: 'Formula', quantity: 120, unit: 'ml', notes: '' };

test('health needs no session', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  // The page uses this header to tell the sidecar from Yuvomi's own 404.
  assert.equal(res.headers.get('x-baby-schedule-sidecar'), '1');
  assert.equal((await fetch(`${base}/state`)).headers.get('x-baby-schedule-sidecar'), '1');
});

test('no session, unknown session: 401', async () => {
  const res = await fetch(`${base}/state`);
  assert.equal(res.status, 401);
  const stranger = browser('sid-nobody');
  assert.equal((await stranger.get('/state')).status, 401);
});

test('first read returns an empty week and a CSRF cookie bound to the path', async () => {
  const r = await anna.get('/state');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.data.entries, []);
  assert.equal(r.json.data.access, 'write');
  assert.equal(r.json.data.user.name, 'Anna');
  assert.match(r.setCookie, /bs_csrf=[0-9a-f]{64}; Path=\/api\/extensions\/baby-schedule; SameSite=Strict/);
  assert.match(r.setCookie, /Secure/);
});

test('only session cookies and the client address are forwarded to Yuvomi', () => {
  const last = seenByYuvomi.at(-1);
  assert.equal(last.cookie, 'yuvomi.sid=sid-anna');
  assert.equal(last.xff, '203.0.113.7');
});

test('writes need a matching Origin', async () => {
  await anna.get('/state');
  assert.equal((await anna.call('POST', '/entries', { entry: bottle, days: [0] }, { origin: null })).json.reason, 'bad_origin');
  assert.equal((await anna.call('POST', '/entries', { entry: bottle, days: [0] }, { origin: 'https://evil.example' })).json.reason, 'bad_origin');
  assert.equal((await anna.call('POST', '/entries', { entry: bottle, days: [0] }, { headers: { 'sec-fetch-site': 'cross-site' } })).json.reason, 'bad_origin');
});

test('writes need the CSRF token as header and cookie', async () => {
  const r = await anna.call('POST', '/entries', { entry: bottle, days: [0] }, { withCsrf: false });
  assert.equal(r.status, 403);
  assert.equal(r.json.reason, 'csrf_invalid');
});

test("one parent's CSRF token does not work for the other parent's session", async () => {
  await anna.get('/state');
  const res = await fetch(`${base}/entries`, {
    method: 'POST',
    headers: {
      cookie: `yuvomi.sid=sid-ben; bs_csrf=${anna.csrf}`,
      origin: ORIGIN,
      'x-baby-schedule-csrf': anna.csrf,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ entry: bottle, days: [0] }),
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).reason, 'csrf_invalid');
});

test('add an activity to several days; the other parent sees it', async () => {
  const r = await anna.post('/entries', { entry: bottle, days: [0, 1, 2] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.data.result.created, 3);
  assert.equal(r.json.data.entries.length, 3);
  assert.equal(r.json.data.entries[0].createdByName, 'Anna');

  const seen = await ben.get('/state');
  assert.equal(seen.json.data.entries.length, 3);
  assert.deepEqual(seen.json.data.entries.map((e) => e.day), [0, 1, 2]);
});

test('entries come back sorted by time', async () => {
  await ben.get('/state');
  await ben.post('/entries', { entry: { time: '06:45', category: 'wake', title: 'Wake up' }, days: [0] });
  await ben.post('/entries', { entry: { time: '09:30', category: 'sleep', title: 'Morning nap', quantity: 1, unit: 'h' }, days: [0] });
  const monday = (await ben.get('/state')).json.data.entries.filter((e) => e.day === 0);
  assert.deepEqual(monday.map((e) => e.time), ['06:45', '07:15', '09:30']);
  assert.equal(monday[2].updatedByName, 'Ben');
});

test('validation: bad time, unknown category, too long text, bad day', async () => {
  await anna.get('/state');
  assert.equal((await anna.post('/entries', { entry: { ...bottle, time: '25:00' }, days: [0] })).status, 422);
  assert.equal((await anna.post('/entries', { entry: { ...bottle, category: 'pizza' }, days: [0] })).status, 422);
  assert.equal((await anna.post('/entries', { entry: { ...bottle, title: 'x'.repeat(81) }, days: [0] })).status, 422);
  assert.equal((await anna.post('/entries', { entry: bottle, days: [7] })).status, 422);
  assert.equal((await anna.post('/entries', { entry: bottle, days: [] })).status, 422);
  assert.equal((await anna.post('/entries', { entry: { ...bottle, unit: 'litres' }, days: [0] })).status, 422);
  const bad = await anna.call('POST', '/entries', undefined, { headers: { 'content-type': 'text/plain' } });
  assert.equal(bad.status, 415);
});

test('edit changes only the chosen day unless more days are picked', async () => {
  const s = (await anna.get('/state')).json.data;
  const mon = s.entries.find((e) => e.day === 0 && e.category === 'milk');
  let r = await anna.patch(`/entries/${mon.id}`, { entry: { quantity: 150 } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const after1 = r.json.data.entries.filter((e) => e.category === 'milk');
  assert.deepEqual(after1.map((e) => e.quantity), [150, 120, 120]);
  assert.equal(after1[0].unit, 'ml');

  // Same change on Tuesday (has a match) and Thursday (gets a copy).
  r = await anna.patch(`/entries/${mon.id}`, { entry: { quantity: 160, notes: 'Warm' }, alsoDays: [1, 3] });
  assert.deepEqual(r.json.data.result, { updated: 2, created: 1 });
  const milk = r.json.data.entries.filter((e) => e.category === 'milk');
  assert.deepEqual(milk.map((e) => [e.day, e.quantity]), [[0, 160], [1, 160], [2, 120], [3, 160]]);
});

test('clearing the amount clears the unit', async () => {
  const s = (await anna.get('/state')).json.data;
  const nap = s.entries.find((e) => e.category === 'sleep');
  const r = await anna.patch(`/entries/${nap.id}`, { entry: { quantity: null } });
  const after = r.json.data.entries.find((e) => e.id === nap.id);
  assert.equal(after.quantity, null);
  assert.equal(after.unit, null);
});

test('move an activity to another day', async () => {
  const s = (await anna.get('/state')).json.data;
  const nap = s.entries.find((e) => e.category === 'sleep');
  const r = await anna.post(`/entries/${nap.id}/move`, { day: 5 });
  assert.equal(r.json.data.entries.find((e) => e.id === nap.id).day, 5);
});

test('repeat an activity on other days skips days that already have it', async () => {
  const s = (await anna.get('/state')).json.data;
  const wake = s.entries.find((e) => e.category === 'wake');
  let r = await anna.post(`/entries/${wake.id}/repeat`, { days: [0, 1, 2, 3, 4, 5, 6] });
  assert.equal(r.json.data.result.created, 6);
  r = await anna.post(`/entries/${wake.id}/repeat`, { days: [1, 2] });
  assert.equal(r.json.data.result.created, 0);
  assert.equal(r.json.data.entries.filter((e) => e.category === 'wake').length, 7);
});

test('swap two activities: different times swap times, same time swaps order', async () => {
  const s = (await anna.get('/state')).json.data;
  const mon = s.entries.filter((e) => e.day === 0);
  const [wake, milk] = mon;
  let r = await anna.post(`/entries/${milk.id}/swap`, { targetId: wake.id });
  let after = r.json.data.entries.filter((e) => e.day === 0);
  assert.deepEqual(after.map((e) => e.category), ['milk', 'wake']);
  assert.deepEqual(after.map((e) => e.time), ['06:45', '07:15']);

  // Two at the same time.
  r = await anna.post('/entries', { entry: { time: '12:00', category: 'water' }, days: [6] });
  r = await anna.post('/entries', { entry: { time: '12:00', category: 'lunch', description: 'Rice' }, days: [6] });
  const sun = r.json.data.entries.filter((e) => e.day === 6 && e.time === '12:00');
  assert.deepEqual(sun.map((e) => e.category), ['water', 'lunch']);
  r = await anna.post(`/entries/${sun[1].id}/swap`, { targetId: sun[0].id });
  after = r.json.data.entries.filter((e) => e.day === 6 && e.time === '12:00');
  assert.deepEqual(after.map((e) => e.category), ['lunch', 'water']);

  // Not across days.
  const tue = r.json.data.entries.find((e) => e.day === 1);
  assert.equal((await anna.post(`/entries/${tue.id}/swap`, { targetId: sun[0].id })).status, 409);
});

test('copy a day: append skips duplicates, replace overwrites', async () => {
  let r = await anna.post('/days/0/copy', { targets: [4], mode: 'replace' });
  const mon = r.json.data.entries.filter((e) => e.day === 0).map((e) => `${e.time} ${e.category}`);
  let fri = r.json.data.entries.filter((e) => e.day === 4).map((e) => `${e.time} ${e.category}`);
  assert.deepEqual(fri, mon);

  r = await anna.post('/days/0/copy', { targets: [4], mode: 'append' });
  assert.equal(r.json.data.result.created, 0);
  fri = r.json.data.entries.filter((e) => e.day === 4);
  assert.equal(fri.length, mon.length);
});

test('bulk fill (example schedule) on several days', async () => {
  const entries = [
    { time: '07:00', category: 'wake', title: 'Wake up' },
    { time: '07:15', category: 'milk', quantity: 120, unit: 'ml' },
    { time: '19:30', category: 'sleep', title: 'Night sleep' },
  ];
  const r = await anna.post('/bulk', { days: [5, 6], mode: 'replace', entries });
  assert.equal(r.json.data.result.created, 6);
  assert.deepEqual(r.json.data.entries.filter((e) => e.day === 6).map((e) => e.time), ['07:00', '07:15', '19:30']);
});

test('templates: save the week, change it, apply the template back', async () => {
  let s = (await anna.get('/state')).json.data;
  const before = s.entries.map((e) => `${e.day} ${e.time} ${e.category}`);
  let r = await anna.post('/templates', { name: '  Week 1  ' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const id = r.json.data.result.id;
  assert.equal(r.json.data.templates[0].name, 'Week 1');
  assert.equal(r.json.data.templates[0].entryCount, before.length);

  r = await anna.del('/week');
  assert.equal(r.json.data.entries.length, 0);
  assert.equal((await anna.post('/templates', { name: 'Empty' })).json.reason, 'week_empty');

  r = await anna.post(`/templates/${id}/apply`, { mode: 'replace' });
  assert.deepEqual(r.json.data.entries.map((e) => `${e.day} ${e.time} ${e.category}`), before);

  // Ben sees Anna's template.
  s = (await ben.get('/state')).json.data;
  assert.equal(s.templates.length, 1);
  assert.equal(s.templates[0].createdByName, 'Anna');

  assert.equal((await anna.post('/templates', { name: '' })).status, 422);
  r = await anna.del(`/templates/${id}`);
  assert.equal(r.json.data.templates.length, 0);
  assert.equal((await anna.del(`/templates/${id}`)).status, 404);
});

test('clear one day', async () => {
  const r = await anna.del('/days/4');
  assert.ok(r.json.data.result.removed > 0);
  assert.equal(r.json.data.entries.filter((e) => e.day === 4).length, 0);
  assert.ok(r.json.data.entries.some((e) => e.day === 0));
});

test('deleted elsewhere: editing answers 404 gone', async () => {
  const s = (await anna.get('/state')).json.data;
  const target = s.entries[0];
  await ben.get('/state');
  assert.equal((await ben.del(`/entries/${target.id}`)).status, 200);
  const r = await anna.patch(`/entries/${target.id}`, { entry: { notes: 'late edit' } });
  assert.equal(r.status, 404);
  assert.equal(r.json.reason, 'gone');
  assert.equal((await anna.patch('/entries/not-an-id', { entry: {} })).status, 422);
});

test('revision rises with every write', async () => {
  const r1 = (await anna.get('/revision')).json.data.revision;
  await anna.post('/entries', { entry: { time: '08:00', category: 'water' }, days: [2] });
  const r2 = (await ben.get('/revision')).json.data.revision;
  assert.equal(r2, r1 + 1);
});

test('read-only member can view but not change', async () => {
  const grandma = browser('sid-grandma');
  const r = await grandma.get('/state');
  assert.equal(r.status, 200);
  assert.equal(r.json.data.access, 'read');
  assert.ok(r.json.data.entries.length > 0);
  const w = await grandma.post('/entries', { entry: bottle, days: [0] });
  assert.equal(w.status, 403);
  assert.equal(w.json.reason, 'read_only');
});

test('no access, split-expenses guest and disabled module are refused', async () => {
  for (const sid of ['sid-kid', 'sid-guest', 'sid-disabled']) {
    const r = await browser(sid).get('/state');
    assert.equal(r.status, 403, sid);
    assert.equal(r.json.reason, 'module_forbidden', sid);
  }
});

test('unknown route 404, wrong method 405', async () => {
  assert.equal((await anna.get('/nope')).status, 404);
  assert.equal((await anna.call('PUT', '/state')).status, 405);
});

test('Yuvomi unreachable: 502, no data', async () => {
  yuvomiDown = true;
  try {
    const r = await anna.get('/state');
    assert.equal(r.status, 502);
    assert.equal(r.json.data, undefined);
  } finally {
    yuvomiDown = false;
  }
});

test('data survives a restart (database reopened)', async () => {
  const s = (await anna.get('/state')).json.data;
  const file = path.join(dataDir, 'test.db');
  const again = openDatabase(file);
  try {
    const repo = createRepository(again, 'default');
    assert.equal(repo.listEntries().length, s.entries.length);
    assert.equal(repo.revision(), s.revision);
  } finally {
    again.close();
  }
});

test('another household in the same database sees nothing and changes nothing', async () => {
  const s = (await anna.get('/state')).json.data;
  const other = createRepository(db, 'neighbours');
  assert.equal(other.listEntries().length, 0);
  assert.equal(other.listTemplates().length, 0);
  assert.throws(() => other.deleteEntry(s.entries[0].id), /no longer exists/);
  other.clearWeek();
  assert.equal((await anna.get('/state')).json.data.entries.length, s.entries.length);
});
