// Preview playback. Video elements play in real time and are kept in sync with a master clock;
// sound runs through Web Audio so clip volume, fades and music dimming apply live.

import { planFrame } from '../core/render-plan.js';
import { fadeGainAt, soundIntervals, duckPoints, envelopeAt, normalizeGain } from '../core/audioenv.js';
import { clipEnd, trackClips } from '../core/timeline.js';
import { computeParts, resolveOutputSize } from '../core/split.js';
import { drawFrame } from './compositor.js';
import { seekTo } from './media.js';

const DRIFT = 0.2; // seconds of drift tolerated before re-syncing a playing element
const PRELOAD = 2; // seconds ahead to prepare the next clip
const MAX_ELEMENTS = 8;

export function outputSize(project) {
  const first = trackClips(project, 'video').find((c) => c.type === 'video' || c.type === 'image');
  const m = first ? project.media[first.mediaId] : null;
  return resolveOutputSize(project.export.resolution, m?.width, m?.height);
}

/** Pool of media elements keyed per clip, so a split clip can cross-fade with itself. */
class ElementPool {
  constructor(media, tag) {
    this.media = media;
    this.tag = tag;
    this.items = new Map(); // key -> {el, mediaId, used, source, gain}
  }

  get(key, mediaId) {
    let item = this.items.get(key);
    if (item && item.mediaId !== mediaId) {
      this.drop(key);
      item = null;
    }
    if (!item) {
      const url = this.media.url(mediaId);
      if (!url) return null;
      const el = document.createElement(this.tag);
      el.preload = 'auto';
      el.playsInline = true;
      el.crossOrigin = 'anonymous';
      el.src = url;
      item = { el, mediaId, used: performance.now(), source: null, gain: null };
      this.items.set(key, item);
      this.trim();
    }
    item.used = performance.now();
    return item;
  }

  trim() {
    if (this.items.size <= MAX_ELEMENTS) return;
    const sorted = [...this.items.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [k] of sorted.slice(0, this.items.size - MAX_ELEMENTS)) this.drop(k);
  }

  drop(key) {
    const item = this.items.get(key);
    if (!item) return;
    try {
      item.el.pause();
      item.source && item.source.disconnect();
      item.gain && item.gain.disconnect();
    } catch {
      /* ignore */
    }
    item.el.removeAttribute('src');
    item.el.load();
    this.items.delete(key);
  }

  pauseExcept(keys) {
    for (const [k, item] of this.items) if (!keys.has(k) && !item.el.paused) item.el.pause();
  }

  clear() {
    for (const k of [...this.items.keys()]) this.drop(k);
  }
}

export class Player {
  constructor(store, media, canvas) {
    this.store = store;
    this.media = media;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.videos = new ElementPool(media, 'video');
    this.audios = new ElementPool(media, 'audio');
    this.playing = false;
    this.audioCtx = null;
    this.master = null;
    this.raf = 0;
    this.renderQueued = false;
    this.boxes = [];
    this.size = { width: 1920, height: 1080 };
    this.duckCache = { key: '', points: [] };
    this.onEnded = null;
  }

