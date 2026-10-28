// Timeline: overlay lanes, video track and music track, with snapping drag and drop,
// edge trimming, box selection, markers, transitions and split-point preview.

import { h, icon, button, clear, OVERLAY_ICON } from './dom.js';
import { showMenu } from './menu.js';
import { drag as dragState, readDrop, isFileDrag } from './drag.js';
import { toast } from './dialogs.js';
import { formatRuler, formatTimecode } from '../core/time.js';
import { splitLines } from '../core/split.js';
import { TRANSITIONS, OVERLAY_KINDS } from '../core/model.js';
import { duckPoints, soundIntervals, envelopeAt } from '../core/audioenv.js';
import {
  clipEnd,
  effectiveRange,
  getClip,
  laneCount,
  moveClips,
  movieDuration,
  seams,
  seamNear,
  snapOffset,
  snapTargets,
  trimClip,
  setTransition,
} from '../core/timeline.js';
import { PEAKS_PER_SEC } from '../engine/media.js';

const RULER_H = 28;
const OVERLAY_H = 28;
const VIDEO_H = 64;
const MUSIC_H = 50;
const SNAP_PX = 8;
const MIN_PX = 1;
const MAX_PX = 600;
const LABEL_W = 112;

function tickSteps(px) {
  const majors = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const major = majors.find((m) => m * px >= 90) || 3600;
  const minor = major >= 60 ? major / 6 : major === 15 ? 5 : major / 5;
  return { major, minor };
}

