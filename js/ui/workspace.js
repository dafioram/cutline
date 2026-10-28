// Workspace panel: imported media (with scenes and saved clips grouped under their file),
// transitions and overlays to drag onto the timeline.

import { h, icon, clear, button, OVERLAY_ICON } from './dom.js';
import { showMenu } from './menu.js';
import { startDrag, endDrag, isFileDrag } from './drag.js';
import { TRANSITIONS, OVERLAY_KINDS } from '../core/model.js';
import { formatRuler } from '../core/time.js';

const KIND_ICON = { video: 'film', audio: 'music', image: 'image' };
const OVERLAY_HELP = {
  clock: 'Counts movie time in H:MM:SS',
  image: 'A logo or watermark image',
  text: 'Text anywhere on screen',
  lowerthird: 'Name and caption bar',
  part: '“Part 2 of 6” when splitting',
  blur: 'Hide a face, plate or screen',
  subtitles: 'Import an .srt file',
  shape: 'Arrow, box or circle',
  date: 'Recording date, camcorder style',
};

function ring(progress, label) {
  const r = 14;
  const c = 2 * Math.PI * r;
  const p = Math.max(0.02, Math.min(1, progress || 0));
  const el = h('div', { class: 'ring' });
  el.innerHTML = `<svg width="36" height="36" viewBox="0 0 36 36"><circle cx="18" cy="18" r="${r}" stroke="rgba(255,255,255,.2)" stroke-width="3" fill="none"/><circle cx="18" cy="18" r="${r}" stroke="#f2a93b" stroke-width="3" fill="none" stroke-dasharray="${c * p} ${c}" stroke-linecap="round"/></svg>`;
  if (label) el.append(h('div', { class: 'ring-label' }, label));
  return el;
}

