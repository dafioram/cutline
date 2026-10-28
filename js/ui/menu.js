// Right-click menus.

import { h } from './dom.js';

let current = null;

export function closeMenu() {
  if (current) {
    current.remove();
    current = null;
  }
}

/** items: [{label, kbd, onClick, disabled, danger} | 'sep'] */
export function showMenu(x, y, items) {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it === 'sep') {
      menu.append(h('div', { class: 'menu-sep', role: 'separator' }));
      continue;
    }
    const b = h(
      'button',
      {
        class: `menu-item ${it.danger ? 'danger' : ''}`,
        role: 'menuitem',
        type: 'button',
        disabled: it.disabled,
        onclick: () => {
          closeMenu();
          it.onClick && it.onClick();
        },
      },
      h('span', {}, it.label),
      it.kbd ? h('span', { class: 'menu-kbd' }, it.kbd) : null,
    );
    menu.append(b);
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 6)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 6)}px`;
  current = menu;
  const buttons = [...menu.querySelectorAll('button:not([disabled])')];
  buttons[0] && buttons[0].focus();
  menu.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      buttons[(i + 1) % buttons.length].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      buttons[(i - 1 + buttons.length) % buttons.length].focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
    }
    e.stopPropagation();
  });
}

window.addEventListener('mousedown', (e) => {
  if (current && !current.contains(e.target)) closeMenu();
});
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);
