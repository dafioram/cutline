// Preview panel: the movie (canvas, with overlays you can drag into place) or a single
// workspace item with In/Out points for trimming before it goes on the timeline.

import { h, icon, button, clear } from './dom.js';
import { formatTimecode } from '../core/time.js';
import { nearestCorner, cornerCenter } from '../core/overlays.js';
import { getClip } from '../core/timeline.js';
import { clamp } from '../core/util.js';

export function mountPreview(root, app) {
  const { store, media, player, actions } = app;

  const head = h('div', { class: 'panel-head' });
  const stage = h('div', { class: 'preview-stage' });
  const canvas = h('canvas', { 'aria-label': 'Movie preview' });
  const empty = h('div', { class: 'preview-empty' }, 'Your movie plays here. Import media and drag it to the timeline below.');
  stage.append(canvas, empty);
  const transport = h('div', { class: 'transport' });
  const sourceBar = h('div', { class: 'source-bar' });
  root.append(head, stage, transport, sourceBar);

  player.canvas = canvas;
  player.ctx = canvas.getContext('2d');

  // ---------- movie transport ----------
  const playBtn = button('Play', { iconName: 'play', cls: 'icon-only', kbd: 'Space', onClick: () => player.toggle() });
  const time = h('span', { class: 'timecode' });
  transport.append(
    button('Go to start', { iconName: 'toStart', cls: 'icon-only ghost', kbd: 'Home', onClick: () => app.seek(0) }),
    button('Previous frame', { iconName: 'stepBack', cls: 'icon-only ghost', kbd: '←', onClick: () => app.stepFrames(-1) }),
    playBtn,
    button('Next frame', { iconName: 'stepFwd', cls: 'icon-only ghost', kbd: '→', onClick: () => app.stepFrames(1) }),
    time,
    h('span', { style: { flex: '1' } }),
    button('Split', { iconName: 'split', cls: 'ghost btn-small', kbd: 'S', onClick: () => actions.splitAtPlayhead() }),
    button('Marker', { iconName: 'marker', cls: 'ghost btn-small', kbd: 'M', onClick: () => actions.addMarkerAt() }),
    button('Freeze', { iconName: 'freeze', cls: 'ghost btn-small', title: 'Hold the frame under the playhead for 3 seconds', onClick: () => actions.freezeFrame() }),
  );

  const setPlayIcon = (playing) => {
    clear(playBtn).append(icon(playing ? 'pause' : 'play'));
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  };
  store.on('play', (playing) => setPlayIcon(playing));

  const updateTime = () => {
    clear(time).append(h('strong', {}, formatTimecode(store.playhead)), ` / ${formatTimecode(store.duration())}`);
  };

  // ---------- overlay dragging in the preview ----------
  let drag = null;
  canvas.addEventListener('pointermove', (e) => {
    if (drag) return;
    const hit = player.hitTest(e.offsetX, e.offsetY);
    canvas.classList.toggle('grab', !!hit && hit.handle === 'move');
    canvas.classList.toggle('resize', !!hit && hit.handle === 'resize');
  });
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || store.view.preview !== 'movie') return;
    const hit = player.hitTest(e.offsetX, e.offsetY);
    if (!hit) {
      store.clearSelection();
      return;
    }
    e.preventDefault();
    player.pause();
    store.select([hit.id]);
    const clip = getClip(store.project, hit.id);
    const start = player.toOutput(e.offsetX, e.offsetY);
    const W = player.size.width;
    const H = player.size.height;
    const box = hit.box;
    const g = store.gesture(hit.handle === 'resize' ? 'Resize overlay' : 'Move overlay');
    drag = { g, start, box, clip: JSON.parse(JSON.stringify(clip)), handle: hit.handle, W, H };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const pt = player.toOutput(e.offsetX, e.offsetY);
    const dx = pt.x - drag.start.x;
    const dy = pt.y - drag.start.y;
    const { W, H, box, clip } = drag;
    drag.g.apply((p) => {
      const c = getClip(p, clip.id);
      if (!c) return;
      if (drag.handle === 'resize') {
        const nw = Math.max(16, box.w + dx);
        const nh = Math.max(16, box.h + dy);
        const cx = box.x + box.w / 2;
        const cy = box.y + box.h / 2;
        if (c.kind === 'image') c.props.width = clamp(nw / W, 0.02, 1);
        else {
          c.props.w = clamp(nw / W, 0.02, 1);
          c.props.h = clamp(nh / H, 0.02, 1);
        }
        // Keep the top-left corner where it was.
        const newW = c.kind === 'image' ? c.props.width * W : c.props.w * W;
        const newH = c.kind === 'image' ? (box.h * newW) / box.w : c.props.h * H;
        c.corner = null;
        c.x = (cx - box.w / 2 + newW / 2) / W;
        c.y = (cy - box.h / 2 + newH / 2) / H;
      } else {
        c.corner = null;
        c.x = clamp((box.x + box.w / 2 + dx) / W, 0, 1);
        c.y = clamp((box.y + box.h / 2 + dy) / H, 0, 1);
      }
    });
    player.requestRender();
  });
  const endDrag = () => {
    if (!drag) return;
    const { g, W, H, box, clip } = drag;
    // Overlays that started in a corner snap back to the nearest corner when released close to one.
    g.update((p) => {
      const c = getClip(p, clip.id);
      if (!c || drag.handle !== 'move' || !clip.corner) return;
      const cx = c.x * W;
      const cy = c.y * H;
      const corner = nearestCorner(cx, cy, W, H);
      const target = cornerCenter(corner, box.w, box.h, W, H);
      if (Math.hypot(target.x - cx, target.y - cy) < H * 0.06) c.corner = corner;
    });
    g.end();
    drag = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('dblclick', (e) => {
    const hit = player.hitTest(e.offsetX, e.offsetY);
    if (hit) app.focusProperties();
  });

  // ---------- source (workspace item) mode ----------
  let sourceEl = null;
  let sourceRaf = 0;

  function closeSource() {
    if (sourceEl) {
      sourceEl.pause && sourceEl.pause();
      sourceEl.remove();
      sourceEl = null;
    }
    cancelAnimationFrame(sourceRaf);
    store.setView({ preview: 'movie', sourceBinId: null });
  }

  function renderHead() {
    clear(head);
    if (store.view.preview === 'source') {
      const item = store.project.bin.find((b) => b.id === store.view.sourceBinId);
      head.append(
        h('span', { class: 'mode-badge' }, 'Trimming'),
        h('h2', { class: 'panel-title' }, item ? item.name : ''),
        button('Back to movie', { cls: 'btn-small', onClick: closeSource }),
      );
    } else {
      head.append(h('h2', { class: 'panel-title' }, 'Preview'));
    }
  }

  function buildSource() {
    const item = store.project.bin.find((b) => b.id === store.view.sourceBinId);
    if (!item) return closeSource();
    const m = store.project.media[item.mediaId];
    clear(sourceBar);
    if (sourceEl) sourceEl.remove();
    canvas.style.display = 'none';
    empty.style.display = 'none';
    transport.style.display = 'none';
    sourceBar.style.display = '';
    const url = media.url(m.id);
    if (m.kind === 'image') {
      sourceEl = h('img', { src: url, alt: m.name, class: 'source-media' });
      stage.append(sourceEl);
      sourceBar.append(h('span', { class: 'timecode' }, `${m.width}×${m.height}`), h('span', { style: { flex: '1' } }), button('Add to movie', { primary: true, cls: 'btn-small', onClick: () => actions.addBinItem(item.id) }));
      return;
    }
    const lo = item.in || 0;
    const hi = item.out ?? m.duration;
    store.view.sourceIn = lo;
    store.view.sourceOut = hi;
    sourceEl = h(m.kind === 'video' ? 'video' : 'audio', { src: url, preload: 'auto', class: 'source-media' });
    if (m.kind === 'audio') {
      sourceEl.style.display = 'none';
      stage.append(h('div', { class: 'preview-empty', style: { position: 'static' } }, icon('music', 48)));
    }
    stage.append(sourceEl);
    // Set the start before the video loads: the browser treats it as the starting position, so a
    // seek the user makes while it's still loading isn't overwritten.
    sourceEl.currentTime = lo;

    const play = button('Play', { iconName: 'play', cls: 'icon-only', onClick: () => (sourceEl.paused ? sourceEl.play() : sourceEl.pause()) });
    const tc = h('span', { class: 'timecode' });
    const scrub = h('div', { class: 'scrub', role: 'slider', 'aria-label': 'Source position', tabindex: '0' });
    const range = h('div', { class: 'scrub-range' });
    const headEl = h('div', { class: 'scrub-head' });
    scrub.append(h('div', { class: 'scrub-track' }), range, headEl);
    const inBtn = button('Set in', { cls: 'btn-small', kbd: 'I', onClick: () => setIn() });
    const outBtn = button('Set out', { cls: 'btn-small', kbd: 'O', onClick: () => setOut() });
    const add = button('Add selection to movie', { primary: true, cls: 'btn-small', onClick: () => actions.addSourceRange(item.id, store.view.sourceIn, store.view.sourceOut) });
    const save = button('Save as clip', { cls: 'btn-small', title: 'Keep this selection in the workspace', onClick: () => actions.saveSourceRange(item.id, store.view.sourceIn, store.view.sourceOut) });
    sourceBar.append(play, scrub, tc, inBtn, outBtn, save, add);

    const dur = m.duration || 1;
    const setIn = () => {
      store.view.sourceIn = Math.min(sourceEl.currentTime, store.view.sourceOut - 0.1);
      draw();
    };
    const setOut = () => {
      store.view.sourceOut = Math.max(sourceEl.currentTime, store.view.sourceIn + 0.1);
      draw();
    };
    app.sourceKeys = { setIn, setOut, toggle: () => (sourceEl.paused ? sourceEl.play() : sourceEl.pause()), step: (d) => (sourceEl.currentTime = clamp(sourceEl.currentTime + d, 0, dur)) };
    const draw = () => {
      const t = sourceEl.currentTime || 0;
      headEl.style.left = `${(t / dur) * 100}%`;
      range.style.left = `${(store.view.sourceIn / dur) * 100}%`;
      range.style.width = `${((store.view.sourceOut - store.view.sourceIn) / dur) * 100}%`;
      clear(tc).append(h('strong', {}, formatTimecode(t)), ` · in ${formatTimecode(store.view.sourceIn)} · out ${formatTimecode(store.view.sourceOut)} · ${formatTimecode(store.view.sourceOut - store.view.sourceIn)}`);
      clear(play).append(icon(sourceEl.paused ? 'play' : 'pause'));
    };
    const loop = () => {
      draw();
      if (!sourceEl.paused && sourceEl.currentTime >= store.view.sourceOut) sourceEl.pause();
      sourceRaf = requestAnimationFrame(loop);
    };
    sourceEl.addEventListener('play', () => {
      if (sourceEl.currentTime >= store.view.sourceOut - 0.05 || sourceEl.currentTime < store.view.sourceIn) sourceEl.currentTime = store.view.sourceIn;
    });
    const seekFromEvent = (e) => {
      const r = scrub.getBoundingClientRect();
      sourceEl.currentTime = clamp(((e.clientX - r.left) / r.width) * dur, 0, dur);
    };
    scrub.addEventListener('pointerdown', (e) => {
      scrub.setPointerCapture(e.pointerId);
      seekFromEvent(e);
      const move = (ev) => seekFromEvent(ev);
      scrub.addEventListener('pointermove', move);
      scrub.addEventListener('pointerup', () => scrub.removeEventListener('pointermove', move), { once: true });
    });
    cancelAnimationFrame(sourceRaf);
    loop();
  }

  function showMovie() {
    if (sourceEl) {
      sourceEl.pause && sourceEl.pause();
      sourceEl.remove();
      sourceEl = null;
    }
    stage.querySelectorAll('.preview-empty[style]').forEach((n) => n.remove());
    app.sourceKeys = null;
    canvas.style.display = '';
    transport.style.display = '';
    sourceBar.style.display = 'none';
    clear(sourceBar);
    empty.style.display = store.project.clips.length ? 'none' : '';
    player.resize();
  }

  let lastMode = null;
  let lastSource = null;
  function syncMode() {
    renderHead();
    const mode = store.view.preview;
    if (mode === lastMode && store.view.sourceBinId === lastSource) return;
    lastMode = mode;
    lastSource = store.view.sourceBinId;
    if (mode === 'source') {
      player.pause();
      buildSource();
    } else showMovie();
  }

  store.on('view', syncMode);
  store.on('change', () => {
    empty.style.display = store.project.clips.length || store.view.preview === 'source' ? 'none' : '';
    player.resize();
    updateTime();
  });
  store.on('select', () => player.requestRender());
  store.on('time', () => {
    updateTime();
    player.requestRender();
  });
  store.on('media', () => player.requestRender());
  new ResizeObserver(() => player.resize()).observe(stage);
  syncMode();
  updateTime();
  setPlayIcon(false);
}
