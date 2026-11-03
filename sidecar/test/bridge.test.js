/**
 * The "Today at a glance" bridge against a mock of Yuvomi's tasks API.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createRepository } from '../src/db.js';
import { createTaskBridge, pickTarget, localNow, taskTitle } from '../src/bridge.js';
import { createIdentityResolver } from '../src/identity.js';
import { createApp } from '../src/app.js';

const TOKEN = 'yuvomi_testtoken_testtoken_testtoken';

// ---- mock Yuvomi: tasks + auth/me -------------------------------------------
const tasks = new Map();
let nextTaskId = 100;
const calls = [];
const yuvomi = http.createServer(async (req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  calls.push(`${req.method} ${req.url}`);
  if (req.url === '/api/v1/auth/me') {
    const sid = /yuvomi\.sid=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    const users = {
      admin: { user: { id: 1, display_name: 'Anna', role: 'admin', access_scope: 'family' }, permissions: { modules: { 'ext:baby-schedule': 'write' } } },
      member: { user: { id: 2, display_name: 'Ben', role: 'member', access_scope: 'family' }, permissions: { modules: { 'ext:baby-schedule': 'write' } } },
    };
    return users[sid] ? send(200, users[sid]) : send(401, { error: 'no' });
  }
  const auth = req.headers.authorization;
  if (auth === 'Bearer yuvomi_readonly_readonly_readonly') return send(403, { error: 'scope' });
  if (auth !== `Bearer ${TOKEN}`) return send(401, { error: 'bad token' });
  let body = '';
  for await (const c of req) body += c;
  const m = /^\/api\/v1\/tasks\/(\d+)$/.exec(req.url);
  if (req.method === 'GET' && req.url.startsWith('/api/v1/tasks?')) return send(200, { data: [...tasks.values()] });
  if (req.method === 'POST' && req.url === '/api/v1/tasks') {
    const t = { id: nextTaskId++, status: 'open', ...JSON.parse(body) };
    tasks.set(t.id, t);
    return send(201, { data: t });
  }
  if (m && req.method === 'GET') return tasks.has(+m[1]) ? send(200, { data: tasks.get(+m[1]) }) : send(404, { error: 'nf' });
  if (m && req.method === 'DELETE') return tasks.delete(+m[1]) ? send(200, { ok: true }) : send(404, { error: 'nf' });
  send(404, { error: 'Not found.' });
});

let dir;
let db;
let repo;
let bridge;
let clock;
let base;
let appServer;
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

// 2026-11-02 is a Monday (weekday 0). Times are in Pacific/Auckland.
const TZ = 'Pacific/Auckland';
const at = (date, time) => new Date(new Date(`${date}T${time}:00+13:00`).getTime());
const openTasks = () => [...tasks.values()].filter((t) => t.status !== 'done');

before(async () => {
  const yPort = await listen(yuvomi);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-bridge-'));
  db = openDatabase(path.join(dir, 'b.db'));
  repo = createRepository(db, 'default');
  clock = at('2026-11-02', '06:00');
  bridge = createTaskBridge({ repo, yuvomiUrl: `http://127.0.0.1:${yPort}`, now: () => clock, logger: { error() {} } });
  const actor = { id: 1, name: 'Anna' };
  repo.bulkFill([
    { time: '07:00', category: 'wake', title: 'Wake up', description: '', quantity: null, unit: null, notes: '' },
    { time: '07:15', category: 'milk', title: '', description: 'Formula', quantity: 120, unit: 'ml', notes: '' },
    { time: '09:00', category: 'breakfast', title: '', description: 'Pear', quantity: null, unit: null, notes: '' },
  ], [0], 'replace', actor);
  repo.bulkFill([
    { time: '08:00', category: 'water', title: '', description: '', quantity: null, unit: null, notes: '' },
  ], [1], 'replace', actor);

  const identity = createIdentityResolver({ yuvomiUrl: `http://127.0.0.1:${yPort}`, cacheSeconds: 0, timeoutMs: 2000 });
  const handle = createApp({
    config: { allowedOrigins: ['https://home.example'], trustProxyHops: 0, writesPerMinute: 1000, secureCookies: false, csrfSecret: 'x'.repeat(40) },
    repo, identity, bridge, logger: { error() {}, log() {} },
  });
  appServer = http.createServer((q, s) => { handle(q, s); });
  base = `http://127.0.0.1:${await listen(appServer)}/api/extensions/baby-schedule`;
});

after(() => {
  bridge.stop();
  appServer.close();
  yuvomi.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('localNow gives the date, Monday-based weekday and minute in a time zone', () => {
  assert.deepEqual(localNow(TZ, at('2026-11-02', '07:30')), { dateKey: '2026-11-02', weekday: 0, minutes: 450 });
  // Late Sunday UTC is already Monday in Auckland.
  assert.equal(localNow(TZ, new Date('2026-11-01T12:30:00Z')).weekday, 0);
});

test('pickTarget: first not-done activity whose successor has not started', () => {
  const day = [
    { id: 'a', time: '07:00' }, { id: 'b', time: '07:15' }, { id: 'c', time: '09:00' }, { id: 'd', time: '09:00' },
  ];
  assert.equal(pickTarget(day, new Set(), 6 * 60).id, 'a');
  assert.equal(pickTarget(day, new Set(), 7 * 60 + 5).id, 'a');
  assert.equal(pickTarget(day, new Set(), 7 * 60 + 20).id, 'b');
  assert.equal(pickTarget(day, new Set(['a']), 6 * 60).id, 'b');
  assert.equal(pickTarget(day, new Set(['a', 'b']), 23 * 60).id, 'c');
  assert.equal(pickTarget(day, new Set(['a', 'b', 'c']), 23 * 60).id, 'd');
  assert.equal(pickTarget(day, new Set(['a', 'b', 'c', 'd']), 23 * 60), null);
});

test('task title: emoji, name, amount, in the household language', () => {
  assert.equal(taskTitle({ category: 'milk', title: '', quantity: 120, unit: 'ml' }), '🍼 Milk bottle · 120 ml');
  assert.equal(taskTitle({ category: 'sleep', title: 'Nap', quantity: 1.5, unit: 'h' }, { unit: { h: 'Std.' } }), '😴 Nap · 1.5 Std.');
  assert.equal(taskTitle({ category: 'lunch', title: '' }, { catTitle: { lunch: 'Mittagessen' } }), '🍲 Mittagessen');
});

test('switched off: nothing happens in Yuvomi', async () => {
  await bridge.tick();
  assert.equal(tasks.size, 0);
});

test('settings: only an admin, token checked first', async () => {
  const call = async (sid, method, body) => {
    const r1 = await fetch(`${base}/state`, { headers: { cookie: `yuvomi.sid=${sid}` } });
    const csrf = r1.headers.get('x-baby-schedule-csrf');
    const r = await fetch(`${base}/bridge`, {
      method,
      headers: { cookie: `yuvomi.sid=${sid}; bs_csrf=${csrf}`, 'x-baby-schedule-csrf': csrf, origin: 'https://home.example', 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() };
  };
  assert.equal((await call('member', 'GET')).json.reason, 'admin_only');
  assert.equal((await call('member', 'PUT', { enabled: true })).status, 403);
  assert.equal((await call('admin', 'PUT', { enabled: true })).json.field, 'token');
  assert.equal((await call('admin', 'PUT', { token: 'hello' })).status, 422);
  assert.equal((await call('admin', 'PUT', { token: 'yuvomi_wrongwrongwrongwrongwrong' })).json.reason, 'token_invalid');
  assert.equal((await call('admin', 'PUT', { token: 'yuvomi_readonly_readonly_readonly' })).json.reason, 'token_forbidden');
  assert.equal((await call('admin', 'PUT', { timeZone: 'Mars/Olympus' })).status, 422);
  assert.equal(tasks.size, 0);

  const ok = await call('admin', 'PUT', { token: TOKEN, enabled: true, timeZone: TZ, labels: { catTitle: { wake: 'Wake up' } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.data.enabled, true);
  assert.equal(ok.json.data.hasToken, true);
  assert.equal(JSON.stringify(ok.json).includes(TOKEN), false, 'the token never goes back to the browser');
  assert.equal(ok.json.data.task.title, '🌅 Wake up');
});

test('one task: the first activity of the day, due at its time', () => {
  const open = openTasks();
  assert.equal(open.length, 1);
  assert.equal(open[0].title, '🌅 Wake up');
  assert.equal(open[0].due_date, '2026-11-02');
  assert.equal(open[0].due_time, '07:00');
  assert.equal(open[0].points, 0);
  assert.equal(open[0].visibility, 'all');
});

test('ticked off in Yuvomi: the task goes away and the next one appears', async () => {
  const [t] = openTasks();
  t.status = 'done';
  clock = at('2026-11-02', '07:02');
  await bridge.tick();
  const open = openTasks();
  assert.equal(open.length, 1);
  assert.equal(open[0].title, '🍼 Milk bottle · 120 ml');
  assert.equal(open[0].due_time, '07:15');
  assert.equal(open[0].description.startsWith('Formula'), true);
  assert.equal(tasks.has(t.id), false, 'the done task is cleaned out of the Tasks list');
});

test('not ticked off, next activity time arrives: it moves on', async () => {
  clock = at('2026-11-02', '09:01');
  await bridge.tick();
  const open = openTasks();
  assert.equal(open.length, 1);
  assert.equal(open[0].title, '🥣 Breakfast');
});

test('a schedule edit replaces the task', async () => {
  const breakfast = repo.listEntries().find((e) => e.category === 'breakfast');
  repo.updateEntry(breakfast.id, { title: 'Porridge' }, [], { id: 1, name: 'Anna' });
  await bridge.tick();
  const open = openTasks();
  assert.equal(open.length, 1);
  assert.equal(open[0].title, '🥣 Porridge');
});

test('task deleted in Yuvomi: counts as handled, nothing left for today', async () => {
  const [t] = openTasks();
  tasks.delete(t.id);
  await bridge.tick();
  assert.equal(openTasks().length, 0);
  assert.equal(repo.getBridge().task_id, null);
});

test('next day: that weekday\'s activities', async () => {
  clock = at('2026-11-03', '06:30');
  await bridge.tick();
  const open = openTasks();
  assert.equal(open.length, 1);
  assert.equal(open[0].title, '💧 Water');
  assert.equal(open[0].due_date, '2026-11-03');
});

test('token revoked: error recorded, nothing breaks', async () => {
  const b = repo.getBridge();
  repo.saveBridge({ api_token: 'yuvomi_revoked_revoked_revoked_revoked' });
  await bridge.tick();
  assert.equal(repo.getBridge().last_error, 'token_invalid');
  repo.saveBridge({ api_token: b.api_token });
  await bridge.tick();
  assert.equal(repo.getBridge().last_error, null);
});

test('switching off removes the task from Yuvomi', async () => {
  assert.equal(openTasks().length, 1);
  repo.saveBridge({ enabled: false });
  await bridge.tick();
  assert.equal(openTasks().length, 0);
  assert.equal(repo.getBridge().task_id, null);
});
