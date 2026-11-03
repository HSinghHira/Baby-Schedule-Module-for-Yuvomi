/**
 * "Baby today" dashboard widget.
 *
 * Yuvomi's "Today at a glance" is built from core data only (events, meals,
 * shifts) and takes no rows from modules, so the module's place on the home
 * screen is this widget (MODULES.md, capabilities.widgets). It shows what is
 * next for the baby today and the rest of the day, and refreshes every minute.
 *
 * Contract: `renderWidget(container, { size, options, user })`. Core draws the
 * error tile if this throws; everything else, including the header, is ours.
 * The manifest's style.css is not loaded on the dashboard, so the widget
 * brings its own small stylesheet.
 */

import { t, formatTime, getLocale } from '/i18n.js';
import { esc } from '/utils/html.js';
import { sidecar, SidecarError } from '../lib/client.js';
import {
  category, entriesForDay, summarizeDay, nextIndex, formatQuantity, minutesOf, weekdayOf,
} from '../lib/schedule.js';

const ID = 'baby-schedule';
const ROUTE = `/m/${ID}`;
const ACCENT = '#6574E0';
const REFRESH_MS = 60000;
const k = (key, params = {}) => t(`extensions.${ID}.${key}`, params);

function ensureStyles() {
  const href = new URL('./today.css', import.meta.url).href;
  if (document.querySelector(`link[data-bs-widget-css]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.bsWidgetCss = '1';
  document.head.appendChild(link);
}

const fmtTime = (time) => formatTime(time) || time;
const nowMinutes = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

function relativeIn(minutes) {
  try {
    const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' });
    return minutes < 60 ? rtf.format(Math.max(0, minutes), 'minute') : rtf.format(Math.round(minutes / 60), 'hour');
  } catch {
    return '';
  }
}

function titleOf(entry) {
  return entry.title || k(`catTitle.${category(entry.category).key}`);
}

function qtyOf(entry) {
  const q = formatQuantity(entry.quantity);
  if (!q) return '';
  return entry.unit ? `${q} ${k(`unit.${entry.unit}`)}` : q;
}

function headerHtml(count) {
  const title = k('widget.title');
  const badge = count > 0
    ? `<span aria-hidden="true" class="widget__badge">${count}</span><span class="sr-only">${esc(k('count.activities', { count }))}</span>`
    : '';
  return `<div class="widget__header">
      <h3 class="widget__title">
        <span class="module-seal module-seal--sm" style="--seal-accent: ${ACCENT}" aria-hidden="true">
          <i data-lucide="baby" class="icon-md" aria-hidden="true"></i>
        </span>
        <span class="widget__title-text">${esc(title)}</span>
        ${badge}
      </h3>
      <a href="${ROUTE}" data-bs-open class="widget__link" aria-label="${esc(k('widget.openAria'))}">${esc(k('widget.open'))}</a>
    </div>`;
}

function rowHtml(entry, { isNext }) {
  const cat = category(entry.category);
  const qty = qtyOf(entry);
  const detail = entry.description || '';
  return `<li class="bsw-row bsw-tone-${cat.tone}${isNext ? ' is-next' : ''}">
      <span class="bsw-row__time">${esc(fmtTime(entry.time))}</span>
      <span class="bsw-row__icon" aria-hidden="true">${cat.emoji}</span>
      <span class="bsw-row__text">
        <span class="bsw-row__title">${esc(titleOf(entry))}${qty ? ` <span class="bsw-row__qty">${esc(qty)}</span>` : ''}</span>
        ${detail ? `<span class="bsw-row__meta">${esc(detail)}</span>` : ''}
      </span>
    </li>`;
}

function bodyHtml(list, size) {
  const now = nowMinutes();
  const rows = Number(String(size || '1x2').split('x')[1]) >= 2 ? 6 : 3;
  if (!list.length) {
    return `<p class="widget__empty bsw-empty">${esc(k('widget.empty'))}
        <a href="${ROUTE}" data-bs-open class="bsw-link">${esc(k('widget.plan'))}</a></p>`;
  }
  const at = nextIndex(list, now);
  if (at === -1) {
    return `<p class="widget__empty bsw-empty">${esc(k('upnext.done'))}</p>`;
  }
  const next = list[at];
  const s = summarizeDay(list, now);
  const upcoming = list.slice(at, at + rows);
  const later = list.length - at - upcoming.length;
  return `<div class="bsw-next bsw-tone-${category(next.category).tone}">
      <span class="bsw-next__label">${esc(k('upnext.label'))} · ${esc(relativeIn(minutesOf(next.time) - now))}</span>
    </div>
    <ol class="bsw-list">${upcoming.map((e, i) => rowHtml(e, { isNext: i === 0 })).join('')}</ol>
    <p class="bsw-foot">${esc([
      s.nextFeed ? k('widget.nextFeed', { time: fmtTime(s.nextFeed.time) }) : '',
      s.nextSleep ? k('widget.nextSleep', { time: fmtTime(s.nextSleep.time) }) : '',
      later > 0 ? k('widget.more', { count: later }) : '',
    ].filter(Boolean).join(' · '))}</p>`;
}

function errorHtml(err) {
  const reason = err instanceof SidecarError ? err.reason : null;
  const key = reason === 'module_forbidden' ? 'error.module_forbidden'
    : (reason === 'offline' ? 'error.offline' : 'widget.unavailable');
  return `<p class="widget__empty bsw-empty">${esc(k(key))}</p>`;
}

export async function renderWidget(container, { size } = {}) {
  ensureStyles();
  let timer = null;

  async function draw() {
    if (!container.isConnected && timer) { clearInterval(timer); return; }
    let html;
    try {
      const data = await sidecar.state();
      const list = entriesForDay(data?.entries || [], weekdayOf(new Date()));
      html = headerHtml(list.length) + `<div class="bsw-body">${bodyHtml(list, size)}</div>`;
    } catch (err) {
      html = headerHtml(0) + `<div class="bsw-body">${errorHtml(err)}</div>`;
    }
    container.replaceChildren();
    container.insertAdjacentHTML('beforeend', html);
    container.querySelectorAll('[data-bs-open]').forEach((a) => a.addEventListener('click', (e) => {
      if (typeof window.yuvomi?.navigate !== 'function' || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      window.yuvomi.navigate(ROUTE);
    }));
    try { window.lucide?.createIcons?.({ el: container }); } catch { /* decoration */ }
  }

  container.classList.add('bsw');
  await draw();
  // Keep "up next" current while the dashboard stays open; stop once the
  // tile is gone (navigation, layout change).
  timer = setInterval(() => {
    if (!container.isConnected) { clearInterval(timer); return; }
    if (document.visibilityState === 'visible') draw();
  }, REFRESH_MS);
}
