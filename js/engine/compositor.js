// Draws one frame of the movie onto a 2D canvas: video/image/title layers, transitions and overlays.
// The same code renders the preview, exported video frames, GIF frames and saved stills.

import { fontCss } from '../core/model.js';
import { formatHMS } from '../core/time.js';
import { cueAt } from '../core/srt.js';
import { overlayBox, overlappingIndices, safeZone } from '../core/overlays.js';
import { formatStamp } from '../core/mp4meta.js';

const RESIZABLE = new Set(['blur', 'shape', 'image']);

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function drawContain(ctx, src, sw, sh, W, H) {
  if (!sw || !sh) return;
  const s = Math.min(W / sw, H / sh);
  const w = sw * s;
  const h = sh * s;
  ctx.drawImage(src, (W - w) / 2, (H - h) / 2, w, h);
}

function hexToRgba(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return `rgba(0,0,0,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * @param {CanvasRenderingContext2D} ctx  already scaled so that drawing units are output pixels (W x H)
 * @param {object} opts
 *   project, plan, W, H, duration
 *   source(layer, index) -> {el, w, h} | null       drawable for a video/image layer
 *   imageFor(mediaId) -> ImageBitmap | null         logos
 *   parts: [{index,start,end}] | null               when splitting
 *   part: {index,start,end} | null                  forced part (export)
 *   preview: bool, selectedIds: Set, safeZone: bool
 * @returns {Array<{id, box, resizable}>} overlay boxes for hit-testing
 */
export function drawFrame(ctx, opts) {
  const { plan, W, H } = opts;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  plan.layers.forEach((layer, i) => drawLayer(ctx, layer, i, opts));

  const boxes = [];
  for (const o of plan.overlays) {
    const box = drawOverlay(ctx, o, opts);
    if (box) boxes.push({ id: o.clip.id, box, resizable: RESIZABLE.has(o.clip.kind), kind: o.clip.kind });
  }
  ctx.restore();

  if (opts.preview) drawPreviewAids(ctx, boxes, opts);
  return boxes;
}

function drawLayer(ctx, layer, index, opts) {
  const { W, H } = opts;
  if (layer.alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = Math.min(1, layer.alpha);
  if (layer.wipe != null) {
    ctx.beginPath();
    ctx.rect(0, 0, W * layer.wipe, H);
    ctx.clip();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }
  if (layer.kind === 'title') {
    drawTitle(ctx, layer.clip.title, W, H);
  } else {
    const src = opts.source(layer, index);
    if (src) drawContain(ctx, src.el, src.w, src.h, W, H);
  }
  ctx.restore();
}

function drawTitle(ctx, t, W, H) {
  ctx.fillStyle = t.bg || '#000';
  ctx.fillRect(0, 0, W, H);
  const size = (t.size || 96) * (H / 1080);
  ctx.font = `600 ${size}px ${fontCss(t.font)}`;
  ctx.fillStyle = t.color || '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = wrapLines(ctx, String(t.text || ''), W * 0.86);
  const lh = size * 1.2;
  const y0 = H / 2 - ((lines.length - 1) * lh) / 2;
  lines.forEach((l, i) => ctx.fillText(l, W / 2, y0 + i * lh));
}

function wrapLines(ctx, text, maxW) {
  const out = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/);
    let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (ctx.measureText(test).width > maxW && line) {
        out.push(line);
        line = w;
      } else line = test;
    }
    out.push(line);
  }
  return out;
}

function textBlock(ctx, lines, font, size) {
  ctx.font = `${font.weight || 600} ${size}px ${font.css}`;
  const widths = lines.map((l) => ctx.measureText(l).width);
  return { w: Math.max(1, ...widths), h: lines.length * size * 1.2 };
}

function drawTextBox(ctx, box, lines, size, { color, bg, align = 'center', fontCssStr, weight = 600, pad }) {
  if (bg) {
    ctx.fillStyle = bg;
    roundRect(ctx, box.x, box.y, box.w, box.h, size * 0.25);
    ctx.fill();
  }
  ctx.font = `${weight} ${size}px ${fontCssStr}`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = align;
  const lh = size * 1.2;
  const x = align === 'left' ? box.x + pad : box.x + box.w / 2;
  lines.forEach((l, i) => ctx.fillText(l, x, box.y + pad + lh * (i + 0.5)));
}

function currentPart(opts, t) {
  if (opts.part) return opts.part;
  if (!opts.parts || !opts.parts.length) return null;
  return opts.parts.find((p) => t >= p.start && t < p.end) || opts.parts[opts.parts.length - 1];
}

function drawOverlay(ctx, o, opts) {
  const { W, H, plan, project } = opts;
  const c = o.clip;
  const p = c.props || {};
  const k = H / 1080;
  const alpha = Math.max(0, Math.min(1, o.alpha));
  ctx.save();
  ctx.globalAlpha = alpha;
  let box = null;

  const simpleText = (text, { mono = false, bgColor = 'rgba(0,0,0,0.55)', shadow = false } = {}) => {
    const size = (p.size || 40) * k;
    const css = mono ? fontCss('mono') : fontCss(p.font);
    const pad = size * 0.35;
    const lines = String(text).split('\n');
    const tb = textBlock(ctx, lines, { css }, size);
    box = overlayBox(c, tb.w + pad * 2, tb.h + pad * 2, W, H);
    if (shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.85)';
      ctx.shadowBlur = size * 0.15;
      ctx.shadowOffsetX = size * 0.05;
      ctx.shadowOffsetY = size * 0.05;
    }
    drawTextBox(ctx, box, lines, size, { color: p.color || '#fff', bg: p.box ? bgColor : null, fontCssStr: css, pad });
  };

  switch (c.kind) {
    case 'clock': {
      const part = p.restartEachPart ? currentPart(opts, plan.t) : null;
      const secs = Math.floor(plan.t - (part ? part.start : 0) + 1e-6) + (Number(p.startAt) || 0);
      simpleText(formatHMS(secs), { mono: p.font === 'mono' });
      break;
    }
    case 'part': {
      const parts = opts.parts;
      const part = currentPart(opts, plan.t);
      if (parts && parts.length > 1 && part) simpleText(`Part ${part.index + 1} of ${parts.length}`);
      else if (opts.preview && opts.selectedIds?.has(c.id)) {
        ctx.globalAlpha = alpha * 0.45;
        simpleText('Part 1 of 1 (shows when splitting)');
      }
      break;
    }
    case 'date': {
      let ms = null;
      if (p.mode === 'manual') ms = p.manual ? Date.parse(p.manual) : null;
      else {
        const layer = plan.layers.find((l) => l.mediaId && project.media[l.mediaId]?.recordedAt);
        if (layer) ms = project.media[layer.mediaId].recordedAt + (layer.kind === 'video' ? layer.sourceTime * 1000 : 0);
      }
      if (ms != null && !Number.isNaN(ms)) {
        const size = (p.size || 36) * k;
        const css = fontCss('mono');
        const text = formatStamp(ms, p.format);
        const tb = textBlock(ctx, [text], { css, weight: 700 }, size);
        box = overlayBox(c, tb.w + size * 0.5, tb.h + size * 0.3, W, H);
        ctx.shadowColor = 'rgba(0,0,0,0.9)';
        ctx.shadowBlur = size * 0.12;
        ctx.shadowOffsetX = size * 0.06;
        ctx.shadowOffsetY = size * 0.06;
        drawTextBox(ctx, box, [text], size, { color: p.color || '#ffb000', bg: null, fontCssStr: css, weight: 700, pad: size * 0.15 });
      }
      break;
    }
    case 'text':
      simpleText(p.text || '', { bgColor: hexToRgba(p.boxColor || '#000000', 0.6) });
      break;
    case 'lowerthird': {
      const size = (p.size || 48) * k;
      const css = fontCss(p.font);
      const sub = p.subtext || '';
      ctx.font = `700 ${size}px ${css}`;
      const w1 = ctx.measureText(p.text || '').width;
      ctx.font = `500 ${size * 0.62}px ${css}`;
      const w2 = sub ? ctx.measureText(sub).width : 0;
      const pad = size * 0.45;
      const accent = size * 0.18;
      const w = Math.max(w1, w2) + pad * 2 + accent;
      const h = size * 1.25 + (sub ? size * 0.8 : 0) + pad * 0.6;
      box = overlayBox(c, w, h, W, H);
      ctx.fillStyle = hexToRgba(p.barColor || '#1e3a8a', 0.88);
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.fillStyle = p.color || '#fff';
      ctx.fillRect(box.x, box.y, accent, box.h);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = `700 ${size}px ${css}`;
      ctx.fillText(p.text || '', box.x + accent + pad, box.y + pad * 0.3 + size * 0.65);
      if (sub) {
        ctx.globalAlpha = alpha * 0.85;
        ctx.font = `500 ${size * 0.62}px ${css}`;
        ctx.fillText(sub, box.x + accent + pad, box.y + pad * 0.3 + size * 1.25 + size * 0.42);
      }
      break;
    }
    case 'image': {
      const img = c.mediaId ? opts.imageFor(c.mediaId) : null;
      const w = (p.width || 0.14) * W;
      const h = img ? (w * img.height) / img.width : w * 0.5;
      box = overlayBox(c, w, h, W, H);
      if (img) ctx.drawImage(img, box.x, box.y, w, h);
      else if (opts.preview) {
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.setLineDash([6, 6]);
        ctx.strokeRect(box.x, box.y, w, h);
      }
      break;
    }
    case 'blur': {
      const w = (p.w || 0.2) * W;
      const h = (p.h || 0.2) * H;
      box = overlayBox({ ...c, corner: null }, w, h, W, H);
      applyBlur(ctx, box, p, k);
      break;
    }
    case 'subtitles': {
      const cue = cueAt(p.cues || [], o.localTime);
      const size = (p.size || 44) * k;
      const css = fontCss(p.font);
      if (cue && cue.text) {
        const pad = size * 0.3;
        const lines = cue.text.split('\n');
        const tb = textBlock(ctx, lines, { css }, size);
        box = overlayBox(c, tb.w + pad * 2, tb.h + pad * 2, W, H);
        drawTextBox(ctx, box, lines, size, { color: p.color || '#fff', bg: p.box ? 'rgba(0,0,0,0.6)' : null, fontCssStr: css, pad });
      } else if (opts.preview) {
        box = overlayBox(c, W * 0.5, size * 1.8, W, H);
      }
      break;
    }
    case 'shape': {
      const w = (p.w || 0.18) * W;
      const h = (p.h || 0.1) * H;
      box = overlayBox({ ...c, corner: null }, w, h, W, H);
      drawShape(ctx, box, p, k);
      break;
    }
    default:
      break;
  }
  ctx.restore();
  return box;
}

function applyBlur(ctx, box, p, k) {
  const canvas = ctx.canvas;
  const m = ctx.getTransform();
  // Source rectangle in canvas pixels (the context may be scaled for the preview).
  const sx = box.x * m.a + m.e;
  const sy = box.y * m.d + m.f;
  const sw = box.w * m.a;
  const sh = box.h * m.d;
  if (sw < 2 || sh < 2) return;
  const strength = Math.max(2, Number(p.strength) || 12);
  if (p.mode === 'pixelate') {
    const cell = Math.max(2, strength * k * m.a);
    const tw = Math.max(1, Math.round(sw / cell));
    const th = Math.max(1, Math.round(sh / cell));
    const tmp = new OffscreenCanvas(tw, th);
    const tctx = tmp.getContext('2d');
    tctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, tw, th);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, tw, th, box.x, box.y, box.w, box.h);
    ctx.restore();
  } else {
    const r = strength * k * m.a;
    const marg = Math.ceil(r * 2);
    const tmp = new OffscreenCanvas(Math.ceil(sw + marg * 2), Math.ceil(sh + marg * 2));
    const tctx = tmp.getContext('2d');
    tctx.filter = `blur(${r}px)`;
    tctx.drawImage(canvas, sx - marg, sy - marg, sw + marg * 2, sh + marg * 2, 0, 0, sw + marg * 2, sh + marg * 2);
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();
    ctx.drawImage(tmp, marg, marg, sw, sh, box.x, box.y, box.w, box.h);
    ctx.restore();
  }
}

function drawShape(ctx, box, p, k) {
  const lw = Math.max(1, (p.lineWidth || 6) * k);
  ctx.save();
  ctx.translate(box.x + box.w / 2, box.y + box.h / 2);
  ctx.rotate(((p.angle || 0) * Math.PI) / 180);
  ctx.strokeStyle = p.color || '#ffcc00';
  ctx.fillStyle = p.color || '#ffcc00';
  ctx.lineWidth = lw;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const w = box.w;
  const h = box.h;
  if (p.shape === 'rect') {
    ctx.beginPath();
    ctx.rect(-w / 2 + lw / 2, -h / 2 + lw / 2, w - lw, h - lw);
    p.fill ? ctx.fill() : ctx.stroke();
  } else if (p.shape === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(0, 0, Math.max(1, w / 2 - lw / 2), Math.max(1, h / 2 - lw / 2), 0, 0, Math.PI * 2);
    p.fill ? ctx.fill() : ctx.stroke();
  } else {
    // Arrow pointing right across the box.
    const head = Math.min(h * 0.9, w * 0.4, lw * 5);
    ctx.beginPath();
    ctx.moveTo(-w / 2 + lw, 0);
    ctx.lineTo(w / 2 - head * 0.9, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(w / 2 - lw / 2, 0);
    ctx.lineTo(w / 2 - head, -head * 0.6);
    ctx.lineTo(w / 2 - head, head * 0.6);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawPreviewAids(ctx, boxes, opts) {
  const { W, H } = opts;
  const unit = H / 540;
  ctx.save();
  if (opts.safeZone) {
    const z = safeZone(W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = unit;
    ctx.setLineDash([6 * unit, 6 * unit]);
    ctx.strokeRect(z.x, z.y, z.w, z.h);
  }
  // Flag overlapping overlays (blur boxes are meant to sit on top of things, so they're excluded).
  const flaggable = boxes.filter((b) => b.kind !== 'blur');
  const hits = overlappingIndices(flaggable.map((b) => b.box));
  ctx.setLineDash([5 * unit, 4 * unit]);
  ctx.lineWidth = 1.5 * unit;
  ctx.strokeStyle = '#ff5d5d';
  for (const i of hits) {
    const b = flaggable[i].box;
    ctx.strokeRect(b.x - 2 * unit, b.y - 2 * unit, b.w + 4 * unit, b.h + 4 * unit);
  }
  ctx.setLineDash([]);
  for (const b of boxes) {
    if (!opts.selectedIds?.has(b.id)) continue;
    ctx.strokeStyle = '#ffb547';
    ctx.lineWidth = 2 * unit;
    ctx.strokeRect(b.box.x - 3 * unit, b.box.y - 3 * unit, b.box.w + 6 * unit, b.box.h + 6 * unit);
    if (b.resizable) {
      const s = 9 * unit;
      ctx.fillStyle = '#ffb547';
      ctx.fillRect(b.box.x + b.box.w + 3 * unit - s / 2, b.box.y + b.box.h + 3 * unit - s / 2, s, s);
    }
  }
  ctx.restore();
}
