/**
 * Baby Schedule - a household's weekly plan for feeding, food, water and sleep.
 *
 * Yuvomi third-party module. The page is browser code only; the schedule is
 * stored by the Baby Schedule sidecar under /api/extensions/baby-schedule/
 * (see ../../sidecar), which checks every request against the Yuvomi session.
 *
 * Contract notes (MODULES.md):
 *  - `container` already is the `.app-page--dashboard` root; header and body
 *    are built with /utils/page-layout.js. The list sits in `.page-columns`
 *    (reading measure), the overview in its side column.
 *  - `render()` never throws: a failed render makes Yuvomi switch the module
 *    off for an admin, so every failure becomes an error state on the page.
 *  - Every listener and timer hangs on `context.signal`.
 *  - All user text goes through esc(); no innerHTML.
 */

import { t, formatTime, getLocale } from '/i18n.js';
import { esc } from '/utils/html.js';
import {
  renderPageHeader, renderPageTitle, renderPageActions, renderPageBody, renderPageColumns,
} from '/utils/page-layout.js';
import { emptyStateEl } from '/utils/empty-state.js';
import { sidecar, SidecarError } from './lib/client.js';
import { openSheet, closeSheet, confirm, confirmOverSheet, toast, markSheetClean } from './lib/sheet.js';
import {
  DAYS, CATEGORIES, UNITS, DURATION_UNITS, STARTER_DAY, category, entriesForDay, groupByPart, suggestTime,
  summarizeDay, nextIndex, formatQuantity, minutesOf, timeOf, weekdayOf,
} from './lib/schedule.js';

const ID = 'baby-schedule';
const POLL_MS = 20000;

/** Module translation: `extensions.baby-schedule.<key>`. */
const k = (key, params = {}) => t(`extensions.${ID}.${key}`, params);

/**
 * Language for day and month names: the app language, as Yuvomi's own pages
 * use it (utils/day-label.js). Not getFormatLocale(): that is the Region
 * setting for number formats, and a German region gave "Montag" in an English UI.
 */
function loc() {
  try { return getLocale() || undefined; } catch { return undefined; }
}

const nameCache = new Map();
/** Localised weekday name; 2024-01-01 was a Monday. */
function dayName(day, style = 'long') {
  const key = `${style}:${day}:${loc()}`;
  if (!nameCache.has(key)) {
    nameCache.set(key, new Intl.DateTimeFormat(loc(), { weekday: style }).format(new Date(2024, 0, 1 + day)));
  }
  return nameCache.get(key);
}

const fmtTime = (time) => formatTime(time) || time;
const nowMinutes = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const todayIndex = () => weekdayOf(new Date());
const icons = (el) => { try { window.lucide?.createIcons?.({ el }); } catch { /* icons are decoration */ } };

function relativeIn(minutes) {
  try {
    const rtf = new Intl.RelativeTimeFormat(loc(), { numeric: 'auto' });
    if (minutes < 60) return rtf.format(Math.max(0, minutes), 'minute');
    return rtf.format(Math.round(minutes / 60), 'hour');
  } catch {
    return '';
  }
}

function entryTitle(entry) {
  return entry.title || k(`catTitle.${category(entry.category).key}`);
}

function unitLabel(unit) {
  return unit ? k(`unit.${unit}`) : '';
}

function quantityText(entry) {
  const q = formatQuantity(entry.quantity);
  if (!q) return '';
  return entry.unit ? `${q} ${unitLabel(entry.unit)}` : q;
}

function daysList(days) {
  return days.map((d) => dayName(d, 'short')).join(', ');
}

/** Turn a sidecar error into one sentence for the parent. */
function errorText(err) {
  const reason = err instanceof SidecarError ? err.reason : null;
  const known = [
    'offline', 'not_installed', 'unreachable', 'read_only', 'not_signed_in', 'gone', 'day_full',
    'too_many_templates', 'week_empty', 'rate_limited', 'csrf_invalid', 'bad_origin', 'module_forbidden',
    'yuvomi_unreachable', 'yuvomi_unavailable', 'yuvomi_busy', 'account_inactive',
  ];
  if (reason && known.includes(reason)) return k(`error.${reason}`);
  if (reason === 'invalid' && err.message) return err.message;
  return k('error.generic');
}

// ---------------------------------------------------------------------------

export async function render(container, context = {}) {
  const fallback = new AbortController();
  const signal = context.signal || fallback.signal;
  const view = createView(container, signal);
  try {
    await view.mount();
  } catch (err) {
    if (signal.aborted) return;
    console.error('[baby-schedule] render failed', err);
    try { view.showError(err); } catch { /* nothing more to show */ }
  }
}

