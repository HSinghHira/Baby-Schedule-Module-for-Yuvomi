/**
 * Input validation. Everything the browser sends passes through here; the
 * browser half of the module is not a trusted caller.
 *
 * The category and unit lists must match modules/baby-schedule/lib/schedule.js.
 */

export const CATEGORIES = Object.freeze([
  'wake', 'milk', 'water', 'breakfast', 'lunch', 'dinner',
  'fruits', 'vegetables', 'snacks', 'sleep', 'activity', 'other',
]);
export const UNITS = Object.freeze(['ml', 'oz', 'g', 'pcs', 'tsp', 'tbsp', 'cup', 'min', 'h']);
export const MODES = Object.freeze(['replace', 'append']);

export const LIMITS = Object.freeze({
  title: 80,
  description: 200,
  notes: 500,
  templateName: 60,
  entriesPerDay: 80,
  templates: 30,
  bulkEntries: 200,
  quantityMax: 100000,
});

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class ValidationError extends Error {
  constructor(field, message) {
    super(message);
    this.field = field;
  }
}

function fail(field, message) {
  throw new ValidationError(field, message);
}

/** Trim, drop control characters (newlines kept for notes), cap the length. */
function text(value, field, max, { multiline = false } = {}) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') fail(field, `${field} must be text.`);
  // eslint-disable-next-line no-control-regex
  const cleaned = (multiline ? value.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '') : value.replace(/[\u0000-\u001F\u007F]/g, ' '))
    .trim();
  if (cleaned.length > max) fail(field, `${field} may be at most ${max} characters.`);
  return cleaned;
}

export function validDay(value, field = 'day') {
  const day = typeof value === 'string' && /^\d$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(day) || day < 0 || day > 6) fail(field, `${field} must be a weekday number from 0 (Monday) to 6 (Sunday).`);
  return day;
}

export function validDays(value, field = 'days', { allowEmpty = false } = {}) {
  if (!Array.isArray(value)) fail(field, `${field} must be a list of weekdays.`);
  const days = [...new Set(value.map((d) => validDay(d, field)))].sort((a, b) => a - b);
  if (!allowEmpty && !days.length) fail(field, `Choose at least one day.`);
  return days;
}

export function validId(value, field = 'id') {
  if (typeof value !== 'string' || !ID_RE.test(value)) fail(field, `${field} is not a valid id.`);
  return value;
}

export function validMode(value) {
  const mode = value ?? 'append';
  if (!MODES.includes(mode)) fail('mode', 'mode must be "replace" or "append".');
  return mode;
}

/**
 * Validate the editable fields of an entry. With `partial`, missing fields are
 * left out of the result (for updates); otherwise defaults are filled in.
 */
export function validEntryFields(raw, { partial = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('entry', 'entry must be an object.');
  const out = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(raw, key);

  if (has('time') || !partial) {
    if (typeof raw.time !== 'string' || !TIME_RE.test(raw.time)) fail('time', 'time must look like 07:30.');
    out.time = raw.time;
  }
  if (has('category') || !partial) {
    if (!CATEGORIES.includes(raw.category)) fail('category', 'Unknown category.');
    out.category = raw.category;
  }
  if (has('title') || !partial) out.title = text(raw.title, 'title', LIMITS.title);
  if (has('description') || !partial) out.description = text(raw.description, 'description', LIMITS.description);
  if (has('notes') || !partial) out.notes = text(raw.notes, 'notes', LIMITS.notes, { multiline: true });

  if (has('quantity') || !partial) {
    const q = raw.quantity;
    if (q === undefined || q === null || q === '') {
      out.quantity = null;
    } else {
      const n = typeof q === 'string' ? Number(q.replace(',', '.')) : q;
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > LIMITS.quantityMax) {
        fail('quantity', `quantity must be a number between 0 and ${LIMITS.quantityMax}.`);
      }
      out.quantity = Math.round(n * 100) / 100;
    }
  }
  if (has('unit') || !partial) {
    const u = raw.unit;
    if (u === undefined || u === null || u === '') out.unit = null;
    else if (!UNITS.includes(u)) fail('unit', 'Unknown unit.');
    else out.unit = u;
  }
  // A unit without an amount says nothing; drop it so the list stays clean.
  if (!partial && out.quantity === null) out.unit = null;
  return out;
}

export function validTemplateName(value) {
  const name = text(value, 'name', LIMITS.templateName);
  if (!name) fail('name', 'Give the template a name.');
  return name;
}
