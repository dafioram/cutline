// What to draw at a given movie time. Pure, so preview, export and tests agree on the result.

import { fadeGainAt } from './audioenv.js';
import { clipEnd, effectiveRange, trackClips } from './timeline.js';
import { clamp, EPS } from './util.js';

function layerFor(clip, t, alpha) {
  const layer = { clip, kind: clip.type, mediaId: clip.mediaId || null, alpha, wipe: null, sourceTime: 0 };
  if (clip.type === 'video') layer.sourceTime = Math.max(0, clip.in + (t - clip.start));
  return layer;
}

function clipFade(clip, t) {
  return fadeGainAt(clip, clamp(t, clip.start, clipEnd(clip) - EPS));
}

/** Active transition at t, if any: {a, b, p, type}. Window is centered on the seam. */
export function transitionAt(project, t) {
  const cs = trackClips(project, 'video');
  for (let i = 1; i < cs.length; i++) {
    const a = cs[i - 1];
    const b = cs[i];
    if (!b.transition || Math.abs(clipEnd(a) - b.start) > 1e-3) continue;
    const d = b.transition.duration;
    const from = b.start - d / 2;
    const to = b.start + d / 2;
    if (t >= from && t < to) return { a, b, p: (t - from) / d, type: b.transition.type };
  }
  return null;
}

export function planVideoLayers(project, t) {
  const tr = transitionAt(project, t);
  if (tr) {
    const { a, b, p, type } = tr;
    const fa = clipFade(a, t);
    const fb = clipFade(b, t);
    if (type === 'fadeblack') {
      return p < 0.5 ? [layerFor(a, t, fa * (1 - 2 * p))] : [layerFor(b, t, fb * (2 * p - 1))];
    }
    if (type === 'wipe') {
      const lb = layerFor(b, t, fb);
      lb.wipe = p;
      return [layerFor(a, t, fa), lb];
    }
    return [layerFor(a, t, fa), layerFor(b, t, fb * p)];
  }
  const active = trackClips(project, 'video').find((c) => t >= c.start - EPS && t < clipEnd(c) - EPS);
  if (!active) return [];
  return [layerFor(active, t, fadeGainAt(active, t))];
}

export function planOverlays(project, t) {
  const out = [];
  for (const c of project.clips) {
    if (c.track !== 'overlay') continue;
    const [s, e] = effectiveRange(project, c);
    if (!(t >= s - EPS && t < e - EPS)) continue;
    const span = { start: s, duration: e - s, fadeIn: c.fadeIn, fadeOut: c.fadeOut };
    out.push({ clip: c, alpha: (c.opacity ?? 1) * fadeGainAt(span, t), localTime: t - s });
  }
  return out.sort((x, y) => x.clip.lane - y.clip.lane);
}

export function planFrame(project, t) {
  return { t, layers: planVideoLayers(project, t), overlays: planOverlays(project, t) };
}

/** Media files needed to draw time t (so export can pre-seek them). */
export function mediaNeededAt(plan) {
  const ids = new Set();
  for (const l of plan.layers) if (l.mediaId) ids.add(l.mediaId);
  for (const o of plan.overlays) if (o.clip.mediaId) ids.add(o.clip.mediaId);
  return [...ids];
}
