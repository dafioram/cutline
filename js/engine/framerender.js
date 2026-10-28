// Frame-accurate rendering for export, GIFs and stills. Unlike the preview, every frame waits
// for its video elements to land exactly on the right source time.

import { planFrame } from '../core/render-plan.js';
import { drawFrame } from './compositor.js';
import { seekTo } from './media.js';

export class FrameRenderer {
  constructor(media, project, width, height, { parts = null, overlays = true, readback = false } = {}) {
    this.media = media;
    this.project = project;
    this.W = width;
    this.H = height;
    this.parts = parts;
    this.overlays = overlays;
    this.canvas = new OffscreenCanvas(width, height);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: readback });
    this.elements = new Map(); // clip id -> video element
  }

  videoFor(clip) {
    let el = this.elements.get(clip.id);
    if (!el) {
      el = document.createElement('video');
      el.muted = true;
      el.preload = 'auto';
      el.playsInline = true;
      el.src = this.media.url(clip.mediaId);
      this.elements.set(clip.id, el);
    }
    return el;
  }

  async ready(el) {
    if (el.readyState >= 1) return;
    await new Promise((resolve, reject) => {
      el.addEventListener('loadedmetadata', resolve, { once: true });
      el.addEventListener('error', () => reject(new Error('A video in the movie could not be read.')), { once: true });
    });
  }

  /** Draw time t. `part` (when splitting) feeds the part indicator and per-part clock. */
  async render(t, { part = null, ctx = this.ctx, W = this.W, H = this.H } = {}) {
    const plan = planFrame(this.project, t);
    if (!this.overlays) plan.overlays = [];
    const sources = await Promise.all(
      plan.layers.map(async (layer) => {
        if (layer.kind === 'video') {
          const el = this.videoFor(layer.clip);
          await this.ready(el);
          const target = Math.min(layer.sourceTime, Math.max(0, el.duration - 0.001));
          await seekTo(el, target);
          return { el, w: el.videoWidth, h: el.videoHeight };
        }
        if (layer.kind === 'image') {
          const bmp = await this.media.bitmap(layer.mediaId);
          return bmp ? { el: bmp, w: bmp.width, h: bmp.height } : null;
        }
        return null;
      }),
    );
    const images = new Map();
    for (const o of plan.overlays) {
      if (o.clip.kind === 'image' && o.clip.mediaId && !images.has(o.clip.mediaId)) {
        images.set(o.clip.mediaId, await this.media.bitmap(o.clip.mediaId));
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (ctx.canvas.width !== W || ctx.canvas.height !== H) ctx.setTransform(ctx.canvas.width / W, 0, 0, ctx.canvas.height / H, 0, 0);
    drawFrame(ctx, {
      project: this.project,
      plan,
      W,
      H,
      source: (_l, i) => sources[i],
      imageFor: (id) => images.get(id) || null,
      parts: this.parts,
      part,
      preview: false,
    });
    return ctx.canvas;
  }

  dispose() {
    for (const el of this.elements.values()) {
      el.removeAttribute('src');
      el.load();
    }
    this.elements.clear();
  }
}

/** Render one still at the output size (PNG blob). */
export async function renderStill(media, project, t, width, height, { overlays = true } = {}) {
  const r = new FrameRenderer(media, project, width, height, { overlays });
  try {
    const canvas = await r.render(t);
    return await canvas.convertToBlob({ type: 'image/png' });
  } finally {
    r.dispose();
  }
}
