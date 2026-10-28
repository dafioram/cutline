// Tiny DOM helpers and the icon set.

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

const P = {
  import: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v3h16v-3"/>',
  undo: '<path d="M9 7H5V3"/><path d="M5 7a8 8 0 1 1-1.5 9"/>',
  redo: '<path d="M15 7h4V3"/><path d="M19 7a8 8 0 1 0 1.5 9"/>',
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/>',
  stepBack: '<path d="M6 5v14"/><path d="M18 6l-8 6 8 6z" fill="currentColor"/>',
  stepFwd: '<path d="M18 5v14"/><path d="M6 6l8 6-8 6z" fill="currentColor"/>',
  toStart: '<path d="M5 5v14"/><path d="M19 6l-10 6 10 6z" fill="currentColor"/>',
  split: '<circle cx="6" cy="7" r="2.5"/><circle cx="6" cy="17" r="2.5"/><path d="M8 8.5l12 8M8 15.5l12-8"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  marker: '<path d="M6 21V4M6 4h11l-3 4 3 4H6"/>',
  export: '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 14v6h16v-6"/>',
  share: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 12h2.5v2.5H8zM13 10v5M16 10h3M16 12.5h2"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  storyboard: '<rect x="3" y="6" width="5" height="12" rx="1"/><rect x="10" y="6" width="5" height="12" rx="1"/><rect x="17" y="6" width="4" height="12" rx="1"/>',
  timeline: '<path d="M3 7h12M3 12h18M3 17h9"/>',
  zoomIn: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5M11 8v6M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5M8 11h6"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  music: '<path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M4 18l5-5 4 4 3-3 4 4"/>',
  title: '<path d="M5 6h14M12 6v13M9 19h6"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
  text: '<path d="M5 7V5h14v2M12 5v14M9 19h6"/>',
  lowerthird: '<rect x="3" y="14" width="13" height="5" rx="1"/><path d="M3 14h1.5v5H3z" fill="currentColor"/>',
  part: '<rect x="3" y="6" width="7" height="12" rx="1"/><rect x="14" y="6" width="7" height="12" rx="1" stroke-dasharray="2 2"/>',
  blur: '<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 2"/><path d="M8 9h2M14 9h2M8 15h2M14 15h2M11 12h2"/>',
  subtitles: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 13h4M13 13h4M7 16h7"/>',
  shape: '<path d="M4 12h12M12 7l5 5-5 5"/>',
  date: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  logo: '<path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  magnet: '<path d="M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4z"/>',
  more: '<circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/>',
  crossfade: '<path d="M3 18L21 6"/><rect x="3" y="6" width="18" height="12" rx="1"/>',
  fadeblack: '<rect x="3" y="6" width="18" height="12" rx="1"/><path d="M12 6v12" /><rect x="12" y="6" width="9" height="12" fill="currentColor" opacity=".55"/>',
  wipe: '<rect x="3" y="6" width="18" height="12" rx="1"/><rect x="3" y="6" width="9" height="12" fill="currentColor" opacity=".55"/><path d="M14 12h4M16 10l2 2-2 2"/>',
  folder: '<path d="M3 7h6l2 2h10v10H3z"/>',
  speaker: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6"/>',
  mute: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9l5 6M21 9l-5 6"/>',
  freeze: '<path d="M12 3v18M4.5 7.5l15 9M19.5 7.5l-15 9"/>',
};

export function icon(name, size = 18) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
  return span;
}

export function button(label, { iconName, onClick, title, cls = '', primary = false, disabled = false, kbd } = {}) {
  const b = h('button', { class: `btn ${primary ? 'btn-primary' : ''} ${cls}`.trim(), type: 'button', title: title || (kbd ? `${label} (${kbd})` : null), 'aria-label': label, disabled, onclick: onClick });
  if (iconName) b.append(icon(iconName));
  if (label && !cls.includes('icon-only')) b.append(h('span', { class: 'btn-label' }, label));
  return b;
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export const OVERLAY_ICON = { clock: 'clock', image: 'logo', text: 'text', lowerthird: 'lowerthird', part: 'part', blur: 'blur', subtitles: 'subtitles', shape: 'shape', date: 'date' };

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
