// Storyboard view: the video track as big thumbnails with transition slots between them.
// Reordering lays the clips back to back.

import { h, icon, clear } from './dom.js';
import { showMenu } from './menu.js';
import { drag as dragState, startDrag, endDrag, isFileDrag } from './drag.js';
import { toast } from './dialogs.js';
import { formatRuler } from '../core/time.js';
import { TRANSITIONS } from '../core/model.js';
import { trackClips, reorderVideo, clipEnd, setTransition } from '../core/timeline.js';
import { near } from '../core/util.js';

export function renderStoryboard(host, app) {
  const { store, media, actions } = app;
  clear(host);
  const clips = trackClips(store.project, 'video');
  if (!clips.length) {
    host.append(h('div', { class: 'sb-empty' }, 'Drag videos and photos here to start your storyboard.'));
  }

  const reorder = (ids, label) => store.commit(label, (p) => reorderVideo(p, ids));

  const accepts = (e) => {
    const p = dragState.payload;
    return (p && (p.type === 'sb' || p.type === 'bin' || p.type === 'title')) || isFileDrag(e);
  };

  function dropAt(index, e) {
    e.preventDefault();
    const p = dragState.payload;
    const order = clips.map((c) => c.id);
    const at = index < clips.length ? clips[index].start : clips.length ? clipEnd(clips[clips.length - 1]) : 0;
    if (p && p.type === 'sb') {
      const from = order.indexOf(p.id);
      order.splice(from, 1);
      order.splice(from < index ? index - 1 : index, 0, p.id);
      reorder(order, 'Reorder');
    } else if (p && p.type === 'bin') {
      const clip = actions.clipFromBin(p.id, at);
      if (!clip) return toast('That item is still importing.');
      order.splice(index, 0, clip.id);
      store.commit('Add clip', (pr) => {
        pr.clips.push(clip);
        reorderVideo(pr, order);
      });
    } else if (p && p.type === 'title') {
      actions.addTitle({ at });
    } else if (e.dataTransfer.files.length) {
      actions.importFiles([...e.dataTransfer.files], { at });
    }
    endDrag();
  }

  function gap(index) {
    const el = h('div', { class: 'sb-gap', dataset: { index } });
    el.addEventListener('dragover', (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      el.classList.add('drop');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop');
      dropAt(index, e);
    });
    return el;
  }

  function slot(a, b) {
    const touching = near(clipEnd(a), b.start);
    const tr = touching ? b.transition : null;
    const el = h('div', { class: `sb-slot ${tr ? 'filled' : ''}`, title: tr ? `${TRANSITIONS.find((t) => t.id === tr.type)?.label}, ${tr.duration.toFixed(1)}s` : touching ? 'Drop a transition here' : 'These clips don’t touch' }, tr ? icon(tr.type, 16) : touching ? icon('plus', 14) : '…');
    el.addEventListener('click', () => store.select([b.id]));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!touching) return;
      showMenu(e.clientX, e.clientY, [
        ...TRANSITIONS.map((t) => ({ label: t.label, onClick: () => actions.addTransition(b.id, t.id) })),
        'sep',
        { label: 'No transition', disabled: !tr, onClick: () => store.commit('Remove transition', (p) => setTransition(p, b.id, null)) },
      ]);
    });
    el.addEventListener('dragover', (e) => {
      if (dragState.payload?.type !== 'transition') return;
      e.preventDefault();
      el.classList.add('drop');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop');
      const p = dragState.payload;
      if (p?.type !== 'transition') return;
      e.preventDefault();
      if (!touching) return toast('Those clips have a gap between them. Reorder them here to close it.');
      actions.addTransition(b.id, p.id);
      endDrag();
    });
    return el;
  }

  clips.forEach((c, i) => {
    if (i > 0) host.append(slot(clips[i - 1], c));
    host.append(gap(i));
    const m = c.mediaId ? store.project.media[c.mediaId] : null;
    const thumb = h('div', { class: 'bin-thumb' });
    const src = m ? (m.kind === 'video' ? media.thumbAt(m.id, c.in + c.duration / 2) : media.thumbs.get(m.id)) : null;
    if (src) thumb.style.backgroundImage = `url(${src})`;
    else if (c.type === 'title') {
      thumb.style.background = c.title.bg;
      thumb.style.color = c.title.color;
      thumb.append(h('span', { style: { fontSize: '11px', padding: '4px', textAlign: 'center' } }, c.title.text.slice(0, 40)));
    }
    const card = h(
      'div',
      {
        class: `sb-card ${store.selection.has(c.id) ? 'selected' : ''}`,
        draggable: 'true',
        tabindex: '0',
        onclick: (e) => store.select([c.id], { toggle: e.ctrlKey || e.metaKey }),
        ondblclick: () => app.focusProperties(),
        ondragstart: (e) => startDrag(e, { type: 'sb', id: c.id }, c.name),
        ondragend: endDrag,
        ondragover: (e) => {
          if (!accepts(e)) return;
          e.preventDefault();
        },
        ondrop: (e) => {
          const r = e.currentTarget.getBoundingClientRect();
          dropAt(e.clientX < r.left + r.width / 2 ? i : i + 1, e);
        },
        oncontextmenu: (e) => {
          e.preventDefault();
          store.select([c.id]);
          showMenu(e.clientX, e.clientY, [
            { label: c.fadeIn ? 'Remove fade in' : 'Fade in', onClick: () => actions.setFade(c.id, 'in', !c.fadeIn) },
            { label: c.fadeOut ? 'Remove fade out' : 'Fade out', onClick: () => actions.setFade(c.id, 'out', !c.fadeOut) },
            { label: 'Duplicate', onClick: () => actions.duplicate([c.id]) },
            'sep',
            { label: 'Delete', danger: true, onClick: () => actions.deleteSelection() },
          ]);
        },
      },
      thumb,
      h('div', { class: 'bin-name' }, c.type === 'title' ? 'Title card' : c.name),
      h('div', { class: 'bin-sub' }, formatRuler(c.duration)),
    );
    host.append(card);
  });
  if (clips.length) {
    host.append(gap(clips.length));
    host.append(h('p', { class: 'hint', style: { flex: 'none', width: '180px', margin: '0 16px' } }, 'Drag cards to reorder. Drop transitions on the circles between them. Overlays and music are edited in Timeline view.'));
  } else host.append(gap(0));
}