export function mountTimeline(root, app) {
  const { store, media, actions, player } = app;

  // ---------- header ----------
  const zoomSlider = h('input', { type: 'range', class: 'zoom', min: '0', max: '1000', 'aria-label': 'Timeline zoom' });
  const snapBtn = button('Snapping', { iconName: 'magnet', cls: 'icon-only ghost', title: 'Snapping (hold Alt while dragging to turn it off temporarily)', onClick: () => store.commit('Snapping', (p) => void (p.settings.snapping = !p.settings.snapping)) });
  const zoomOutBtn = button('Zoom out', { iconName: 'zoomOut', cls: 'icon-only ghost', kbd: '−', onClick: () => zoomBy(1 / 1.4) });
  const zoomInBtn = button('Zoom in', { iconName: 'zoomIn', cls: 'icon-only ghost', kbd: '+', onClick: () => zoomBy(1.4) });
  const fitBtn = button('Fit', { cls: 'ghost btn-small', title: 'Fit the whole movie', onClick: () => fit() });
  const header = h(
    'div',
    { class: 'tl-header' },
    button('Split', { iconName: 'split', cls: 'ghost btn-small', kbd: 'S', onClick: () => actions.splitAtPlayhead() }),
    button('Delete', { iconName: 'trash', cls: 'ghost btn-small', kbd: 'Delete', onClick: () => actions.deleteSelection() }),
    button('Add marker', { iconName: 'marker', cls: 'ghost btn-small', kbd: 'M', onClick: () => actions.addMarkerAt() }),
    h('span', { style: { flex: '1' } }),
    snapBtn,
    zoomOutBtn,
    zoomSlider,
    zoomInBtn,
    fitBtn,
  );
  // Zoom and snapping only apply to the timeline view.
  const zoomControls = [snapBtn, zoomOutBtn, zoomSlider, zoomInBtn, fitBtn];
  const body = h('div', { class: 'tl-body', tabindex: '-1' });
  const storyHost = h('div', { class: 'storyboard', style: { display: 'none' } });
  root.append(header, body, storyHost);

  const grid = h('div', { class: 'tl-grid' });
  const labels = h('div', { class: 'tl-labels' });
  const content = h('div', { class: 'tl-content' });
  grid.append(labels, content);
  body.append(grid);

  const ruler = h('div', { class: 'tl-ruler' });
  const lanesHost = h('div', {});
  const playheadEl = h('div', { class: 'playhead' });
  const overlayLayer = h('div', { style: { position: 'absolute', inset: '0', pointerEvents: 'none' } });
  content.append(ruler, lanesHost, playheadEl, overlayLayer);

  const px = () => store.view.pxPerSec;
  const timeAt = (clientX) => Math.max(0, (clientX - content.getBoundingClientRect().left) / px());

  // ---------- zoom ----------
  const toSlider = (p) => Math.round((Math.log(p / MIN_PX) / Math.log(MAX_PX / MIN_PX)) * 1000);
  const fromSlider = (v) => MIN_PX * Math.pow(MAX_PX / MIN_PX, v / 1000);
  function setZoom(p, anchorClientX = null) {
    const np = Math.max(MIN_PX, Math.min(MAX_PX, p));
    const bodyRect = body.getBoundingClientRect();
    const ax = anchorClientX ?? bodyRect.left + LABEL_W + (bodyRect.width - LABEL_W) / 2;
    const t = timeAt(ax);
    store.setView({ pxPerSec: np });
    renderNow();
    body.scrollLeft = Math.max(0, t * np - (ax - bodyRect.left - LABEL_W));
  }
  function zoomBy(f, anchor) {
    setZoom(px() * f, anchor);
  }
  function fit() {
    const d = Math.max(5, movieDuration(store.project));
    const w = body.clientWidth - LABEL_W - 40;
    setZoom(w / d);
    body.scrollLeft = 0;
  }
  zoomSlider.addEventListener('input', () => setZoom(fromSlider(Number(zoomSlider.value))));
  body.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX);
      }
    },
    { passive: false },
  );
  body.addEventListener('scroll', () => renderRuler());

  // ---------- rendering ----------
  let rows = [];

  function buildRows() {
    const n = laneCount(store.project);
    rows = [{ kind: 'ruler', h: RULER_H }];
    for (let lane = n - 1; lane >= 0; lane--) rows.push({ kind: 'overlay', lane, h: OVERLAY_H });
    rows.push({ kind: 'video', h: VIDEO_H }, { kind: 'music', h: MUSIC_H });
  }

  function rowTop(kind, lane) {
    let y = 0;
    for (const r of rows) {
      if (r.kind === kind && (lane == null || r.lane === lane)) return y;
      y += r.h;
    }
    return y;
  }

  function renderLabels() {
    clear(labels);
    const n = laneCount(store.project);
    for (const r of rows) {
      if (r.kind === 'ruler') labels.append(h('div', { class: 'tl-label ruler-label', style: { height: `${r.h}px` } }, formatTimecode(store.playhead)));
      else if (r.kind === 'overlay') labels.append(h('div', { class: 'tl-label', style: { height: `${r.h}px` } }, icon('text', 14), n > 1 ? `Overlays ${r.lane + 1}` : 'Overlays'));
      else if (r.kind === 'video') labels.append(h('div', { class: 'tl-label', style: { height: `${r.h}px` } }, icon('film', 14), 'Video'));
      else labels.append(h('div', { class: 'tl-label', style: { height: `${r.h}px` } }, icon('music', 14), 'Music'));
    }
  }

  function contentWidth() {
    const d = movieDuration(store.project);
    return Math.max(body.clientWidth - LABEL_W, (d + 30) * px());
  }

  function renderRuler() {
    clear(ruler);
    const p = px();
    const { major, minor } = tickSteps(p);
    const from = Math.max(0, body.scrollLeft / p - major);
    const to = (body.scrollLeft + body.clientWidth) / p + major;
    const start = Math.floor(from / minor) * minor;
    for (let t = start; t <= to; t += minor) {
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ruler.append(h('div', { class: `tick ${isMajor ? 'major' : ''}`, style: { left: `${t * p}px` } }));
      if (isMajor) ruler.append(h('div', { class: 'tick-label', style: { left: `${t * p}px` } }, formatRuler(t)));
    }
    for (const m of store.project.markers) {
      const flag = h('div', { class: 'marker-flag', style: { left: `${m.time * p}px` }, title: `Marker at ${formatTimecode(m.time)}`, dataset: { marker: m.id } });
      ruler.append(flag);
    }
    const label = labels.querySelector('.ruler-label');
    if (label) label.textContent = formatTimecode(store.playhead);
  }

  function clipEl(c) {
    const p = px();
    const project = store.project;
    const [s, e] = effectiveRange(project, c);
    const w = Math.max(4, (e - s) * p);
    const m = c.mediaId ? project.media[c.mediaId] : null;
    const st = m ? media.getStatus(m.id) : null;
    const cls = ['clip', c.track === 'overlay' ? 'overlay' : c.type];
    if (store.selection.has(c.id)) cls.push('selected');
    if (st && st.state === 'missing') cls.push('missing');
    if (c.muted) cls.push('muted-clip');
    const el = h('div', { class: cls.join(' '), dataset: { id: c.id }, style: { left: `${s * p}px`, width: `${w}px` }, title: `${c.name}\n${formatTimecode(s)} – ${formatTimecode(e)}` });

    if (c.type === 'video' && m) {
      const thumbs = h('div', { class: 'clip-thumbs' });
      const tw = (VIDEO_H - 8) * (16 / 9);
      const n = Math.min(60, Math.max(1, Math.ceil(w / tw)));
      for (let i = 0; i < n; i++) {
        const src = media.thumbAt(m.id, c.in + ((i + 0.5) * tw) / p);
        if (src) thumbs.append(h('img', { src, alt: '', draggable: 'false', style: { width: `${tw}px` } }));
      }
      el.append(thumbs);
    } else if (c.type === 'image' && m) {
      const src = media.thumbs.get(m.id);
      if (src) {
        const tw = (VIDEO_H - 8) * (16 / 9);
        const n = Math.min(30, Math.max(1, Math.ceil(w / tw)));
        el.append(h('div', { class: 'clip-thumbs' }, ...Array.from({ length: n }, () => h('img', { src, alt: '', draggable: 'false', style: { width: `${tw}px` } }))));
      }
    } else if (c.type === 'audio') {
      el.append(waveCanvas(c, w));
    }
    let nameIcon = null;
    if (c.track === 'overlay') nameIcon = icon(OVERLAY_ICON[c.kind] || 'text', 13);
    else if (c.type === 'title') nameIcon = icon('title', 13);
    el.append(h('div', { class: 'clip-name' }, nameIcon, c.type === 'title' ? c.title.text.split('\n')[0] : c.name));
    if (c.fadeIn > 0) el.append(h('div', { class: 'fade-mark', style: { left: '0', width: `${c.fadeIn * p}px` } }));
    if (c.fadeOut > 0) el.append(h('div', { class: 'fade-mark out', style: { right: '0', width: `${c.fadeOut * p}px` } }));
    if (!(c.track === 'overlay' && c.spanAll)) {
      el.append(h('div', { class: 'handle start', dataset: { edge: 'start' }, title: 'Drag to trim' }), h('div', { class: 'handle end', dataset: { edge: 'end' }, title: 'Drag to trim' }));
    }
    return el;
  }

  function waveCanvas(c, w) {
    const canvas = h('canvas', { class: 'wave' });
    const W = Math.max(1, Math.min(4000, Math.round(w)));
    const H = MUSIC_H - 8;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const peaks = media.peaks.get(c.mediaId);
    const p = px();
    const scale = W / w;
    if (peaks) {
      ctx.fillStyle = 'rgba(220, 255, 240, 0.55)';
      for (let x = 0; x < W; x++) {
        const t = c.in + x / scale / p;
        const i = Math.floor(t * PEAKS_PER_SEC);
        const v = (peaks[i] || 0) / 255;
        const hh = Math.max(1, v * (H - 4));
        ctx.fillRect(x, (H - hh) / 2, 1, hh);
      }
    }
    // Draw the volume curve (fades and music dimming) so automatic changes are visible.
    if (c.dimEnabled || c.fadeIn || c.fadeOut) {
      const iv = c.dimEnabled ? soundIntervals(store.project) : [];
      const pts = duckPoints(iv, c.dimLevel ?? 0.25);
      ctx.strokeStyle = '#ffd27a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let x = 0; x <= W; x += 2) {
        const t = c.start + x / scale / p;
        let v = c.dimEnabled ? envelopeAt(pts, t) : 1;
        const local = t - c.start;
        if (c.fadeIn > 0 && local < c.fadeIn) v *= local / c.fadeIn;
        if (c.fadeOut > 0 && c.duration - local < c.fadeOut) v *= (c.duration - local) / c.fadeOut;
        const y = 4 + (1 - v) * (H - 8);
        x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
    return canvas;
  }

  function renderLanes() {
    clear(lanesHost);
    const project = store.project;
    const width = contentWidth();
    content.style.width = `${width}px`;
    ruler.style.width = `${width}px`;
    const p = px();
    for (const r of rows) {
      if (r.kind === 'ruler') continue;
      const lane = h('div', { class: `tl-lane ${r.kind}`, style: { height: `${r.h}px` }, dataset: { track: r.kind, lane: r.lane ?? '' } });
      const clips = project.clips.filter((c) => (r.kind === 'overlay' ? c.track === 'overlay' && c.lane === r.lane : c.track === r.kind));
      for (const c of clips) lane.append(clipEl(c));
      if (r.kind === 'video') {
        for (const s of seams(project)) {
          if (!s.b.transition) continue;
          const d = s.b.transition.duration;
          lane.append(h('div', { class: 'transition-zone', style: { left: `${(s.time - d / 2) * p}px`, width: `${d * p}px` } }));
          const label = TRANSITIONS.find((t) => t.id === s.b.transition.type)?.label || 'Transition';
          lane.append(h('div', { class: 'transition-mark', style: { left: `${s.time * p}px` }, dataset: { seam: s.b.id }, title: `${label}, ${d.toFixed(1)}s. Right-click to change.` }, icon(s.b.transition.type, 14)));
        }
      }
      lanesHost.append(lane);
    }
    if (!project.clips.length) lanesHost.append(h('div', { class: 'tl-empty', style: { left: '24px', top: `${rowTop('video') + 22}px` } }, 'Drag clips here from the workspace, or drop files from your computer.'));
    renderSplitLines();
  }

  function renderSplitLines() {
    overlayLayer.querySelectorAll('.split-line').forEach((n) => n.remove());
    const project = store.project;
    if (project.export.mode !== 'split' || !(project.export.splitSeconds > 0)) return;
    const d = movieDuration(project);
    const lines = splitLines(d, project.export.splitSeconds);
    lines.forEach((t, i) => overlayLayer.append(h('div', { class: 'split-line', style: { left: `${t * px()}px` } }, h('span', {}, `Part ${i + 2}`))));
  }

  function renderPlayhead() {
    playheadEl.style.left = `${store.playhead * px()}px`;
    const label = labels.querySelector('.ruler-label');
    if (label) label.textContent = formatTimecode(store.playhead);
  }

  function renderNow() {
    if (store.view.mode === 'storyboard') {
      body.style.display = 'none';
      storyHost.style.display = '';
      zoomControls.forEach((el) => (el.style.display = 'none'));
      app.renderStoryboard(storyHost);
      return;
    }
    body.style.display = '';
    storyHost.style.display = 'none';
    zoomControls.forEach((el) => (el.style.display = ''));
    buildRows();
    renderLabels();
    renderLanes();
    renderRuler();
    renderPlayhead();
    zoomSlider.value = toSlider(px());
    snapBtn.classList.toggle('active', !!store.project.settings.snapping);
    snapBtn.setAttribute('aria-pressed', String(!!store.project.settings.snapping));
  }

  let queued = false;
  function render() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      renderNow();
    });
  }

  // ---------- pointer interactions ----------
  let snapLine = null;
  function showSnap(t) {
    if (t == null) {
      snapLine && snapLine.remove();
      snapLine = null;
      return;
    }
    if (!snapLine) {
      snapLine = h('div', { class: 'snap-line' });
      overlayLayer.append(snapLine);
    }
    snapLine.style.left = `${t * px()}px`;
  }

  function snapping(e) {
    return store.project.settings.snapping && !e.altKey;
  }

  function seekFromEvent(e) {
    app.seek(timeAt(e.clientX));
  }

  content.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    body.focus({ preventScroll: true });
    const target = e.target;
    if (target.closest('.marker-flag')) return startMarkerDrag(e, target.closest('.marker-flag').dataset.marker);
    if (target.closest('.tl-ruler')) return startScrub(e);
    const mark = target.closest('.transition-mark');
    if (mark) {
      store.select([mark.dataset.seam]);
      return;
    }
    const handle = target.closest('.handle');
    const clip = target.closest('.clip');
    if (handle && clip) return startTrim(e, clip.dataset.id, handle.dataset.edge);
    if (clip) return startMove(e, clip.dataset.id);
    return startRubber(e);
  });

  function track(onMove, onUp) {
    const move = (ev) => onMove(ev);
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      onUp(ev);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  function startScrub(e) {
    player.pause();
    seekFromEvent(e);
    track(seekFromEvent, () => {});
  }

  function startMarkerDrag(e, id) {
    const m = store.project.markers.find((x) => x.id === id);
    if (!m) return;
    const x0 = e.clientX;
    let g = null;
    track(
      (ev) => {
        if (!g && Math.abs(ev.clientX - x0) < 3) return;
        g = g || store.gesture('Move marker');
        const t = timeAt(ev.clientX);
        g.apply((p) => {
          const mk = p.markers.find((x) => x.id === id);
          if (mk) mk.time = t;
          p.markers.sort((a, b) => a.time - b.time);
        });
      },
      () => {
        if (g) g.end();
        else app.seek(m.time);
      },
    );
  }

  function startMove(e, id) {
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (additive) {
      store.select([id], { toggle: true });
      if (!store.selection.has(id)) return;
    } else if (!store.selection.has(id)) {
      store.select([id]);
    }
    const ids = store.selectedClips().map((c) => c.id);
    const base = JSON.parse(JSON.stringify(store.project));
    const moving = base.clips.filter((c) => ids.includes(c.id) && !(c.track === 'overlay' && c.spanAll));
    const blockStart = moving.length ? Math.min(...moving.map((c) => c.start)) : 0;
    const blockEnd = moving.length ? Math.max(...moving.map(clipEnd)) : 0;
    const targets = snapTargets(base, { excludeIds: ids, playhead: store.playhead });
    const x0 = e.clientX;
    const y0 = e.clientY;
    let g = null;
    player.pause();
    track(
      (ev) => {
        const dx = ev.clientX - x0;
        const dy = ev.clientY - y0;
        if (!g && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        g = g || store.gesture(ids.length > 1 ? 'Move clips' : 'Move clip');
        let delta = dx / px();
        let snapAt = null;
        if (snapping(ev) && moving.length) {
          const s = snapOffset(targets, [blockStart + delta, blockEnd + delta], SNAP_PX / px());
          if (s.target) {
            delta += s.offset;
            snapAt = s.target.time;
          }
        }
        const laneDelta = -Math.round(dy / OVERLAY_H);
        g.apply((p) => moveClips(p, ids, delta, { laneDelta }));
        showSnap(snapAt);
      },
      () => {
        showSnap(null);
        if (g) g.end();
        else if (!additive) store.select([id]);
      },
    );
  }

  function startTrim(e, id, edge) {
    store.select([id]);
    const base = JSON.parse(JSON.stringify(store.project));
    const c = getClip(base, id);
    const m = c.mediaId ? base.media[c.mediaId] : null;
    const mediaDur = (c.type === 'video' || c.type === 'audio') && m ? m.duration : Infinity;
    const targets = snapTargets(base, { excludeIds: [id], playhead: store.playhead });
    const g = store.gesture('Trim');
    player.pause();
    track(
      (ev) => {
        let t = timeAt(ev.clientX);
        let snapAt = null;
        if (snapping(ev)) {
          const s = snapOffset(targets, [t], SNAP_PX / px());
          if (s.target) {
            t += s.offset;
            snapAt = s.target.time;
          }
        }
        g.apply((p) => trimClip(p, id, edge, t, mediaDur));
        showSnap(snapAt);
      },
      () => {
        showSnap(null);
        g.end();
      },
    );
  }

  function startRubber(e) {
    const crect = content.getBoundingClientRect();
    const x0 = e.clientX - crect.left;
    const y0 = e.clientY - crect.top;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const before = additive ? [...store.selection] : [];
    let band = null;
    track(
      (ev) => {
        const r = content.getBoundingClientRect();
        const x1 = ev.clientX - r.left;
        const y1 = ev.clientY - r.top;
        if (!band && Math.hypot(x1 - x0, y1 - y0) < 5) return;
        if (!band) {
          band = h('div', { class: 'rubber' });
          content.append(band);
        }
        const L = Math.min(x0, x1);
        const T = Math.min(y0, y1);
        const W = Math.abs(x1 - x0);
        const H = Math.abs(y1 - y0);
        Object.assign(band.style, { left: `${L}px`, top: `${T}px`, width: `${W}px`, height: `${H}px` });
        const hits = [];
        for (const el of content.querySelectorAll('.clip')) {
          const b = el.getBoundingClientRect();
          const bx = b.left - r.left;
          const by = b.top - r.top;
          if (bx < L + W && bx + b.width > L && by < T + H && by + b.height > T) hits.push(el.dataset.id);
        }
        store.selection = new Set([...before, ...hits]);
        for (const el of content.querySelectorAll('.clip')) el.classList.toggle('selected', store.selection.has(el.dataset.id));
      },
      (ev) => {
        if (band) {
          band.remove();
          store.emit('select');
        } else {
          if (!additive) store.clearSelection();
          player.pause();
          seekFromEvent(ev);
        }
      },
    );
  }

  // ---------- context menus ----------
  content.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const t = timeAt(e.clientX);
    const flag = e.target.closest('.marker-flag');
    if (flag) {
      showMenu(e.clientX, e.clientY, [{ label: 'Delete marker', danger: true, onClick: () => actions.deleteMarker(flag.dataset.marker) }]);
      return;
    }
    const mark = e.target.closest('.transition-mark');
    if (mark) {
      const id = mark.dataset.seam;
      showMenu(e.clientX, e.clientY, [
        ...TRANSITIONS.map((tr) => ({ label: tr.label, onClick: () => store.commit('Change transition', (p) => setTransition(p, id, tr.id, getClip(p, id).transition?.duration || 1)) })),
        'sep',
        { label: 'Remove transition', danger: true, onClick: () => store.commit('Remove transition', (p) => setTransition(p, id, null)) },
      ]);
      return;
    }
    if (e.target.closest('.tl-ruler')) {
      showMenu(e.clientX, e.clientY, [{ label: 'Add marker here', onClick: () => actions.addMarkerAt(t) }]);
      return;
    }
    const clipNode = e.target.closest('.clip');
    if (clipNode) {
      const id = clipNode.dataset.id;
      if (!store.selection.has(id)) store.select([id]);
      showMenu(e.clientX, e.clientY, clipMenu(getClip(store.project, id), t));
      return;
    }
    const lane = e.target.closest('.tl-lane');
    const items = [{ label: 'Add marker here', onClick: () => actions.addMarkerAt(t) }];
    if (lane?.dataset.track === 'video') items.unshift({ label: 'Add title card here', onClick: () => actions.addTitle({ at: t }) });
    if (lane?.dataset.track === 'overlay') items.unshift(...OVERLAY_KINDS.filter((k) => k.id !== 'subtitles').map((k) => ({ label: `Add ${k.label.toLowerCase()} here`, onClick: () => actions.addOverlay(k.id, { at: t, lane: Number(lane.dataset.lane) }) })));
    showMenu(e.clientX, e.clientY, items);
  });

  function clipMenu(c, t) {
    if (!c) return [];
    const multi = store.selection.size > 1;
    const items = [];
    const inside = t > c.start && t < clipEnd(c);
    items.push({ label: 'Split at playhead', kbd: 'S', onClick: () => actions.splitAtPlayhead() });
    if (inside && !multi) items.push({ label: 'Split here', onClick: () => (app.seek(t), actions.splitAtPlayhead()) });
    if (c.track === 'video' && (c.type === 'video' || c.type === 'image')) items.push({ label: 'Freeze frame at playhead', onClick: () => actions.freezeFrame() });
    items.push('sep');
    items.push({ label: c.fadeIn ? 'Remove fade in' : 'Fade in', onClick: () => actions.setFade(c.id, 'in', !c.fadeIn) });
    items.push({ label: c.fadeOut ? 'Remove fade out' : 'Fade out', onClick: () => actions.setFade(c.id, 'out', !c.fadeOut) });
    if (c.type === 'video' || c.type === 'audio') items.push({ label: c.muted ? 'Unmute' : 'Mute', onClick: () => actions.toggleMute(c.id) });
    if (c.type === 'video') items.push({ label: 'Detach audio', disabled: !store.project.media[c.mediaId]?.hasAudio || c.muted, onClick: () => actions.detachAudio(c.id) });
    if (c.type === 'audio') items.push({ label: c.dimEnabled ? 'Don’t dim under video sound' : 'Dim under video sound', onClick: () => store.commit('Music dimming', (p) => void (getClip(p, c.id).dimEnabled = !c.dimEnabled)) });
    if (c.track === 'overlay') {
      items.push({ label: 'Bring to front', onClick: () => actions.front(c.id) });
      items.push({ label: 'Send to back', onClick: () => actions.back(c.id) });
      items.push({ label: c.spanAll ? 'Show for part of the movie' : 'Show for the whole movie', onClick: () => actions.setSpanAll(c.id, !c.spanAll) });
    }
    items.push({ label: 'Properties', onClick: () => app.focusProperties() });
    items.push('sep');
    items.push({ label: 'Duplicate', kbd: 'Ctrl+D', onClick: () => actions.duplicate() });
    items.push({ label: 'Delete', kbd: 'Delete', danger: true, onClick: () => actions.deleteSelection() });
    if (c.track !== 'overlay') items.push({ label: 'Delete and leave gap', kbd: 'Shift+Delete', danger: true, onClick: () => actions.deleteSelection({ ripple: false }) });
    return items;
  }

  // ---------- drag and drop from the workspace or the desktop ----------
  let dropLine = null;
  let seamMark = null;
  function clearDropUi() {
    dropLine && dropLine.remove();
    seamMark && seamMark.remove();
    dropLine = seamMark = null;
    content.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
  }

  function laneAt(clientY) {
    const r = content.getBoundingClientRect();
    let y = clientY - r.top;
    for (const row of rows) {
      if (y < row.h) return row;
      y -= row.h;
    }
    return rows[rows.length - 1];
  }

  function dropInfo(e) {
    const payload = dragState.payload || (isFileDrag(e) ? { type: 'files' } : null);
    if (!payload) return null;
    let t = timeAt(e.clientX);
    const row = laneAt(e.clientY);
    if (payload.type === 'transition') {
      const s = seamNear(store.project, t, 24 / px());
      return { payload, seam: s, t: s ? s.time : t };
    }
    let track = 'video';
    let lane = 0;
    if (payload.type === 'overlay') {
      track = 'overlay';
      lane = row.kind === 'overlay' ? row.lane : laneCount(store.project);
    } else if (payload.type === 'bin') {
      const item = store.project.bin.find((b) => b.id === payload.id);
      const m = item && store.project.media[item.mediaId];
      track = m?.kind === 'audio' ? 'music' : 'video';
    } else if (payload.type === 'files') {
      track = row.kind === 'music' ? 'music' : 'video';
    }
    if (store.project.settings.snapping && !e.altKey) {
      const s = snapOffset(snapTargets(store.project, { playhead: store.playhead }), [t], SNAP_PX / px());
      t += s.offset;
    }
    return { payload, t: Math.max(0, t), track, lane };
  }

  content.addEventListener('dragover', (e) => {
    const info = dropInfo(e);
    if (!info) return;
    e.preventDefault();
    clearDropUi();
    if (info.payload.type === 'transition') {
      if (!info.seam) {
        e.dataTransfer.dropEffect = 'none';
        return;
      }
      e.dataTransfer.dropEffect = 'copy';
      seamMark = h('div', { class: 'seam-target', style: { left: `${info.seam.time * px()}px`, top: `${rowTop('video')}px`, height: `${VIDEO_H}px`, bottom: 'auto' } });
      overlayLayer.append(seamMark);
      return;
    }
    e.dataTransfer.dropEffect = 'copy';
    const laneEl = info.track === 'overlay' ? content.querySelector(`.tl-lane.overlay[data-lane="${info.lane}"]`) : content.querySelector(`.tl-lane.${info.track}`);
    laneEl && laneEl.classList.add('drop-target');
    dropLine = h('div', { class: 'drop-line', style: { left: `${info.t * px()}px` } });
    overlayLayer.append(dropLine);
  });
  content.addEventListener('dragleave', (e) => {
    if (!content.contains(e.relatedTarget)) clearDropUi();
  });
  content.addEventListener('drop', (e) => {
    const info = dropInfo(e);
    clearDropUi();
    if (!info) return;
    e.preventDefault();
    const payload = readDrop(e) || info.payload;
    if (payload.type === 'transition') {
      if (!info.seam) {
        toast('Drop transitions on the seam between two touching clips.');
        return;
      }
      actions.addTransition(info.seam.b.id, payload.id);
      store.select([info.seam.b.id]);
    } else if (payload.type === 'bin') {
      actions.addBinItem(payload.id, { at: info.t });
    } else if (payload.type === 'overlay') {
      actions.addOverlay(payload.kind, { at: info.t, lane: info.lane });
    } else if (payload.type === 'title') {
      actions.addTitle({ at: info.t });
    } else if (payload.type === 'files') {
      actions.importFiles(payload.files, { at: info.t });
    }
    dragState.payload = null;
  });

  // ---------- follow the playhead ----------
  store.on('time', () => {
    renderPlayhead();
    if (player.playing) {
      const x = store.playhead * px();
      const left = body.scrollLeft;
      const visible = body.clientWidth - LABEL_W;
      if (x > left + visible - 40 || x < left) body.scrollLeft = Math.max(0, x - 80);
    }
  });
  store.on('change', render);
  store.on('select', render);
  store.on('media', render);
  store.on('view', render);
  new ResizeObserver(() => render()).observe(body);
  render();

  return { zoomBy, fit, render };
}
