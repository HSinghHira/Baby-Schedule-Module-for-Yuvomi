/**
 * Schedule logic without DOM: categories, sorting, summaries.
 * Kept free of browser imports so it can be tested in Node.
 *
 * The category and unit keys must match sidecar/src/validate.js.
 */

/** Weekday index 0 = Monday ... 6 = Sunday (the sidecar's `day`). */
export const DAYS = Object.freeze([0, 1, 2, 3, 4, 5, 6]);
export const DAY_KEYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

/**
 * `tone` names the colour family in style.css (`--bs-tone-<tone>`).
 * `defaults` pre-fill the form when the category is picked for a new entry.
 * `measure` decides whether the amount field reads as an amount or a duration.
 */
export const CATEGORIES = Object.freeze([
  { key: 'wake',       emoji: '🌅', tone: 'sun',    measure: 'none',     defaults: {} },
  { key: 'milk',       emoji: '🍼', tone: 'milk',   measure: 'amount',   defaults: { quantity: 120, unit: 'ml' } },
  { key: 'water',      emoji: '💧', tone: 'water',  measure: 'amount',   defaults: {} },
  { key: 'breakfast',  emoji: '🥣', tone: 'meal',   measure: 'amount',   defaults: {} },
  { key: 'lunch',      emoji: '🍲', tone: 'meal',   measure: 'amount',   defaults: {} },
  { key: 'dinner',     emoji: '🍽️', tone: 'meal',   measure: 'amount',   defaults: {} },
  { key: 'fruits',     emoji: '🍐', tone: 'fresh',  measure: 'amount',   defaults: {} },
  { key: 'vegetables', emoji: '🥕', tone: 'fresh',  measure: 'amount',   defaults: {} },
  { key: 'snacks',     emoji: '🍌', tone: 'snack',  measure: 'amount',   defaults: {} },
  { key: 'sleep',      emoji: '😴', tone: 'sleep',  measure: 'duration', defaults: { quantity: 1, unit: 'h' } },
  { key: 'activity',   emoji: '🧸', tone: 'play',   measure: 'duration', defaults: {} },
  { key: 'other',      emoji: '📝', tone: 'other',  measure: 'amount',   defaults: {} },
]);

const BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));

export function category(key) {
  return BY_KEY.get(key) || BY_KEY.get('other');
}

export const UNITS = Object.freeze(['ml', 'oz', 'g', 'pcs', 'tsp', 'tbsp', 'cup', 'min', 'h']);
export const DURATION_UNITS = Object.freeze(['min', 'h']);

/** Food = anything eaten (not milk, not water). Feeding = milk or food. */
const FOOD = new Set(['breakfast', 'lunch', 'dinner', 'fruits', 'vegetables', 'snacks']);
export const isFood = (key) => FOOD.has(key);
export const isFeeding = (key) => key === 'milk' || FOOD.has(key);
export const isSleep = (key) => key === 'sleep';

/** Monday-based weekday of a Date. */
export function weekdayOf(date) {
  return (date.getDay() + 6) % 7;
}

export function minutesOf(time) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(time || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

export function timeOf(minutes) {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(minutes)));
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}

export function compareEntries(a, b) {
  return a.day - b.day || minutesOf(a.time) - minutesOf(b.time)
    || (a.position ?? 0) - (b.position ?? 0) || String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
}

export function entriesForDay(entries, day) {
  return entries.filter((e) => e.day === day).sort(compareEntries);
}

/** 'morning' (before 12:00), 'afternoon' (before 17:00) or 'evening'. */
export function partOfDay(time) {
  const m = minutesOf(time);
  if (m < 12 * 60) return 'morning';
  if (m < 17 * 60) return 'afternoon';
  return 'evening';
}

/** Group a sorted day into parts of the day, keeping order. */
export function groupByPart(dayEntries) {
  const groups = [];
  for (const entry of dayEntries) {
    const part = partOfDay(entry.time);
    if (!groups.length || groups.at(-1).part !== part) groups.push({ part, entries: [] });
    groups.at(-1).entries.push(entry);
  }
  return groups;
}

/**
 * A sensible time for the next new entry on a day: 30 minutes after the last
 * one, or 07:00 for an empty day.
 */
export function suggestTime(dayEntries, { after = null } = {}) {
  if (after) return timeOf(minutesOf(after) + 30);
  if (!dayEntries.length) return '07:00';
  const last = Math.max(...dayEntries.map((e) => minutesOf(e.time)));
  return timeOf(Math.min(last + 30, 23 * 60 + 30));
}

/**
 * Summary of one day. `nowMinutes` marks the present when the day is today;
 * pass null for any other day (then "next" means the first of the day).
 */
export function summarizeDay(dayEntries, nowMinutes = null) {
  const upcoming = nowMinutes == null
    ? dayEntries
    : dayEntries.filter((e) => minutesOf(e.time) >= nowMinutes);
  return {
    total: dayEntries.length,
    feeds: dayEntries.filter((e) => isFeeding(e.category)).length,
    foods: dayEntries.filter((e) => isFood(e.category)).length,
    milkTotal: dayEntries
      .filter((e) => e.category === 'milk' && e.unit === 'ml' && typeof e.quantity === 'number')
      .reduce((sum, e) => sum + e.quantity, 0),
    next: upcoming[0] || null,
    nextFeed: upcoming.find((e) => isFeeding(e.category)) || null,
    nextSleep: upcoming.find((e) => isSleep(e.category)) || null,
  };
}

/** Index of the entry that counts as "now" on today's timeline (the next one), or -1. */
export function nextIndex(dayEntries, nowMinutes) {
  return dayEntries.findIndex((e) => minutesOf(e.time) >= nowMinutes);
}

/** Format an amount without trailing zeros: 120, 1.5, 0.25. */
export function formatQuantity(q) {
  if (typeof q !== 'number' || !Number.isFinite(q)) return '';
  return String(Math.round(q * 100) / 100);
}

/**
 * Example week from the planning brief. Titles are i18n keys resolved by the
 * caller (`starter.*`), so the example arrives in the user's language.
 */
export const STARTER_DAY = Object.freeze([
  { time: '07:00', category: 'wake',      titleKey: 'wakeUp',       descKey: 'wakeUpDesc' },
  { time: '07:15', category: 'milk',      quantity: 120, unit: 'ml' },
  { time: '08:00', category: 'water',     descKey: 'offerWater' },
  { time: '09:00', category: 'breakfast', descKey: 'pear' },
  { time: '09:30', category: 'sleep',     titleKey: 'morningNap',   quantity: 30, unit: 'min' },
  { time: '10:00', category: 'milk',      quantity: 120, unit: 'ml' },
  { time: '11:00', category: 'fruits',    descKey: 'banana' },
  { time: '12:00', category: 'water',     descKey: 'offerWater' },
  { time: '12:30', category: 'lunch' },
  { time: '13:30', category: 'sleep',     titleKey: 'afternoonNap', quantity: 1.5, unit: 'h' },
  { time: '15:00', category: 'milk',      quantity: 120, unit: 'ml' },
  { time: '16:00', category: 'snacks' },
  { time: '18:00', category: 'dinner' },
  { time: '19:00', category: 'milk',      quantity: 120, unit: 'ml' },
  { time: '19:30', category: 'sleep',     titleKey: 'nightSleep' },
]);