  ensureAudio() {
    if (this.audioCtx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.audioCtx = new AC();
    this.master = this.audioCtx.createGain();
    this.master.connect(this.audioCtx.destination);
  }

  route(item) {
    if (!this.audioCtx || item.source) return;
    try {
      item.source = this.audioCtx.createMediaElementSource(item.el);
      item.gain = this.audioCtx.createGain();
      item.source.connect(item.gain).connect(this.master);
    } catch (e) {
      console.warn('audio routing failed', e);
    }
  }

  setGain(item, value) {
    const v = Math.max(0, value);
    if (item.gain) item.gain.gain.setTargetAtTime(v, this.audioCtx.currentTime, 0.015);
    else item.el.volume = Math.min(1, v);
  }

  async play() {
    if (this.playing) return;
    const d = this.store.duration();
    if (d <= 0) return;
    this.ensureAudio();
    if (this.audioCtx?.state === 'suspended') await this.audioCtx.resume();
    if (this.store.playhead >= d - 0.05) this.store.setPlayhead(0);
    this.playing = true;
    this.startT = this.store.playhead;
    this.startPerf = performance.now();
    this.store.emit('play', true);
    const loop = () => {
      if (!this.playing) return;
      const t = this.startT + (performance.now() - this.startPerf) / 1000;
      const dur = this.store.duration();
      if (t >= dur) {
        this.store.setPlayhead(dur);
        this.pause();
        this.onEnded && this.onEnded();
        return;
      }
      this.store.setPlayhead(t);
      this.renderNow(t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.videos.pauseExcept(new Set());
    this.audios.pauseExcept(new Set());
    this.store.emit('play', false);
    this.requestRender();
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  /** Re-render on the next frame (coalesces many requests while scrubbing). */
  requestRender() {
    if (this.renderQueued || this.playing) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      if (!this.playing) this.renderNow(this.store.playhead);
    });
  }

  parts() {
    const p = this.store.project;
    if (p.export.mode !== 'split') return null;
    return computeParts(this.store.duration(), p.export.splitSeconds, p.settings.fps);
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const { width: W, height: H } = outputSize(this.store.project);
    this.size = { width: W, height: H };
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const scale = Math.min(rect.width / W, rect.height / H);
    const cw = Math.max(2, Math.floor(W * scale));
    const ch = Math.max(2, Math.floor(H * scale));
    this.canvas.style.width = `${cw}px`;
    this.canvas.style.height = `${ch}px`;
    const pw = Math.floor(cw * dpr);
    const ph = Math.floor(ch * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    this.requestRender();
  }

  duck(project) {
    const iv = soundIntervals(project);
    const key = JSON.stringify(iv);
    if (key !== this.duckCache.key) this.duckCache = { key, iv, points: null };
    return this.duckCache;
  }

  renderNow(t) {
    const project = this.store.project;
    const plan = planFrame(project, t);
    const W = this.size.width;
    const H = this.size.height;
    const ctx = this.ctx;
    const activeVideo = new Set();
    const pending = [];

    // Prepare video elements for visible layers.
    const sources = plan.layers.map((layer) => {
      if (layer.kind === 'video') {
        const key = layer.clip.id;
        const item = this.videos.get(key, layer.mediaId);
        if (!item) return null;
        activeVideo.add(key);
        this.syncVideo(item, layer, t, pending);
        const el = item.el;
        return el.readyState >= 2 ? { el, w: el.videoWidth, h: el.videoHeight } : null;
      }
      if (layer.kind === 'image') {
        const bmp = this.media.bitmaps.get(layer.mediaId);
        if (!bmp) {
          this.media.bitmap(layer.mediaId).then(() => this.requestRender()).catch(() => {});
          return null;
        }
        return { el: bmp, w: bmp.width, h: bmp.height };
      }
      return null;
    });

    // Sound for video clips (including ones fully covered by a transition partner).
    this.updateVideoSound(project, t, activeVideo);
    this.updateMusic(project, t);
    this.preloadUpcoming(project, t);
    this.videos.pauseExcept(activeVideo);

    ctx.setTransform(this.canvas.width / W, 0, 0, this.canvas.height / H, 0, 0);
    this.boxes = drawFrame(ctx, {
      project,
      plan,
      W,
      H,
      source: (_layer, i) => sources[i],
      imageFor: (id) => {
        const b = this.media.bitmaps.get(id);
        if (!b) this.media.bitmap(id).then(() => this.requestRender()).catch(() => {});
        return b || null;
      },
      parts: this.parts(),
      preview: true,
      selectedIds: this.store.selection,
      safeZone: project.settings.safeZone,
    });
    if (pending.length && !this.playing) Promise.all(pending).then(() => this.requestRender());
  }

  syncVideo(item, layer, t, pending) {
    const el = item.el;
    const target = Math.min(layer.sourceTime, (el.duration || Infinity) - 0.02);
    if (this.playing) {
      this.route(item);
      if (el.paused) {
        if (Math.abs(el.currentTime - target) > 0.05) el.currentTime = target;
        el.play().catch(() => {});
      } else if (Math.abs(el.currentTime - target) > DRIFT) {
        el.currentTime = target;
      }
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - target) > 0.02 && !el.seeking) {
        pending.push(seekTo(el, target).catch(() => {}));
      } else if (el.readyState < 2) {
        pending.push(new Promise((r) => el.addEventListener('loadeddata', r, { once: true })));
      }
    }
  }

  clipGain(project, c, t) {
    if (c.muted || t < c.start || t >= clipEnd(c)) return 0;
    let g = (c.volume ?? 1) * fadeGainAt(c, t);
    if (project.settings.evenOutVolume) {
      const m = project.media[c.mediaId];
      if (m && m.rms) g *= normalizeGain(m.rms);
    }
    return g;
  }

  updateVideoSound(project, t, activeVideo) {
    for (const key of activeVideo) {
      const item = this.videos.items.get(key);
      const clip = project.clips.find((c) => c.id === key);
      if (!item || !clip) continue;
      if (!this.playing) {
        item.el.muted = true;
        continue;
      }
      item.el.muted = false;
      this.setGain(item, this.clipGain(project, clip, t));
    }
  }

  updateMusic(project, t) {
    const active = new Set();
    const music = trackClips(project, 'music');
    const duck = this.duck(project);
    if (!duck.pointsByLevel) duck.pointsByLevel = new Map();
    for (const c of music) {
      if (t < c.start || t >= clipEnd(c)) continue;
      active.add(c.id);
      if (!this.playing) continue;
      const item = this.audios.get(c.id, c.mediaId);
      if (!item) continue;
      this.route(item);
      const src = c.in + (t - c.start);
      if (item.el.paused) {
        item.el.currentTime = src;
        item.el.play().catch(() => {});
      } else if (Math.abs(item.el.currentTime - src) > DRIFT) {
        item.el.currentTime = src;
      }
      let g = this.clipGain(project, c, t);
      if (c.dimEnabled) {
        const level = c.dimLevel ?? 0.25;
        if (!duck.pointsByLevel.has(level)) duck.pointsByLevel.set(level, duckPoints(duck.iv, level));
        g *= envelopeAt(duck.pointsByLevel.get(level), t);
      }
      this.setGain(item, g);
    }
    this.audios.pauseExcept(active);
  }

  /** Get the next video clip's element loaded and parked on its first frame. */
  preloadUpcoming(project, t) {
    const next = trackClips(project, 'video').find((c) => c.type === 'video' && c.start > t && c.start - t < PRELOAD);
    if (!next) return;
    const item = this.videos.get(next.id, next.mediaId);
    if (item && item.el.paused && Math.abs(item.el.currentTime - next.in) > 0.05 && !item.el.seeking) {
      item.el.currentTime = next.in;
    }
  }

  /** Overlay box under a point in canvas CSS pixels. */
  hitTest(x, y) {
    const W = this.size.width;
    const scale = W / parseFloat(this.canvas.style.width || this.canvas.width);
    const px = x * scale;
    const py = y * scale;
    for (let i = this.boxes.length - 1; i >= 0; i--) {
      const b = this.boxes[i];
      const r = b.box;
      const s = 12 * (this.size.height / 540);
      if (b.resizable && this.store.selection.has(b.id) && Math.abs(px - (r.x + r.w)) < s && Math.abs(py - (r.y + r.h)) < s) {
        return { ...b, handle: 'resize', px, py };
      }
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return { ...b, handle: 'move', px, py };
    }
    return null;
  }

  toOutput(x, y) {
    const scale = this.size.width / parseFloat(this.canvas.style.width || this.canvas.width);
    return { x: x * scale, y: y * scale };
  }

  reset() {
    this.pause();
    this.videos.clear();
    this.audios.clear();
  }
}
