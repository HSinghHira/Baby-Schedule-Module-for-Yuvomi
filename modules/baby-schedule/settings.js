/**
 * Settings -> Modules -> Baby Schedule (household section, admins only).
 *
 * One button turns on the "Today at a glance" bridge: the Baby Schedule
 * service keeps one Yuvomi task for the baby's current or next activity, so it
 * shows on the home screen's "Today at a glance" and in Wall Mode.
 *
 * The service needs an API token with tasks:write, because it must create the
 * next task even when nobody has Yuvomi open (e.g. after a tick on the wall
 * tablet). "Turn on" creates that token through the admin's own signed-in
 * session (POST /api/v1/auth/api-tokens, admin + CSRF, handled by /api.js) and
 * hands it to the service, which keeps it and never sends it back. Pasting a
 * token by hand stays possible under "Advanced".
 *
 * The manifest's style.css is not loaded here; the sheet uses Yuvomi's form
 * classes.
 */

import { api } from '/api.js';
import { t, getLocale } from '/i18n.js';
import { esc } from '/utils/html.js';
import { SidecarError } from './lib/client.js';
import { CATEGORIES, UNITS } from './lib/schedule.js';

const ID = 'baby-schedule';
const BASE = `/api/extensions/${ID}`;
const k = (key, params = {}) => t(`extensions.${ID}.${key}`, params);

let csrf = '';

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' && csrf ? { 'x-baby-schedule-csrf': csrf } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new SidecarError(0, 'offline', null);
  }
  if (!res.headers.get('x-baby-schedule-sidecar')) throw new SidecarError(res.status, 'not_installed', null);
  csrf = res.headers.get('x-baby-schedule-csrf') || csrf;
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new SidecarError(res.status, json?.reason, json?.error);
  return json?.data;
}

function labels() {
  const catTitle = {};
  for (const c of CATEGORIES) catTitle[c.key] = k(`catTitle.${c.key}`);
  const unit = {};
  for (const u of UNITS) unit[u] = k(`unit.${u}`);
  return { catTitle, unit, from: k('bridge.taskNote') };
}

function timeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

function errorText(err) {
  const reason = err?.reason || err;
  const known = ['token_invalid', 'token_forbidden', 'yuvomi_unreachable', 'yuvomi_unavailable', 'not_installed', 'offline', 'admin_only', 'internal', 'csrf_invalid', 'token_create_failed'];
  if (known.includes(reason)) return k(`bridge.error.${reason}`);
  if (err?.message && err?.reason === 'invalid') return err.message;
  return k('error.generic');
}

function statusHtml(s) {
  if (!s.enabled) return `<p class="form-hint">${esc(k('bridge.statusOff'))}</p>`;
  if (s.lastError) return `<p class="form-error" role="status">${esc(errorText(s.lastError))}</p>`;
  if (s.task) {
    let time = s.task.time;
    try {
      const [h, m] = s.task.time.split(':').map(Number);
      time = new Intl.DateTimeFormat(getLocale(), { hour: 'numeric', minute: '2-digit' }).format(new Date(2000, 0, 1, h, m));
    } catch { /* keep HH:MM */ }
    return `<p class="form-hint form-hint--success" role="status">${esc(k('bridge.statusTask', { title: s.task.title, time }))}</p>`;
  }
  return `<p class="form-hint form-hint--success" role="status">${esc(k('bridge.statusIdle'))}</p>`;
}

/** A Tasks-only token, made with the admin's own session. */
async function createToken() {
  try {
    const res = await api.post('/auth/api-tokens', { name: k('bridge.tokenName'), scopes: ['tasks:write'] });
    if (!res?.token) throw new Error('no token in answer');
    return res.token;
  } catch {
    throw new SidecarError(0, 'token_create_failed', null);
  }
}

export async function render(container, { section } = {}) {
  if (section !== 'household') { container.replaceChildren(); return; }

  const draw = (s) => {
    container.replaceChildren();
    container.insertAdjacentHTML('beforeend', `
      <h3>${esc(k('bridge.title'))}</h3>
      <p class="form-hint">${esc(k('bridge.lead'))}</p>
      <div data-status>${statusHtml(s)}</div>
      <p class="form-error" role="alert" data-error hidden></p>
      <div style="display: flex; justify-content: flex-end; gap: 0.5rem; margin: 0.5rem 0 1rem;">
        ${s.enabled
          ? `<button type="button" class="btn btn--secondary" data-act="off">${esc(k('bridge.turnOff'))}</button>`
          : `<button type="button" class="btn btn--primary" data-act="on">${esc(k('bridge.turnOn'))}</button>`}
      </div>
      <details>
        <summary class="form-hint" style="cursor: pointer; min-height: 44px; display: flex; align-items: center;">${esc(k('bridge.advanced'))}</summary>
        <div class="form-group">
          <label class="form-label" for="bs-bridge-token">${esc(k('bridge.tokenLabel'))}</label>
          <input class="form-input" id="bs-bridge-token" type="password" autocomplete="off" spellcheck="false"
            placeholder="${esc(s.hasToken ? k('bridge.tokenSaved') : 'yuvomi_…')}">
          <p class="form-hint">${esc(k('bridge.tokenHint'))}</p>
        </div>
        <div style="display: flex; justify-content: flex-end;">
          <button type="button" class="btn btn--secondary" data-act="paste">${esc(k('bridge.useToken'))}</button>
        </div>
      </details>`);

    const showError = (err) => {
      const box = container.querySelector('[data-error]');
      box.textContent = errorText(err);
      box.hidden = false;
    };

    const run = (btn, fn) => async () => {
      btn.disabled = true;
      btn.classList.add('btn--loading');
      try {
        if (!csrf) await call('GET', '/bridge');
        await fn();
      } catch (err) {
        showError(err);
      } finally {
        btn.disabled = false;
        btn.classList.remove('btn--loading');
      }
    };

    const base = () => ({ timeZone: timeZone(), labels: labels() });

    const on = container.querySelector('[data-act="on"]');
    on?.addEventListener('click', run(on, async () => {
      let next;
      if (s.hasToken) {
        try {
          next = await call('PUT', '/bridge', { ...base(), enabled: true });
        } catch (err) {
          // The saved token was revoked meanwhile: make a fresh one.
          if (!['token_invalid', 'token_forbidden'].includes(err?.reason)) throw err;
        }
      }
      if (!next || next.lastError === 'token_invalid' || next.lastError === 'token_forbidden') {
        next = await call('PUT', '/bridge', { ...base(), enabled: true, token: await createToken() });
      }
      draw(next);
      window.yuvomi?.showToast?.(k('bridge.savedOn'), 'success');
    }));

    const off = container.querySelector('[data-act="off"]');
    off?.addEventListener('click', run(off, async () => {
      draw(await call('PUT', '/bridge', { enabled: false }));
      window.yuvomi?.showToast?.(k('bridge.savedOff'), 'success');
    }));

    const paste = container.querySelector('[data-act="paste"]');
    paste?.addEventListener('click', run(paste, async () => {
      const token = container.querySelector('#bs-bridge-token').value.trim();
      if (!token) { container.querySelector('#bs-bridge-token').focus(); return; }
      draw(await call('PUT', '/bridge', { ...base(), enabled: true, token }));
      window.yuvomi?.showToast?.(k('bridge.savedOn'), 'success');
    }));
  };

  try {
    draw(await call('GET', '/bridge'));
  } catch (err) {
    container.replaceChildren();
    container.insertAdjacentHTML('beforeend', `<h3>${esc(k('bridge.title'))}</h3>
      <p class="form-error" role="alert">${esc(errorText(err))}</p>`);
  }
}
