/**
 * Sheets and confirmations.
 *
 * Uses Yuvomi's own dialog (`/components/modal.js`), so a sheet here slides,
 * swipes, traps focus and handles the back gesture exactly like every other
 * module. That file is a public browser file but sits outside the `/utils/`
 * surface MODULES.md names, so it is loaded lazily, and a small native
 * <dialog> with the same class names takes over if it ever moves.
 */

import { esc } from '/utils/html.js';
import { t } from '/i18n.js';

let core = null;
let coreTried = false;

async function loadCore() {
  if (!coreTried) {
    coreTried = true;
    try {
      const mod = await import('/components/modal.js');
      if (typeof mod.openModal === 'function' && typeof mod.closeModal === 'function') core = mod;
    } catch {
      core = null;
    }
  }
  return core;
}

// ---- fallback --------------------------------------------------------------

let fallbackDialog = null;

function fallbackClose() {
  const dialog = fallbackDialog;
  fallbackDialog = null;
  if (!dialog) return;
  const onClose = dialog._onClose;
  if (dialog.open) dialog.close();
  dialog.remove();
  onClose?.();
}

function fallbackOpen({ title, content, onOpen, onClose }) {
  fallbackClose();
  document.body.insertAdjacentHTML('beforeend', `
    <dialog class="modal-overlay bs-fallback-dialog" aria-labelledby="bs-fallback-title">
      <div class="modal-panel">
        <div class="modal-panel__header">
          <h2 class="modal-panel__title" id="bs-fallback-title">${esc(title)}</h2>
          <div class="modal-panel__header-actions">
            <button type="button" class="modal-panel__close" data-action="close-modal" aria-label="${esc(t('modal.closeLabel'))}">
              <i data-lucide="x" class="icon-md" aria-hidden="true"></i>
            </button>
          </div>
        </div>
        <div class="modal-panel__body">${content}</div>
      </div>
    </dialog>`);
  const dialog = document.body.lastElementChild;
  fallbackDialog = dialog;
  dialog._onClose = onClose;
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || (e.target instanceof Element && e.target.closest('[data-action="close-modal"]'))) fallbackClose();
  });
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); fallbackClose(); });
  dialog.showModal();
  window.lucide?.createIcons?.({ el: dialog });
  onOpen?.(dialog.querySelector('.modal-panel'));
}

// ---- public ----------------------------------------------------------------

/**
 * Open a sheet. `content` is markup the caller has escaped; `onOpen(panel)`
 * wires it. Only one sheet is open at a time, as everywhere in Yuvomi.
 */
export async function openSheet({ title, content, onOpen, onClose, size = 'md', dirtyGuard = true, initialFocus }) {
  const c = await loadCore();
  if (c) {
    c.openModal({
      title,
      content,
      size,
      dirtyGuard,
      ...(initialFocus ? { initialFocus } : {}),
      onSave: (panel) => onOpen?.(panel),
      onClose,
    });
  } else {
    fallbackOpen({ title, content, onOpen, onClose });
  }
}

export async function closeSheet() {
  const c = await loadCore();
  if (c) await c.closeModal({ force: true });
  else fallbackClose();
}

/** A yes/no question. Resolves true when confirmed. */
export async function confirm(message, { confirmLabel, danger = false, detail = null } = {}) {
  const c = await loadCore();
  if (c?.confirmModal) return c.confirmModal(message, { confirmLabel, danger, detail });
  // eslint-disable-next-line no-alert
  return window.confirm(detail ? `${message}\n\n${detail}` : message);
}

/**
 * A question asked over an open sheet: the sheet comes back when the answer
 * is no. On yes the sheet closes.
 */
export async function confirmOverSheet(message, opts = {}) {
  const c = await loadCore();
  if (c?.confirmOverModal) return c.confirmOverModal(message, opts);
  return confirm(message, opts);
}

/**
 * Tell the sheet its current field values are the new "unchanged" state,
 * so closing after "Add another" does not ask to discard changes.
 */
export async function markSheetClean() {
  const c = await loadCore();
  try { c?.refreshDirtySnapshot?.(); } catch { /* the guard only asks once more */ }
}

export function toast(message, type = 'default') {
  if (typeof window.yuvomi?.showToast === 'function') window.yuvomi.showToast(message, type);
}
