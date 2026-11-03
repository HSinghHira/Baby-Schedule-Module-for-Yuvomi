/**
 * Unit tests for the module's pure schedule logic, and a check that the
 * browser and the sidecar agree on categories and units.
 *
 *   node --test test/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CATEGORIES, UNITS, STARTER_DAY, category, entriesForDay, groupByPart, suggestTime, summarizeDay,
  nextIndex, formatQuantity, minutesOf, timeOf, weekdayOf, partOfDay, isFeeding, isFood,
} from '../modules/baby-schedule/lib/schedule.js';
import * as server from '../sidecar/src/validate.js';

const e = (day, time, cat, extra = {}) => ({ id: `${day}-${time}-${cat}`, day, time, category: cat, position: 0, ...extra });

test('browser and sidecar share the same categories and units', () => {
  assert.deepEqual(CATEGORIES.map((c) => c.key), [...server.CATEGORIES]);
  assert.deepEqual([...UNITS], [...server.UNITS]);
});

test('every category default uses a known unit', () => {
  for (const c of CATEGORIES) {
    if (c.defaults.unit) assert.ok(UNITS.includes(c.defaults.unit), c.key);
  }
});

test('the example day passes the sidecar validation', () => {
  for (const s of STARTER_DAY) {
    assert.doesNotThrow(() => server.validEntryFields({ ...s, title: 'x', description: 'y' }));
  }
});

test('weekday is Monday-based', () => {
  assert.equal(weekdayOf(new Date(2026, 10, 2)), 0); // Monday 2 Nov 2026
  assert.equal(weekdayOf(new Date(2026, 10, 1)), 6); // Sunday 1 Nov 2026
});

test('time helpers', () => {
  assert.equal(minutesOf('07:15'), 435);
  assert.equal(timeOf(435), '07:15');
  assert.equal(timeOf(24 * 60 + 10), '23:59');
  assert.equal(timeOf(-5), '00:00');
  assert.equal(partOfDay('11:59'), 'morning');
  assert.equal(partOfDay('12:00'), 'afternoon');
  assert.equal(partOfDay('17:00'), 'evening');
});

test('a day is sorted by time, then by position', () => {
  const list = entriesForDay([
    e(0, '12:00', 'lunch', { position: 1 }),
    e(1, '06:00', 'wake'),
    e(0, '07:00', 'wake'),
    e(0, '12:00', 'water', { position: 0 }),
  ], 0);
  assert.deepEqual(list.map((x) => `${x.time} ${x.category}`), ['07:00 wake', '12:00 water', '12:00 lunch']);
});

test('groups by part of day keep order', () => {
  const groups = groupByPart([e(0, '07:00', 'wake'), e(0, '09:00', 'milk'), e(0, '13:00', 'sleep'), e(0, '19:30', 'sleep')]);
  assert.deepEqual(groups.map((g) => [g.part, g.entries.length]), [['morning', 2], ['afternoon', 1], ['evening', 1]]);
});

test('suggested time follows the last activity', () => {
  assert.equal(suggestTime([]), '07:00');
  assert.equal(suggestTime([e(0, '07:00', 'wake'), e(0, '09:30', 'sleep')]), '10:00');
  assert.equal(suggestTime([e(0, '23:45', 'sleep')]), '23:30');
  assert.equal(suggestTime([], { after: '10:00' }), '10:30');
});

test('summary: next activity, feeding, sleep and food count', () => {
  const day = [
    e(0, '07:00', 'wake'),
    e(0, '07:15', 'milk', { quantity: 120, unit: 'ml' }),
    e(0, '09:00', 'breakfast'),
    e(0, '09:30', 'sleep'),
    e(0, '10:00', 'milk', { quantity: 150, unit: 'ml' }),
    e(0, '11:00', 'fruits'),
    e(0, '12:00', 'water'),
  ];
  const all = summarizeDay(day);
  assert.equal(all.total, 7);
  assert.equal(all.foods, 2);
  assert.equal(all.feeds, 4);
  assert.equal(all.milkTotal, 270);
  assert.equal(all.next.time, '07:00');

  const at920 = summarizeDay(day, 9 * 60 + 20);
  assert.equal(at920.next.time, '09:30');
  assert.equal(at920.nextFeed.time, '10:00');
  assert.equal(at920.nextSleep.time, '09:30');

  const late = summarizeDay(day, 23 * 60);
  assert.equal(late.next, null);
  assert.equal(late.nextFeed, null);
  assert.equal(nextIndex(day, 23 * 60), -1);
  assert.equal(nextIndex(day, 9 * 60), 2);
});

test('feeding and food definitions', () => {
  assert.ok(isFeeding('milk'));
  assert.ok(!isFood('milk'));
  assert.ok(isFood('snacks'));
  assert.ok(!isFeeding('water'));
  assert.ok(!isFeeding('sleep'));
});

test('quantities print without trailing zeros', () => {
  assert.equal(formatQuantity(120), '120');
  assert.equal(formatQuantity(1.5), '1.5');
  assert.equal(formatQuantity(0.333), '0.33');
  assert.equal(formatQuantity(null), '');
});

test('unknown category falls back to other', () => {
  assert.equal(category('pizza').key, 'other');
});

test('every module file is a type the Yuvomi installer copies', () => {
  const allowed = /\.(js|mjs|css|json|svg|png|jpg|jpeg|webp|gif|ico|woff|woff2|ttf|md|txt|map)$/i;
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory()
    ? walk(`${dir}/${d.name}`) : [`${dir}/${d.name}`]));
  const root = new URL('../modules/baby-schedule', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  for (const file of walk(decodeURIComponent(root))) {
    assert.match(file, allowed, file);
  }
});