function createView(container, signal) {
  const st = {
    data: null,
    day: todayIndex(),
    canWrite: false,
    loaded: false,
    renderedMinute: -1,
    pollTimer: null,
    polling: false,
    busy: 0,
  };

  const $ = (sel) => container.querySelector(sel);
  let fab = null;

  const alive = () => !signal.aborted && container.isConnected;

  // ---- shell ----------------------------------------------------------------

  function shellHtml() {
    const weekBtn = `<button type="button" class="btn btn--secondary bs-week-btn" data-bs="week-tools" hidden>
        <i data-lucide="calendar-range" class="icon-md" aria-hidden="true"></i><span>${esc(k('week.button'))}</span>
      </button>`;
    return renderPageHeader({
      title: renderPageTitle(esc(k('title'))),
      actions: renderPageActions(weekBtn),
    }) + renderPageBody({
      content: renderPageColumns({
        main: `<div class="bs-main" id="bs-main">
            <div class="bs-days" id="bs-days" role="tablist" aria-label="${esc(k('days.label'))}"></div>
            <div class="bs-day" id="bs-day-panel" role="tabpanel" tabindex="-1"></div>
          </div>`,
        rail: '<div class="bs-rail" id="bs-rail"></div>',
      }),
    }) + `<button type="button" class="page-fab" id="bs-fab" hidden
          aria-label="${esc(k('add.fab'))}" data-dock-label="${esc(k('add.dock'))}">
          <i data-lucide="plus" class="icon-xl" aria-hidden="true"></i>
        </button>`;
  }

  async function mount() {
    container.classList.add('app-page--columns', 'bs-page');
    container.replaceChildren();
    container.insertAdjacentHTML('beforeend', shellHtml());
    fab = $('#bs-fab');
    // The router may move the FAB into the navigation; bind on the node itself.
    fab?.addEventListener('click', () => openEntryForm({ mode: 'add', day: st.day }), { signal });
    container.addEventListener('click', onClick, { signal });
    $('#bs-days').addEventListener('keydown', onDaysKey, { signal });
    wireSwipe($('#bs-day-panel'));
    renderLoading();
    icons(container);
    await load();
  }

  function renderLoading() {
    $('#bs-days').replaceChildren();
    const panel = $('#bs-day-panel');
    panel.replaceChildren();
    panel.insertAdjacentHTML('beforeend', `<div class="bs-loading" role="status" aria-live="polite">
        <span class="bs-skeleton"></span><span class="bs-skeleton"></span><span class="bs-skeleton"></span>
        <span class="bs-sr">${esc(k('loading'))}</span>
      </div>`);
  }

  async function load() {
    try {
      const data = await sidecar.state({ signal });
      if (!alive()) return;
      applyData(data);
      startPolling();
    } catch (err) {
      if (!alive() || err?.name === 'AbortError') return;
      showError(err);
    }
  }

  function showError(err) {
    const panel = $('#bs-day-panel');
    if (!panel) return;
    const reason = err instanceof SidecarError ? err.reason : null;
    $('#bs-days')?.replaceChildren();
    $('#bs-rail')?.replaceChildren();
    const setup = reason === 'not_installed' || reason === 'unreachable' || reason === 'yuvomi_unreachable';
    const box = emptyStateEl({
      variant: 'error',
      icon: reason === 'offline' ? 'wifi-off' : (reason === 'module_forbidden' ? 'lock' : 'triangle-alert'),
      title: setup ? k('error.setupTitle') : k('error.loadTitle'),
      description: errorText(err),
      hint: setup ? k('error.setupHint') : undefined,
      action: reason === 'module_forbidden' ? undefined : { label: t('common.retry'), icon: 'refresh-cw', attrs: { 'data-bs': 'retry' } },
    });
    panel.replaceChildren(box);
    icons(panel);
  }

  // ---- data -----------------------------------------------------------------

  function applyData(data) {
    if (!data || !Array.isArray(data.entries)) return;
    st.data = data;
    st.loaded = true;
    st.canWrite = data.access === 'write';
    const weekBtn = $('[data-bs="week-tools"]');
    if (weekBtn) weekBtn.hidden = !st.canWrite;
    if (fab) fab.hidden = !st.canWrite;
    renderAll();
  }

  /** Run a write; on success the sidecar returns the whole new state. */
  async function write(fn, { success } = {}) {
    st.busy += 1;
    try {
      const data = await fn();
      if (alive()) applyData(data);
      if (success) toast(typeof success === 'function' ? success(data) : success, 'success');
      return data;
    } finally {
      st.busy -= 1;
    }
  }

  /** A write from a menu: errors become a toast, and a vanished entry refreshes the list. */
  async function writeOrToast(fn, opts) {
    try {
      return await write(fn, opts);
    } catch (err) {
      toast(errorText(err), 'danger');
      if (err?.reason === 'gone') refresh();
      return null;
    }
  }

  async function refresh() {
    try {
      const data = await sidecar.state({ signal });
      if (alive()) applyData(data);
    } catch { /* the next poll tries again */ }
  }

  function startPolling() {
    if (st.pollTimer) return;
    st.pollTimer = setInterval(tick, POLL_MS);
    signal.addEventListener('abort', () => clearInterval(st.pollTimer), { once: true });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') tick();
    }, { signal });
  }

  /** Pick up the other parent's changes, and move the "now" marker along. */
  async function tick() {
    if (!alive()) { clearInterval(st.pollTimer); return; }
    if (document.visibilityState !== 'visible' || st.polling || st.busy) return;
    st.polling = true;
    try {
      const { revision } = await sidecar.revision({ signal });
      if (!alive()) return;
      if (revision !== st.data?.revision) {
        const data = await sidecar.state({ signal });
        if (alive()) applyData(data);
      } else if (st.renderedMinute !== nowMinutes() && st.day === todayIndex()) {
        renderDay();
        renderRail();
      }
    } catch { /* offline for a moment; try again on the next tick */ } finally {
      st.polling = false;
    }
  }

  const entries = () => st.data?.entries || [];
  const dayEntries = (day) => entriesForDay(entries(), day);

  // ---- rendering ------------------------------------------------------------

  function renderAll() {
    renderDays();
    renderDay();
    renderRail();
  }

  function renderDays() {
    const host = $('#bs-days');
    if (!host) return;
    const keepFocus = host.contains(document.activeElement);
    const today = todayIndex();
    host.replaceChildren();
    host.insertAdjacentHTML('beforeend', DAYS.map((d) => {
      const count = dayEntries(d).length;
      const selected = d === st.day;
      return `<button type="button" role="tab" class="bs-daytab${d === today ? ' is-today' : ''}"
          id="bs-tab-${d}" data-bs="day" data-day="${d}" aria-selected="${selected}" aria-controls="bs-day-panel"
          tabindex="${selected ? '0' : '-1'}"
          aria-label="${esc(`${dayName(d)}${d === today ? `, ${k('today')}` : ''}, ${k('count.activities', { count })}`)}">
          <span class="bs-daytab__name" aria-hidden="true">${esc(dayName(d, 'short'))}</span>
          <span class="bs-daytab__count" aria-hidden="true">${count || '–'}</span>
        </button>`;
    }).join(''));
    $('#bs-day-panel')?.setAttribute('aria-labelledby', `bs-tab-${st.day}`);
    if (keepFocus) host.querySelector(`[data-day="${st.day}"]`)?.focus();
  }

  function entryRowHtml(entry, { isNext, isPast, index, count }) {
    const cat = category(entry.category);
    const qty = quantityText(entry);
    const meta = [entry.description, entry.notes].filter(Boolean);
    const title = entryTitle(entry);
    const classes = ['bs-item', `bs-tone-${cat.tone}`, isNext && 'is-next', isPast && 'is-past'].filter(Boolean).join(' ');
    const label = `${fmtTime(entry.time)}, ${title}${qty ? `, ${qty}` : ''}`;
    const body = `
        <span class="bs-item__time">${esc(fmtTime(entry.time))}</span>
        <span class="bs-item__icon" aria-hidden="true">${cat.emoji}</span>
        <span class="bs-item__text">
          <span class="bs-item__title">${esc(title)}${qty ? ` <span class="bs-item__qty">${esc(qty)}</span>` : ''}${isNext ? ` <span class="bs-badge">${esc(k('next'))}</span>` : ''}</span>
          ${meta.length ? `<span class="bs-item__meta">${meta.map((m) => esc(m)).join(' · ')}</span>` : ''}
        </span>`;
    if (!st.canWrite) {
      return `<li class="${classes}" data-id="${esc(entry.id)}"><div class="bs-item__main">${body}</div></li>`;
    }
    return `<li class="${classes}" data-id="${esc(entry.id)}">
        <button type="button" class="bs-item__main" data-bs="edit" data-id="${esc(entry.id)}"
          aria-label="${esc(`${k('edit.aria')}: ${label}`)}">${body}</button>
        <button type="button" class="btn btn--ghost btn--icon bs-item__more" data-bs="entry-menu" data-id="${esc(entry.id)}"
          aria-label="${esc(`${k('menu.aria')}: ${label}`)}">
          <i data-lucide="ellipsis-vertical" class="icon-md" aria-hidden="true"></i>
        </button>
      </li>`;
  }

  function quickAddHtml() {
    const quick = ['milk', 'water', 'meal', 'fruits', 'sleep'];
    return `<div class="bs-quick" role="group" aria-label="${esc(k('quick.label'))}">
        ${quick.map((key) => {
          const emoji = key === 'meal' ? '🥣' : category(key).emoji;
          return `<button type="button" class="bs-chip" data-bs="quick" data-cat="${key}">
              <span aria-hidden="true">${emoji}</span>${esc(k(`quick.${key}`))}
            </button>`;
        }).join('')}
        <button type="button" class="bs-chip" data-bs="add">
          <i data-lucide="plus" class="icon-sm" aria-hidden="true"></i>${esc(k('quick.more'))}
        </button>
      </div>`;
  }

  function upNextHtml(list) {
    const now = nowMinutes();
    const s = summarizeDay(list, now);
    if (!list.length) return '';
    if (!s.next) return `<p class="bs-upnext bs-upnext--done">${esc(k('upnext.done'))}</p>`;
    const cat = category(s.next.category);
    const qty = quantityText(s.next);
    return `<p class="bs-upnext bs-tone-${cat.tone}">
        <span class="bs-upnext__label">${esc(k('upnext.label'))}</span>
        <span class="bs-upnext__what"><strong>${esc(fmtTime(s.next.time))}</strong>
          <span aria-hidden="true">${cat.emoji}</span> ${esc(entryTitle(s.next))}${qty ? ` · ${esc(qty)}` : ''}</span>
        <span class="bs-upnext__when">${esc(relativeIn(minutesOf(s.next.time) - now))}</span>
      </p>`;
  }

  function renderDay() {
    const panel = $('#bs-day-panel');
    if (!panel || !st.loaded) return;
    const day = st.day;
    const list = dayEntries(day);
    const isToday = day === todayIndex();
    const now = nowMinutes();
    st.renderedMinute = now;
    const nextAt = isToday ? nextIndex(list, now) : -1;

    const head = `<div class="bs-dayhead">
        <div class="bs-dayhead__text">
          <h2 class="bs-dayhead__title">${esc(dayName(day))}${isToday ? ` <span class="bs-badge bs-badge--today">${esc(k('today'))}</span>` : ''}</h2>
          <p class="bs-dayhead__meta">${esc(list.length ? k('count.dayMeta', { count: list.length, feeds: summarizeDay(list).feeds }) : k('count.none'))}</p>
        </div>
        ${st.canWrite ? `<button type="button" class="btn btn--ghost btn--icon bs-dayhead__menu" data-bs="day-menu"
            aria-label="${esc(k('dayMenu.aria', { day: dayName(day) }))}">
            <i data-lucide="ellipsis" class="icon-md" aria-hidden="true"></i>
          </button>` : ''}
      </div>`;

    panel.replaceChildren();
    panel.insertAdjacentHTML('beforeend', head + (st.canWrite ? quickAddHtml() : '') + (isToday ? upNextHtml(list) : ''));

    if (!list.length) {
      const hasOtherDays = entries().length > 0;
      const actions = st.canWrite ? [
        { label: k('empty.add'), icon: 'plus', attrs: { 'data-bs': 'add' } },
        hasOtherDays
          ? { label: k('empty.copyFrom'), icon: 'copy', attrs: { 'data-bs': 'copy-into' } }
          : { label: k('empty.starter'), icon: 'sparkles', attrs: { 'data-bs': 'starter' } },
      ] : undefined;
      panel.appendChild(emptyStateEl({
        icon: 'baby',
        title: k('empty.title', { day: dayName(day) }),
        description: st.canWrite ? k('empty.description') : k('empty.readOnly'),
        actions,
        className: 'bs-empty',
      }));
    } else {
      let index = 0;
      const groups = groupByPart(list).map((g) => `<section class="bs-part" aria-label="${esc(k(`part.${g.part}`))}">
          <h3 class="bs-part__title">${esc(k(`part.${g.part}`))}</h3>
          <ol class="bs-timeline">
            ${g.entries.map((e) => {
              const i = index;
              index += 1;
              return entryRowHtml(e, {
                isNext: i === nextAt,
                isPast: isToday && (nextAt === -1 || i < nextAt),
                index: i,
                count: list.length,
              });
            }).join('')}
          </ol>
        </section>`).join('');
      panel.insertAdjacentHTML('beforeend', `<div class="bs-timeline-wrap">${groups}</div>`);
    }
    icons(panel);
  }

  function renderRail() {
    const rail = $('#bs-rail');
    if (!rail || !st.loaded) return;
    const today = todayIndex();
    const list = dayEntries(today);
    const s = summarizeDay(list, nowMinutes());
    let dateText = '';
    try {
      dateText = new Intl.DateTimeFormat(loc(), { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
    } catch { dateText = dayName(today); }

    const figure = (label, value, hint = '') => `<div class="bs-figure">
        <dt>${esc(label)}</dt><dd>${esc(value)}${hint ? ` <span class="bs-figure__hint">${esc(hint)}</span>` : ''}</dd>
      </div>`;
    const timeOrDash = (e) => (e ? fmtTime(e.time) : '–');

    const todayCard = `<section class="bs-card" aria-labelledby="bs-today-title">
        <div class="bs-card__head">
          <h2 class="bs-card__title" id="bs-today-title">${esc(k('overview.today'))}</h2>
          <p class="bs-card__sub">${esc(dateText)}</p>
        </div>
        <dl class="bs-figures">
          ${figure(k('overview.activities'), String(s.total))}
          ${figure(k('overview.foods'), String(s.foods))}
          ${figure(k('overview.nextFeed'), timeOrDash(s.nextFeed), s.nextFeed ? entryTitle(s.nextFeed) : '')}
          ${figure(k('overview.nextSleep'), timeOrDash(s.nextSleep), s.nextSleep ? entryTitle(s.nextSleep) : '')}
          ${s.milkTotal ? figure(k('overview.milk'), `${formatQuantity(s.milkTotal)} ${unitLabel('ml')}`) : ''}
          ${figure(k('overview.upcoming'), s.next ? fmtTime(s.next.time) : '–', s.next ? entryTitle(s.next) : '')}
        </dl>
      </section>`;

    const weekCard = `<section class="bs-card" aria-labelledby="bs-week-title">
        <div class="bs-card__head"><h2 class="bs-card__title" id="bs-week-title">${esc(k('overview.week'))}</h2></div>
        <ul class="bs-weeklist">
          ${DAYS.map((d) => {
            const dl = dayEntries(d);
            const ds = summarizeDay(dl);
            return `<li><button type="button" class="bs-weekrow${d === st.day ? ' is-selected' : ''}" data-bs="day" data-day="${d}"
                aria-current="${d === st.day ? 'true' : 'false'}">
                <span class="bs-weekrow__day">${esc(dayName(d))}${d === today ? ` <span class="bs-badge bs-badge--today">${esc(k('today'))}</span>` : ''}</span>
                <span class="bs-weekrow__meta">${esc(dl.length ? k('count.dayMeta', { count: dl.length, feeds: ds.feeds }) : k('count.none'))}</span>
              </button></li>`;
          }).join('')}
        </ul>
      </section>`;

    rail.replaceChildren();
    rail.insertAdjacentHTML('beforeend', todayCard + weekCard);
  }

  function selectDay(day, { direction = 0, focusPanel = false } = {}) {
    if (!DAYS.includes(day)) return;
    st.day = day;
    renderDays();
    renderDay();
    renderRail();
    const panel = $('#bs-day-panel');
    if (panel && direction) {
      panel.classList.remove('bs-slide-next', 'bs-slide-prev');
      void panel.offsetWidth; // restart the animation
      panel.classList.add(direction > 0 ? 'bs-slide-next' : 'bs-slide-prev');
    }
    if (focusPanel) panel?.focus({ preventScroll: true });
  }

  // ---- events ---------------------------------------------------------------

  function onClick(e) {
    const el = e.target instanceof Element ? e.target.closest('[data-bs]') : null;
    if (!el || !container.contains(el)) return;
    const action = el.dataset.bs;
    const entry = el.dataset.id ? entries().find((x) => x.id === el.dataset.id) : null;
    switch (action) {
      case 'day': {
        const day = Number(el.dataset.day);
        const fromRail = el.classList.contains('bs-weekrow');
        selectDay(day, { direction: Math.sign(day - st.day) });
        if (fromRail) $('#bs-days')?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
        break;
      }
      case 'retry': renderLoading(); load(); break;
      case 'add': openEntryForm({ mode: 'add', day: st.day }); break;
      case 'quick': openEntryForm({ mode: 'add', day: st.day, quick: el.dataset.cat }); break;
      case 'edit': if (entry) openEntryForm({ mode: 'edit', entry }); break;
      case 'entry-menu': if (entry) openEntryMenu(entry); break;
      case 'day-menu': openDayMenu(st.day); break;
      case 'week-tools': openWeekTools(); break;
      case 'copy-into': openCopySheet({ to: st.day }); break;
      case 'starter': openStarterSheet({ days: [st.day] }); break;
      default: break;
    }
  }

  function onDaysKey(e) {
    const keys = { ArrowRight: 1, ArrowLeft: -1, Home: 'first', End: 'last' };
    if (!(e.key in keys)) return;
    e.preventDefault();
    const rtl = getComputedStyle(container).direction === 'rtl';
    let day;
    if (keys[e.key] === 'first') day = 0;
    else if (keys[e.key] === 'last') day = 6;
    else day = (st.day + (rtl ? -keys[e.key] : keys[e.key]) + 7) % 7;
    selectDay(day, { direction: Math.sign(day - st.day) });
    $('#bs-days')?.querySelector(`[data-day="${day}"]`)?.focus();
  }

  /** Swipe left/right on the day to move to the next/previous day. */
  function wireSwipe(el) {
    if (!el) return;
    let x0 = null;
    let y0 = null;
    el.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { x0 = null; return; }
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
    }, { passive: true, signal });
    el.addEventListener('touchend', (e) => {
      if (x0 === null || !st.loaded) return;
      const dx = e.changedTouches[0].clientX - x0;
      const dy = e.changedTouches[0].clientY - y0;
      x0 = null;
      if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 2) return;
      const rtl = getComputedStyle(container).direction === 'rtl';
      const step = (dx < 0) !== rtl ? 1 : -1;
      selectDay((st.day + step + 7) % 7, { direction: step });
    }, { passive: true, signal });
  }

  // ---- shared sheet parts ---------------------------------------------------

  /** Seven weekday checkboxes (or radios) in one row. */
  function dayPickerHtml({ name, selected = [], locked = [], type = 'checkbox', shortcuts = true, legend, hint = '' }) {
    return `<fieldset class="bs-daypick">
        <legend class="form-label">${esc(legend)}</legend>
        <div class="bs-daypick__grid">
          ${DAYS.map((d) => `<label class="bs-daychip">
              <input type="${type}" name="${esc(name)}" value="${d}"${selected.includes(d) || locked.includes(d) ? ' checked' : ''}${locked.includes(d) ? ' disabled' : ''}>
              <span title="${esc(dayName(d))}">${esc(dayName(d, 'short'))}</span>
            </label>`).join('')}
        </div>
        ${shortcuts && type === 'checkbox' ? `<div class="bs-daypick__shortcuts">
            <button type="button" class="bs-linkbtn" data-pick="all">${esc(k('pick.all'))}</button>
            <button type="button" class="bs-linkbtn" data-pick="weekdays">${esc(k('pick.weekdays'))}</button>
            <button type="button" class="bs-linkbtn" data-pick="weekend">${esc(k('pick.weekend'))}</button>
            <button type="button" class="bs-linkbtn" data-pick="none">${esc(k('pick.none'))}</button>
          </div>` : ''}
        ${hint ? `<p class="form-hint">${esc(hint)}</p>` : ''}
      </fieldset>`;
  }

  function wireDayPicker(root, name) {
    root.querySelectorAll('[data-pick]').forEach((btn) => btn.addEventListener('click', () => {
      const sets = { all: DAYS, weekdays: [0, 1, 2, 3, 4], weekend: [5, 6], none: [] };
      const want = sets[btn.dataset.pick] || [];
      root.querySelectorAll(`input[name="${name}"]`).forEach((input) => {
        if (!input.disabled) input.checked = want.includes(Number(input.value));
      });
    }));
  }

  const pickedDays = (root, name) => [...root.querySelectorAll(`input[name="${name}"]:checked`)]
    .filter((i) => !i.disabled).map((i) => Number(i.value));

  function modeHtml(name, { replaceLabel, appendLabel, value = 'append' }) {
    return `<fieldset class="bs-mode">
        <legend class="form-label">${esc(k('mode.legend'))}</legend>
        <label class="bs-mode__opt"><input type="radio" name="${esc(name)}" value="append"${value === 'append' ? ' checked' : ''}>
          <span><strong>${esc(appendLabel || k('mode.append'))}</strong><span class="form-hint">${esc(k('mode.appendHint'))}</span></span></label>
        <label class="bs-mode__opt"><input type="radio" name="${esc(name)}" value="replace"${value === 'replace' ? ' checked' : ''}>
          <span><strong>${esc(replaceLabel || k('mode.replace'))}</strong><span class="form-hint">${esc(k('mode.replaceHint'))}</span></span></label>
      </fieldset>`;
  }

  const pickedMode = (root, name) => root.querySelector(`input[name="${name}"]:checked`)?.value || 'append';

  function footerHtml(primaryLabel, { secondary = '', danger = '' } = {}) {
    return `<p class="form-error bs-form-error" role="alert" hidden></p>
      <div class="modal-panel__footer modal-panel__footer--plain">
        ${danger || '<div></div>'}
        <div class="bs-footer-actions">
          ${secondary}
          <button type="button" class="btn btn--primary" data-act="primary">${esc(primaryLabel)}</button>
        </div>
      </div>`;
  }

  function showFormError(panel, message) {
    const box = panel.querySelector('.bs-form-error');
    if (!box) { toast(message, 'danger'); return; }
    box.textContent = message;
    box.hidden = !message;
  }

  /** Disable the primary button while a request runs. */
  async function busyButton(btn, fn) {
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('btn--loading');
    try { await fn(); } finally {
      btn.disabled = false;
      btn.classList.remove('btn--loading');
    }
  }

  // ---- entry form -----------------------------------------------------------

  function quickCategory(quick, time) {
    if (quick !== 'meal') return quick;
    const m = minutesOf(time);
    if (m < 10 * 60 + 30) return 'breakfast';
    if (m < 15 * 60) return 'lunch';
    if (m < 17 * 60) return 'snacks';
    return 'dinner';
  }

  function unitOptions(selected, measure) {
    const order = measure === 'duration'
      ? [...DURATION_UNITS, ...UNITS.filter((u) => !DURATION_UNITS.includes(u))]
      : UNITS;
    return `<option value="">${esc(k('form.noUnit'))}</option>${order.map((u) => `<option value="${u}"${u === selected ? ' selected' : ''}>${esc(unitLabel(u))}</option>`).join('')}`;
  }

  /**
   * Add, edit or duplicate an activity.
   * mode 'add': `day`, optional `quick` category. 'edit'/'duplicate': `entry`.
   */
  function openEntryForm({ mode, entry = null, day = st.day, quick = null }) {
    if (!st.canWrite) return;
    const isEdit = mode === 'edit';
    const baseDay = entry ? entry.day : day;
    const list = dayEntries(baseDay);
    const time = entry
      ? (mode === 'duplicate' ? suggestTime(list, { after: entry.time }) : entry.time)
      : suggestTime(list);
    const catKey = entry ? entry.category : (quick ? quickCategory(quick, time) : 'milk');
    const cat = category(catKey);
    const fields = entry
      ? { title: entry.title, description: entry.description, quantity: entry.quantity, unit: entry.unit, notes: entry.notes }
      : { title: '', description: '', quantity: cat.defaults.quantity ?? null, unit: cat.defaults.unit ?? null, notes: '' };

    const title = isEdit ? k('form.editTitle') : (mode === 'duplicate' ? k('form.duplicateTitle') : k('form.addTitle', { day: dayName(baseDay) }));
    const changedBy = isEdit && entry.updatedByName
      ? `<p class="form-hint bs-changed-by">${esc(k('form.changedBy', { name: entry.updatedByName }))}</p>` : '';

    const content = `<form class="bs-form bs-sheet" novalidate>
        <fieldset class="bs-cats">
          <legend class="form-label">${esc(k('form.category'))}</legend>
          <div class="bs-cats__grid">
            ${CATEGORIES.map((c) => `<label class="bs-cat bs-tone-${c.tone}">
                <input type="radio" name="category" value="${c.key}"${c.key === catKey ? ' checked' : ''}>
                <span class="bs-cat__emoji" aria-hidden="true">${c.emoji}</span>
                <span class="bs-cat__label">${esc(k(`cat.${c.key}`))}</span>
              </label>`).join('')}
          </div>
        </fieldset>

        <div class="bs-form__row">
          <div class="form-group bs-form__time">
            <label class="form-label" for="bs-f-time">${esc(k('form.time'))}</label>
            <input class="form-input" id="bs-f-time" name="time" type="time" value="${esc(time)}" required>
          </div>
          <div class="form-group bs-form__grow">
            <label class="form-label" for="bs-f-title">${esc(k('form.name'))}</label>
            <input class="form-input" id="bs-f-title" name="title" type="text" maxlength="80" autocomplete="off"
              value="${esc(fields.title)}" placeholder="${esc(k(`catTitle.${catKey}`))}">
          </div>
        </div>

        <div class="form-group">
          <label class="form-label" for="bs-f-desc">${esc(k('form.description'))}</label>
          <input class="form-input" id="bs-f-desc" name="description" type="text" maxlength="200" autocomplete="off"
            value="${esc(fields.description)}" placeholder="${esc(k(`placeholder.${catKey}`))}">
        </div>

        <div class="form-group">
          <label class="form-label" id="bs-f-qty-label" for="bs-f-qty">${esc(cat.measure === 'duration' ? k('form.duration') : k('form.amount'))}
            <span class="form-label__hint">${esc(k('form.optional'))}</span></label>
          <div class="bs-qty">
            <input class="form-input" id="bs-f-qty" name="quantity" type="text" inputmode="decimal" autocomplete="off"
              value="${esc(formatQuantity(fields.quantity))}">
            <select class="form-input" id="bs-f-unit" name="unit" aria-label="${esc(k('form.unit'))}">${unitOptions(fields.unit, cat.measure)}</select>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label" for="bs-f-notes">${esc(k('form.notes'))} <span class="form-label__hint">${esc(k('form.optional'))}</span></label>
          <textarea class="form-input" id="bs-f-notes" name="notes" rows="2" maxlength="500">${esc(fields.notes)}</textarea>
        </div>

        ${isEdit
          ? dayPickerHtml({ name: 'days', locked: [baseDay], legend: k('form.alsoApply'), hint: k('form.alsoApplyHint', { day: dayName(baseDay) }) })
          : dayPickerHtml({ name: 'days', selected: [baseDay], legend: k('form.days'), hint: k('form.daysHint') })}
        ${changedBy}
        ${footerHtml(isEdit ? t('common.save') : t('common.add'), {
          secondary: isEdit
            ? `<button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button>`
            : `<button type="button" class="btn btn--secondary" data-act="more">${esc(k('form.addAnother'))}</button>`,
          danger: isEdit
            ? `<button type="button" class="btn btn--danger-outline" data-act="delete" data-delete-name="${esc(entryTitle(entry))}">
                <i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>${esc(t('common.delete'))}</button>`
            : '',
        })}
      </form>`;

    openSheet({
      title,
      content,
      // No automatic focus: on a phone it would pop up the time picker or keyboard
      // before the parent has seen the sheet.
      initialFocus: 'none',
      onOpen: (panel) => wireEntryForm(panel, { mode, entry, baseDay }),
    });
  }

  function wireEntryForm(panel, { mode, entry, baseDay }) {
    const form = panel.querySelector('.bs-form');
    const q = (sel) => panel.querySelector(sel);
    let amountTouched = mode !== 'add';
    let titleTouched = Boolean(entry?.title);
    wireDayPicker(panel, 'days');

    q('#bs-f-qty').addEventListener('input', () => { amountTouched = true; });
    q('#bs-f-unit').addEventListener('change', () => { amountTouched = true; });
    q('#bs-f-title').addEventListener('input', () => { titleTouched = true; });

    // Picking a category updates labels, placeholders and (for a new entry) the usual amount.
    panel.querySelectorAll('input[name="category"]').forEach((radio) => radio.addEventListener('change', () => {
      const cat = category(radio.value);
      q('#bs-f-qty-label').firstChild.textContent = `${cat.measure === 'duration' ? k('form.duration') : k('form.amount')} `;
      q('#bs-f-desc').placeholder = k(`placeholder.${cat.key}`);
      if (!titleTouched) q('#bs-f-title').placeholder = k(`catTitle.${cat.key}`);
      const unitSel = q('#bs-f-unit');
      const keepUnit = unitSel.value;
      unitSel.replaceChildren();
      unitSel.insertAdjacentHTML('beforeend', unitOptions(keepUnit, cat.measure));
      if (!amountTouched) {
        q('#bs-f-qty').value = formatQuantity(cat.defaults.quantity ?? null);
        unitSel.value = cat.defaults.unit || '';
      }
    }));

    function readFields() {
      const time = q('#bs-f-time').value;
      if (!/^\d{2}:\d{2}$/.test(time)) return { error: k('form.timeRequired'), focus: '#bs-f-time' };
      const rawQty = q('#bs-f-qty').value.trim().replace(',', '.');
      let quantity = null;
      if (rawQty) {
        quantity = Number(rawQty);
        if (!Number.isFinite(quantity) || quantity < 0) return { error: k('form.amountInvalid'), focus: '#bs-f-qty' };
      }
      return {
        entry: {
          time,
          category: panel.querySelector('input[name="category"]:checked')?.value || 'other',
          title: q('#bs-f-title').value.trim(),
          description: q('#bs-f-desc').value.trim(),
          quantity,
          unit: quantity === null ? null : (q('#bs-f-unit').value || null),
          notes: q('#bs-f-notes').value.trim(),
        },
      };
    }

    async function save({ another = false } = {}) {
      showFormError(panel, '');
      const read = readFields();
      if (read.error) {
        showFormError(panel, read.error);
        q(read.focus)?.focus();
        return;
      }
      const isEdit = mode === 'edit';
      const days = pickedDays(panel, 'days');
      if (!isEdit && !days.length) {
        showFormError(panel, k('form.daysRequired'));
        return;
      }
      try {
        if (isEdit) {
          await write(() => sidecar.updateEntry(entry.id, read.entry, days), {
            success: (data) => (days.length
              ? k('toast.updatedMany', { count: (data.result?.updated || 0) + (data.result?.created || 0) })
              : k('toast.updated')),
          });
        } else {
          await write(() => sidecar.createEntry(read.entry, days), {
            success: k('toast.added', { days: daysList(days) }),
          });
        }
        if (another) {
          // Keep category and days; clear the details and move the time on.
          q('#bs-f-time').value = timeOf(minutesOf(read.entry.time) + 30);
          q('#bs-f-title').value = '';
          q('#bs-f-desc').value = '';
          q('#bs-f-notes').value = '';
          titleTouched = false;
          markSheetClean();
          q('#bs-f-time').focus();
          return;
        }
        await closeSheet();
      } catch (err) {
        if (err?.reason === 'gone') {
          await closeSheet();
          toast(errorText(err), 'danger');
          refresh();
          return;
        }
        showFormError(panel, errorText(err));
      }
    }

    const primary = q('[data-act="primary"]');
    primary?.addEventListener('click', () => busyButton(primary, () => save()));
    const more = q('[data-act="more"]');
    more?.addEventListener('click', () => busyButton(more, () => save({ another: true })));
    form.addEventListener('submit', (e) => { e.preventDefault(); busyButton(primary, () => save()); });

    q('[data-act="delete"]')?.addEventListener('click', async () => {
      const ok = await confirmOverSheet(k('confirm.deleteEntry', { name: entryTitle(entry) }), {
        confirmLabel: esc(t('common.delete')), danger: true,
      });
      if (!ok) return;
      await writeOrToast(() => sidecar.deleteEntry(entry.id), { success: k('toast.deleted') });
    });
  }

  // ---- entry menu -----------------------------------------------------------

  function actionRow(act, icon, label, { danger = false, disabled = false, hint = '' } = {}) {
    return `<button type="button" class="bs-action${danger ? ' bs-action--danger' : ''}" data-act="${act}"${disabled ? ' disabled' : ''}>
        <i data-lucide="${icon}" class="icon-md" aria-hidden="true"></i>
        <span class="bs-action__text"><span>${esc(label)}</span>${hint ? `<span class="bs-action__hint">${esc(hint)}</span>` : ''}</span>
      </button>`;
  }

  function openEntryMenu(entry) {
    const list = dayEntries(entry.day);
    const i = list.findIndex((e) => e.id === entry.id);
    const prev = list[i - 1];
    const next = list[i + 1];
    const cat = category(entry.category);
    const content = `<div class="bs-actions bs-sheet">
        <p class="bs-actions__lead bs-tone-${cat.tone}"><span class="bs-item__icon" aria-hidden="true">${cat.emoji}</span>
          <span><strong>${esc(fmtTime(entry.time))}</strong> · ${esc(entryTitle(entry))}${quantityText(entry) ? ` · ${esc(quantityText(entry))}` : ''}</span></p>
        ${actionRow('edit', 'pencil', t('common.edit'))}
        ${actionRow('duplicate', 'copy-plus', k('menu.duplicate'), { hint: k('menu.duplicateHint') })}
        ${actionRow('repeat', 'repeat', k('menu.repeat'), { hint: k('menu.repeatHint') })}
        ${actionRow('move', 'arrow-right-left', k('menu.move'))}
        ${actionRow('earlier', 'arrow-up', k('menu.earlier'), { disabled: !prev, hint: prev ? k('menu.swapHint', { name: entryTitle(prev), time: fmtTime(prev.time) }) : '' })}
        ${actionRow('later', 'arrow-down', k('menu.later'), { disabled: !next, hint: next ? k('menu.swapHint', { name: entryTitle(next), time: fmtTime(next.time) }) : '' })}
        ${actionRow('delete', 'trash-2', t('common.delete'), { danger: true })}
      </div>`;
    openSheet({
      title: k('menu.title'),
      content,
      size: 'sm',
      dirtyGuard: false,
      onOpen: (panel) => {
        panel.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', async () => {
          const act = btn.dataset.act;
          if (act === 'edit') { openEntryForm({ mode: 'edit', entry }); return; }
          if (act === 'duplicate') { openEntryForm({ mode: 'duplicate', entry }); return; }
          if (act === 'repeat') { openRepeatSheet(entry); return; }
          if (act === 'move') { openMoveSheet(entry); return; }
          if (act === 'earlier' || act === 'later') {
            const other = act === 'earlier' ? prev : next;
            await closeSheet();
            if (other) await writeOrToast(() => sidecar.swapEntries(entry.id, other.id));
            return;
          }
          if (act === 'delete') {
            const ok = await confirm(k('confirm.deleteEntry', { name: entryTitle(entry) }), {
              confirmLabel: esc(t('common.delete')), danger: true,
            });
            if (ok) await writeOrToast(() => sidecar.deleteEntry(entry.id), { success: k('toast.deleted') });
          }
        }));
      },
    });
  }

  function openRepeatSheet(entry) {
    openSheet({
      title: k('repeat.title'),
      content: `<div class="bs-sheet">
          <p class="bs-sheet__lead">${esc(k('repeat.lead', { name: entryTitle(entry), time: fmtTime(entry.time) }))}</p>
          ${dayPickerHtml({ name: 'days', locked: [entry.day], legend: k('repeat.days'), hint: k('repeat.hint') })}
          ${footerHtml(k('repeat.confirm'))}
        </div>`,
      dirtyGuard: false,
      onOpen: (panel) => {
        wireDayPicker(panel, 'days');
        const btn = panel.querySelector('[data-act="primary"]');
        btn.addEventListener('click', () => busyButton(btn, async () => {
          const days = pickedDays(panel, 'days');
          if (!days.length) { showFormError(panel, k('form.daysRequired')); return; }
          try {
            await write(() => sidecar.repeatEntry(entry.id, days), {
              success: (data) => k('toast.repeated', { count: data.result?.created || 0 }),
            });
            await closeSheet();
          } catch (err) { showFormError(panel, errorText(err)); }
        }));
      },
    });
  }

  function openMoveSheet(entry) {
    openSheet({
      title: k('move.title'),
      content: `<div class="bs-sheet">
          <p class="bs-sheet__lead">${esc(k('move.lead', { name: entryTitle(entry), time: fmtTime(entry.time) }))}</p>
          ${dayPickerHtml({ name: 'day', type: 'radio', selected: [entry.day], legend: k('move.day'), shortcuts: false })}
          ${footerHtml(k('move.confirm'))}
        </div>`,
      dirtyGuard: false,
      onOpen: (panel) => {
        const btn = panel.querySelector('[data-act="primary"]');
        btn.addEventListener('click', () => busyButton(btn, async () => {
          const day = Number(panel.querySelector('input[name="day"]:checked')?.value);
          if (day === entry.day) { await closeSheet(); return; }
          try {
            await write(() => sidecar.moveEntry(entry.id, day), { success: k('toast.moved', { day: dayName(day) }) });
            await closeSheet();
          } catch (err) { showFormError(panel, errorText(err)); }
        }));
      },
    });
  }

  // ---- day and week tools ----------------------------------------------------

  function openDayMenu(day) {
    const count = dayEntries(day).length;
    openSheet({
      title: dayName(day),
      size: 'sm',
      dirtyGuard: false,
      content: `<div class="bs-actions bs-sheet">
          ${actionRow('add', 'plus', k('add.dock'))}
          ${actionRow('copy', 'copy', k('day.copyTo'), { disabled: !count, hint: k('day.copyToHint') })}
          ${actionRow('copy-into', 'clipboard-paste', k('day.copyFrom'))}
          ${actionRow('starter', 'sparkles', k('day.starter'))}
          ${actionRow('clear', 'eraser', k('day.clear'), { danger: true, disabled: !count })}
        </div>`,
      onOpen: (panel) => {
        panel.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', async () => {
          const act = btn.dataset.act;
          if (act === 'add') openEntryForm({ mode: 'add', day });
          else if (act === 'copy') openCopySheet({ from: day });
          else if (act === 'copy-into') openCopySheet({ to: day });
          else if (act === 'starter') openStarterSheet({ days: [day] });
          else if (act === 'clear') {
            const ok = await confirm(k('confirm.clearDay', { day: dayName(day) }), {
              detail: k('confirm.clearDayDetail', { count }), confirmLabel: esc(k('day.clearShort')), danger: true,
            });
            if (ok) await writeOrToast(() => sidecar.clearDay(day), { success: k('toast.cleared', { day: dayName(day) }) });
          }
        }));
      },
    });
  }

  function openWeekTools() {
    const total = entries().length;
    const templates = st.data?.templates || [];
    openSheet({
      title: k('week.title'),
      size: 'sm',
      dirtyGuard: false,
      content: `<div class="bs-actions bs-sheet">
          ${actionRow('copy', 'copy', k('week.copy'), { hint: k('week.copyHint') })}
          ${actionRow('templates', 'bookmark', k('week.templates'), { hint: k('count.templates', { count: templates.length }) })}
          ${actionRow('starter', 'sparkles', k('week.starter'), { hint: k('week.starterHint') })}
          ${actionRow('clear', 'eraser', k('week.clear'), { danger: true, disabled: !total })}
        </div>`,
      onOpen: (panel) => {
        panel.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', async () => {
          const act = btn.dataset.act;
          if (act === 'copy') openCopySheet({ from: st.day });
          else if (act === 'templates') openTemplatesSheet();
          else if (act === 'starter') openStarterSheet({ days: DAYS.filter((d) => !dayEntries(d).length) });
          else if (act === 'clear') {
            const ok = await confirm(k('confirm.clearWeek'), {
              detail: k('confirm.clearWeekDetail', { count: total }), confirmLabel: esc(k('week.clearShort')), danger: true,
            });
            if (ok) await writeOrToast(() => sidecar.clearWeek(), { success: k('toast.weekCleared') });
          }
        }));
      },
    });
  }

  /** Copy one day onto others. `from` preselects the source, `to` a target. */
  function openCopySheet({ from = null, to = null }) {
    const withEntries = DAYS.filter((d) => dayEntries(d).length);
    if (!withEntries.length) { toast(k('copy.nothing'), 'default'); return; }
    let source = from ?? withEntries.find((d) => d !== to) ?? withEntries[0];
    if (!dayEntries(source).length) source = withEntries[0];
    const targets = to !== null ? [to] : [];

    openSheet({
      title: k('copy.title'),
      content: `<div class="bs-sheet">
          <div class="form-group">
            <label class="form-label" for="bs-copy-from">${esc(k('copy.from'))}</label>
            <select class="form-input" id="bs-copy-from">
              ${DAYS.map((d) => `<option value="${d}"${d === source ? ' selected' : ''}${dayEntries(d).length ? '' : ' disabled'}>${esc(`${dayName(d)} (${k('count.activities', { count: dayEntries(d).length })})`)}</option>`).join('')}
            </select>
          </div>
          <div id="bs-copy-days">${dayPickerHtml({ name: 'to', selected: targets.filter((d) => d !== source), locked: [], legend: k('copy.to') })}</div>
          ${modeHtml('mode', { value: 'replace' })}
          ${footerHtml(k('copy.confirm'))}
        </div>`,
      dirtyGuard: false,
      onOpen: (panel) => {
        wireDayPicker(panel, 'to');
        const fromSel = panel.querySelector('#bs-copy-from');
        const syncSource = () => {
          const src = Number(fromSel.value);
          panel.querySelectorAll('input[name="to"]').forEach((input) => {
            const isSrc = Number(input.value) === src;
            input.disabled = isSrc;
            if (isSrc) input.checked = false;
          });
        };
        fromSel.addEventListener('change', syncSource);
        syncSource();
        const btn = panel.querySelector('[data-act="primary"]');
        btn.addEventListener('click', () => busyButton(btn, async () => {
          const src = Number(fromSel.value);
          const days = pickedDays(panel, 'to');
          const mode = pickedMode(panel, 'mode');
          if (!days.length) { showFormError(panel, k('form.daysRequired')); return; }
          try {
            await write(() => sidecar.copyDay(src, days, mode), {
              success: k('toast.copied', { from: dayName(src), days: daysList(days) }),
            });
            await closeSheet();
          } catch (err) { showFormError(panel, errorText(err)); }
        }));
      },
    });
  }

  function starterEntries() {
    return STARTER_DAY.map((s) => ({
      time: s.time,
      category: s.category,
      title: s.titleKey ? k(`starter.${s.titleKey}`) : '',
      description: s.descKey ? k(`starter.${s.descKey}`) : '',
      quantity: s.quantity ?? null,
      unit: s.unit ?? null,
      notes: '',
    }));
  }

  function openStarterSheet({ days = [] }) {
    const preview = STARTER_DAY.map((s) => `<li><span>${esc(fmtTime(s.time))}</span> <span aria-hidden="true">${category(s.category).emoji}</span>
        ${esc(s.titleKey ? k(`starter.${s.titleKey}`) : k(`catTitle.${s.category}`))}${s.quantity ? ` · ${esc(`${formatQuantity(s.quantity)} ${unitLabel(s.unit)}`)}` : ''}</li>`).join('');
    openSheet({
      title: k('starter.title'),
      content: `<div class="bs-sheet">
          <p class="bs-sheet__lead">${esc(k('starter.lead'))}</p>
          <details class="bs-preview"><summary>${esc(k('starter.preview', { count: STARTER_DAY.length }))}</summary><ul>${preview}</ul></details>
          ${dayPickerHtml({ name: 'days', selected: days, legend: k('starter.days') })}
          ${modeHtml('mode', { value: 'append' })}
          ${footerHtml(k('starter.confirm'))}
        </div>`,
      dirtyGuard: false,
      onOpen: (panel) => {
        wireDayPicker(panel, 'days');
        const btn = panel.querySelector('[data-act="primary"]');
        btn.addEventListener('click', () => busyButton(btn, async () => {
          const picked = pickedDays(panel, 'days');
          if (!picked.length) { showFormError(panel, k('form.daysRequired')); return; }
          try {
            await write(() => sidecar.bulk(starterEntries(), picked, pickedMode(panel, 'mode')), {
              success: k('toast.starter', { days: daysList(picked) }),
            });
            await closeSheet();
          } catch (err) { showFormError(panel, errorText(err)); }
        }));
      },
    });
  }

  function openTemplatesSheet() {
    const templates = st.data?.templates || [];
    const total = entries().length;
    let dateFmt;
    try { dateFmt = new Intl.DateTimeFormat(loc(), { day: 'numeric', month: 'short' }); } catch { dateFmt = null; }
    const rows = templates.map((tpl) => `<li class="bs-tpl">
        <div class="bs-tpl__text">
          <strong>${esc(tpl.name)}</strong>
          <span class="bs-tpl__meta">${esc([
            k('count.activities', { count: tpl.entryCount }),
            tpl.createdByName ? k('templates.by', { name: tpl.createdByName }) : '',
            dateFmt && tpl.createdAt ? dateFmt.format(new Date(tpl.createdAt)) : '',
          ].filter(Boolean).join(' · '))}</span>
        </div>
        <div class="bs-tpl__actions">
          <button type="button" class="btn btn--secondary btn--sm" data-tpl-apply="${esc(tpl.id)}">${esc(k('templates.apply'))}</button>
          <button type="button" class="btn btn--ghost btn--icon" data-tpl-delete="${esc(tpl.id)}" aria-label="${esc(k('templates.deleteAria', { name: tpl.name }))}">
            <i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>
          </button>
        </div>
      </li>`).join('');

    openSheet({
      title: k('templates.title'),
      dirtyGuard: false,
      content: `<div class="bs-sheet">
          <p class="bs-sheet__lead">${esc(k('templates.lead'))}</p>
          <div class="form-group">
            <label class="form-label" for="bs-tpl-name">${esc(k('templates.saveLabel'))}</label>
            <div class="bs-inline">
              <input class="form-input" id="bs-tpl-name" type="text" maxlength="60" autocomplete="off"
                placeholder="${esc(k('templates.namePlaceholder'))}"${total ? '' : ' disabled'}>
              <button type="button" class="btn btn--primary" data-act="save"${total ? '' : ' disabled'}>${esc(t('common.save'))}</button>
            </div>
            ${total ? '' : `<p class="form-hint">${esc(k('templates.emptyWeek'))}</p>`}
          </div>
          <p class="form-error bs-form-error" role="alert" hidden></p>
          <h3 class="bs-sheet__h">${esc(k('templates.saved'))}</h3>
          ${templates.length ? `<ul class="bs-tpls">${rows}</ul>` : `<p class="form-hint">${esc(k('templates.none'))}</p>`}
        </div>`,
      onOpen: (panel) => {
        const save = panel.querySelector('[data-act="save"]');
        const nameInput = panel.querySelector('#bs-tpl-name');
        const doSave = () => busyButton(save, async () => {
          const name = nameInput.value.trim();
          if (!name) { showFormError(panel, k('templates.nameRequired')); nameInput.focus(); return; }
          try {
            await write(() => sidecar.saveTemplate(name), { success: k('toast.templateSaved', { name }) });
            openTemplatesSheet();
          } catch (err) { showFormError(panel, errorText(err)); }
        });
        save?.addEventListener('click', doSave);
        nameInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } });

        panel.querySelectorAll('[data-tpl-apply]').forEach((btn) => btn.addEventListener('click', () => {
          const tpl = templates.find((x) => x.id === btn.dataset.tplApply);
          if (tpl) openApplyTemplateSheet(tpl);
        }));
        panel.querySelectorAll('[data-tpl-delete]').forEach((btn) => btn.addEventListener('click', async () => {
          const tpl = templates.find((x) => x.id === btn.dataset.tplDelete);
          if (!tpl) return;
          const ok = await confirmOverSheet(k('confirm.deleteTemplate', { name: tpl.name }), {
            confirmLabel: esc(t('common.delete')), danger: true, closeOnConfirm: false,
          });
          if (!ok) return;
          const done = await writeOrToast(() => sidecar.deleteTemplate(tpl.id), { success: k('toast.templateDeleted') });
          if (done) openTemplatesSheet();
        }));
      },
    });
  }

  function openApplyTemplateSheet(tpl) {
    openSheet({
      title: k('templates.applyTitle', { name: tpl.name }),
      dirtyGuard: false,
      content: `<div class="bs-sheet">
          <p class="bs-sheet__lead">${esc(k('templates.applyLead', { count: tpl.entryCount }))}</p>
          ${modeHtml('mode', { value: 'replace', replaceLabel: k('templates.replaceWeek'), appendLabel: k('templates.addToWeek') })}
          ${footerHtml(k('templates.apply'))}
        </div>`,
      onOpen: (panel) => {
        const btn = panel.querySelector('[data-act="primary"]');
        btn.addEventListener('click', () => busyButton(btn, async () => {
          try {
            await write(() => sidecar.applyTemplate(tpl.id, pickedMode(panel, 'mode')), {
              success: k('toast.templateApplied', { name: tpl.name }),
            });
            await closeSheet();
          } catch (err) { showFormError(panel, errorText(err)); }
        }));
      },
    });
  }

  return { mount, showError };
}
