// Toasts and modal dialogs.

import { h, icon } from './dom.js';

let toastHost = null;

export function toast(message, { kind = 'info', action = null, timeout = 5000 } = {}) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const el = h('div', { class: `toast toast-${kind}` }, kind === 'error' ? icon('warn', 16) : null, h('span', { class: 'toast-text' }, message));
  if (action) {
    el.append(
      h(
        'button',
        {
          class: 'btn btn-small',
          type: 'button',
          onclick: () => {
            action.run();
            el.remove();
          },
        },
        action.label,
      ),
    );
  }
  const close = h('button', { class: 'btn btn-small icon-only toast-close', type: 'button', 'aria-label': 'Dismiss', onclick: () => el.remove() }, icon('close', 14));
  el.append(close);
  toastHost.append(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}

/**
 * Modal dialog. Resolves with the clicked button's value (or null when dismissed).
 * `body` may be a Node or a function receiving {close} that returns a Node.
 */
export function modal({ title, body, buttons = [{ label: 'OK', value: true, primary: true }], dismissible = true, wide = false, onOpen } = {}) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      prevFocus && prevFocus.focus && prevFocus.focus();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && dismissible) {
        e.stopPropagation();
        close(null);
      }
    };
    const content = typeof body === 'function' ? body({ close }) : body;
    const footer = h('div', { class: 'dialog-buttons' });
    for (const b of buttons) {
      const btn = h('button', { class: `btn ${b.primary ? 'btn-primary' : ''} ${b.danger ? 'btn-danger' : ''}`, type: 'button', onclick: () => (b.onClick ? b.onClick(close) : close(b.value)) }, b.label);
      if (b.id) btn.id = b.id;
      footer.append(btn);
    }
    const dialog = h(
      'div',
      { class: `dialog ${wide ? 'dialog-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'dialog-head' }, h('h2', {}, title), dismissible ? h('button', { class: 'btn icon-only', type: 'button', 'aria-label': 'Close', onclick: () => close(null) }, icon('close', 16)) : null),
      h('div', { class: 'dialog-body' }, content),
      buttons.length ? footer : null,
    );
    const backdrop = h('div', { class: 'backdrop', onmousedown: (e) => e.target === backdrop && dismissible && close(null) }, dialog);
    document.body.append(backdrop);
    document.addEventListener('keydown', onKey, true);
    const focusable = dialog.querySelector('input, select, textarea, .btn-primary, button');
    focusable && focusable.focus();
    onOpen && onOpen({ close, dialog, footer });
  });
}

export function confirmDialog(title, message, { ok = 'OK', cancel = 'Cancel', danger = false } = {}) {
  return modal({
    title,
    body: h('p', {}, message),
    buttons: [
      { label: cancel, value: false },
      { label: ok, value: true, primary: !danger, danger },
    ],
  }).then((v) => v === true);
}

export function messageDialog(title, message) {
  return modal({ title, body: h('p', {}, message), buttons: [{ label: 'OK', value: true, primary: true }] });
}
