// Audio envelopes: music dimming under video sound, clip fades, loudness evening.
// Envelopes are piecewise-linear point lists so preview (Web Audio automation), export
// (OfflineAudioContext) and the timeline waveform drawing all use exactly the same curve.

export const DIM_RAMP = 0.5;

/** Time ranges where a video clip with audible sound is playing, merged when close together. */
export function soundIntervals(project, ramp = DIM_RAMP) {
  const ranges = [];
  for (const c of project.clips) {
    if (c.track !== 'video' || c.type !== 'video') continue;
    const m = project.media[c.mediaId];
    if (!m || !m.hasAudio || c.muted || !(c.volume > 0)) continue;
    ranges.push([c.start, c.start + c.duration]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r[0] - last[1] < ramp * 2) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

/** Points [{t, v}] for the dim curve: 1 normally, easing to `level` over `ramp` seconds inside intervals. */
export function duckPoints(intervals, level, ramp = DIM_RAMP) {
  const pts = [{ t: 0, v: 1 }];
  for (const [s, e] of intervals) {
    const len = e - s;
    const depth = Math.min(1, len / ramp);
    const low = 1 - (1 - level) * depth;
    const downEnd = s + Math.min(ramp, len);
    pts.push({ t: s, v: 1 }, { t: downEnd, v: low }, { t: e, v: low }, { t: e + ramp, v: 1 });
  }
  return dedupe(pts);
}

function dedupe(pts) {
  const out = [];
  for (const p of pts) {
    const last = out.at(-1);
    if (last && Math.abs(last.t - p.t) < 1e-9) last.v = p.v;
    else out.push({ ...p });
  }
  return out;
}

/** Value of a piecewise-linear envelope at t (flat before the first and after the last point). */
export function envelopeAt(points, t) {
  if (!points.length) return 1;
  if (t <= points[0].t) return points[0].v;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (t <= b.t) {
      const span = b.t - a.t;
      return span <= 0 ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / span;
    }
  }
  return points.at(-1).v;
}

/** Fade-in/out multiplier for a clip at movie time t. */
export function fadeGainAt(clip, t) {
  const local = t - clip.start;
  let g = 1;
  if (clip.fadeIn > 0 && local < clip.fadeIn) g = Math.min(g, Math.max(0, local / clip.fadeIn));
  const left = clip.start + clip.duration - t;
  if (clip.fadeOut > 0 && left < clip.fadeOut) g = Math.min(g, Math.max(0, left / clip.fadeOut));
  return g;
}

/** Fade envelope as points in movie time (for audio automation). */
export function fadePoints(clip) {
  const s = clip.start;
  const e = clip.start + clip.duration;
  const pts = [];
  pts.push({ t: s, v: clip.fadeIn > 0 ? 0 : 1 });
  if (clip.fadeIn > 0) pts.push({ t: s + clip.fadeIn, v: 1 });
  if (clip.fadeOut > 0) pts.push({ t: e - clip.fadeOut, v: 1 });
  pts.push({ t: e, v: clip.fadeOut > 0 ? 0 : 1 });
  return dedupe(pts.sort((a, b) => a.t - b.t));
}

/** Multiply two envelopes, sampling at the union of their breakpoints. */
export function multiplyEnvelopes(a, b) {
  const ts = [...new Set([...a.map((p) => p.t), ...b.map((p) => p.t)])].sort((x, y) => x - y);
  return ts.map((t) => ({ t, v: envelopeAt(a, t) * envelopeAt(b, t) }));
}

/** Gain to bring a clip with this RMS to the target loudness, kept within sensible bounds. */
export function normalizeGain(rms, target = 0.1, maxBoost = 4, maxCut = 0.25) {
  if (!(rms > 1e-5)) return 1;
  return Math.min(maxBoost, Math.max(maxCut, target / rms));
}

export function rmsOf(channels, from = 0, to = Infinity, stride = 4) {
  let sum = 0;
  let n = 0;
  for (const ch of channels) {
    const end = Math.min(ch.length, to);
    for (let i = Math.max(0, from); i < end; i += stride) {
      sum += ch[i] * ch[i];
      n++;
    }
  }
  return n ? Math.sqrt(sum / n) : 0;
}