export function mountWorkspace(root, app) {
  const { store, media, actions } = app;
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const body = h('div', { class: 'tab-body' });
  root.append(tabs, body);

  const tabDefs = [
    ['media', 'Media'],
    ['transitions', 'Transitions'],
    ['overlays', 'Overlays'],
  ];

  // Dropping files anywhere on the workspace imports them.
  root.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    root.classList.add('drag-over');
  });
  root.addEventListener('dragleave', (e) => {
    if (!root.contains(e.relatedTarget)) root.classList.remove('drag-over');
  });
  root.addEventListener('drop', (e) => {
    root.classList.remove('drag-over');
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    actions.importFiles([...e.dataTransfer.files]);
    store.setView({ workspaceTab: 'media' });
  });

  function renderTabs() {
    clear(tabs);
    for (const [id, label] of tabDefs) {
      tabs.append(
        h(
          'button',
          {
            class: 'tab',
            role: 'tab',
            type: 'button',
            'aria-selected': String(store.view.workspaceTab === id),
            onclick: () => store.setView({ workspaceTab: id }),
          },
          label,
        ),
      );
    }
  }

  function binItemEl(item, children) {
    const m = store.project.media[item.mediaId];
    if (!m) return null;
    const st = media.getStatus(m.id);
    const isChild = !!item.parentId;
    const thumbSrc = m.kind === 'video' ? media.thumbAt(m.id, isChild ? ((item.in || 0) + (item.out ?? m.duration)) / 2 : m.duration * 0.1) : media.thumbs.get(m.id);
    const thumb = h('div', { class: `bin-thumb ${m.kind === 'audio' ? 'audio' : ''}` });
    if (thumbSrc) thumb.style.backgroundImage = `url(${thumbSrc})`;
    else thumb.append(icon(KIND_ICON[m.kind], 22));
    const busy = ['importing', 'converting', 'saving'].includes(st.state) || st.scanning;
    if (busy) thumb.append(ring(st.progress, st.message));

    const len = isChild ? (item.out ?? m.duration) - (item.in || 0) : m.duration;
    const sub = h('div', { class: 'bin-sub' });
    if (st.state === 'error') sub.append(h('span', { class: 'warn' }, 'Couldn’t import'));
    else if (st.state === 'missing') sub.append(h('span', { class: 'warn' }, 'File missing'));
    else if (busy) sub.append(st.message || 'Importing');
    else {
      sub.append(icon(KIND_ICON[m.kind], 13));
      if (m.kind !== 'image') sub.append(formatRuler(len));
      else if (m.width) sub.append(`${m.width}×${m.height}`);
      if (m.converted && !isChild) sub.append(' · converted');
    }
    const selected = store.selection.has(item.id);
    const el = h(
      'div',
      {
        class: `bin-item ${isChild ? 'child' : ''} ${children.length ? 'has-children' : ''} ${selected ? 'selected' : ''}`,
        draggable: st.state === 'ready' ? 'true' : 'false',
        tabindex: '0',
        role: 'button',
        'aria-label': `${item.name}${st.state === 'missing' ? ', file missing' : ''}`,
        title: st.state === 'error' ? st.message : `${m.name}\nDrag to the timeline, or double-click to trim it first.`,
        onclick: (e) => store.select([item.id], { toggle: e.ctrlKey || e.metaKey, add: e.shiftKey }),
        ondblclick: () => app.openSource(item.id),
        onkeydown: (e) => {
          if (e.key === 'Enter') app.openSource(item.id);
        },
        ondragstart: (e) => startDrag(e, { type: 'bin', id: item.id }, item.name),
        ondragend: endDrag,
        oncontextmenu: (e) => {
          e.preventDefault();
          store.select([item.id]);
          const items = [
            { label: 'Add to end of movie', disabled: st.state !== 'ready', onClick: () => actions.addBinItem(item.id) },
            { label: 'Open in preview to trim', disabled: st.state !== 'ready', onClick: () => app.openSource(item.id) },
          ];
          if (m.kind === 'video' && !isChild) items.push({ label: 'Split into scenes', disabled: st.state !== 'ready' || st.scanning, onClick: () => actions.splitIntoScenes(item.id) });
          if (m.kind === 'image') items.push({ label: 'Use as logo overlay', disabled: st.state !== 'ready', onClick: () => actions.addOverlay('image') });
          if (st.state === 'missing' || st.state === 'error') items.push({ label: 'Relink file…', onClick: () => actions.relink(m.id) });
          items.push('sep', { label: isChild ? 'Remove clip' : 'Remove from workspace', danger: true, onClick: () => actions.removeBinItems([item.id]) });
          showMenu(e.clientX, e.clientY, items);
        },
      },
      thumb,
      h('div', { class: 'bin-meta' }, h('div', { class: 'bin-name' }, item.name), sub),
    );
    if (children.length) {
      el.prepend(
        h(
          'button',
          {
            class: `bin-toggle ${item.collapsed ? '' : 'open'}`,
            type: 'button',
            'aria-label': item.collapsed ? 'Show scenes' : 'Hide scenes',
            onclick: (e) => {
              e.stopPropagation();
              store.silent((p) => {
                const b = p.bin.find((x) => x.id === item.id);
                if (b) b.collapsed = !b.collapsed;
              });
            },
          },
          icon('chevron', 14),
        ),
      );
    }
    if (st.state === 'missing') {
      el.querySelector('.bin-sub').append(button('Relink', { cls: 'btn-small', iconName: 'link', onClick: (e) => (e.stopPropagation(), actions.relink(m.id)) }));
    }
    return el;
  }

  function renderMedia() {
    const items = store.project.bin;
    if (!items.length) {
      body.append(
        h(
          'div',
          { class: 'dropzone' },
          icon('import', 28),
          h('p', {}, 'Drag videos, music and photos here.'),
          h('p', { class: 'hint' }, 'Most formats work, including MOV, MKV, HEIC and FLAC. Files stay on this computer.'),
          button('Import files', { iconName: 'import', onClick: () => actions.importDialog() }),
        ),
      );
      return;
    }
    const list = h('div', { class: 'bin-list' });
    const roots = items.filter((b) => !b.parentId);
    for (const r of roots) {
      const kids = items.filter((b) => b.parentId === r.id);
      const el = binItemEl(r, kids);
      if (el) list.append(el);
      if (!r.collapsed) for (const k of kids) {
        const kel = binItemEl(k, []);
        if (kel) list.append(kel);
      }
    }
    body.append(list, h('p', { class: 'hint' }, 'Drag an item to the timeline. Double-click to trim it before adding.'));
  }

  function renderTransitions() {
    const grid = h('div', { class: 'tile-grid' });
    for (const t of TRANSITIONS) {
      grid.append(
        h(
          'div',
          {
            class: 'tile',
            draggable: 'true',
            ondragstart: (e) => startDrag(e, { type: 'transition', id: t.id }, t.label),
            ondragend: endDrag,
          },
          icon(t.id, 26),
          t.label,
        ),
      );
    }
    body.append(grid, h('p', { class: 'hint' }, 'Drop a transition on the seam between two touching clips. It lasts 1 second; change that in the clip’s properties.'));
  }

  function renderOverlays() {
    const grid = h('div', { class: 'tile-grid' });
    grid.append(
      h(
        'div',
        {
          class: 'tile title-tile',
          draggable: 'true',
          title: 'Full-screen title card. Drag onto the video track, or click to insert at the playhead.',
          ondragstart: (e) => startDrag(e, { type: 'title' }, 'Title card'),
          ondragend: endDrag,
          onclick: () => actions.addTitle(),
        },
        icon('title', 26),
        'Title card',
      ),
    );
    for (const k of OVERLAY_KINDS) {
      grid.append(
        h(
          'div',
          {
            class: 'tile overlay-tile',
            draggable: k.id === 'subtitles' ? 'false' : 'true',
            title: `${OVERLAY_HELP[k.id]}. Drag onto the overlay track, or click to add at the playhead.`,
            ondragstart: (e) => startDrag(e, { type: 'overlay', kind: k.id }, k.label),
            ondragend: endDrag,
            onclick: () => actions.addOverlay(k.id),
          },
          icon(OVERLAY_ICON[k.id], 26),
          k.label,
        ),
      );
    }
    body.append(grid, h('p', { class: 'hint' }, 'Overlays sit above the video. Drag them in the preview to position them.'));
  }

  let queued = false;
  function render() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const scroll = body.scrollTop;
      renderTabs();
      clear(body);
      const tab = store.view.workspaceTab;
      if (tab === 'media') renderMedia();
      else if (tab === 'transitions') renderTransitions();
      else renderOverlays();
      body.scrollTop = scroll;
    });
  }

  store.on('change', render);
  store.on('select', render);
  store.on('media', render);
  store.on('view', render);
  render();
}

