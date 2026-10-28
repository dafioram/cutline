// Scene-change detection from sampled frame color histograms.

export const HIST_BINS = 16;

/** Normalized RGB histogram (3 x HIST_BINS floats) from RGBA pixel data. */
export function histogram(rgba, bins = HIST_BINS) {
  const h = new Float32Array(bins * 3);
  const shift = 8 - Math.log2(bins);
  let n = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    h[rgba[i] >> shift]++;
    h[bins + (rgba[i + 1] >> shift)]++;
    h[2 * bins + (rgba[i + 2] >> shift)]++;
    n++;
  }
  if (n) for (let i = 0; i < h.length; i++) h[i] /= n;
  return h;
}

/** Half the L1 distance per channel, averaged: 0 = identical, 1 = completely different. */
export function histDistance(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / 6;
}

/**
 * Cut times from samples [{t, hist}]. A cut needs a big jump both in absolute terms and relative
 * to the recent average, which keeps camera pans and flicker from triggering it.
 */
export function detectCuts(samples, { threshold = 0.3, ratio = 3, minScene = 1.0, window = 6 } = {}) {
  const cuts = [];
  const recent = [];
  let lastCut = samples.length ? samples[0].t : 0;
  for (let i = 1; i < samples.length; i++) {
    const d = histDistance(samples[i - 1].hist, samples[i].hist);
    const avg = recent.length ? recent.reduce((x, y) => x + y, 0) / recent.length : 0;
    const t = samples[i].t;
    if (d >= threshold && d >= avg * ratio && t - lastCut >= minScene) {
      cuts.push(t);
      lastCut = t;
      recent.length = 0;
    } else {
      recent.push(d);
      if (recent.length > window) recent.shift();
    }
  }
  return cuts;
}

/** Scene ranges [{start, end}] covering the whole duration, with cut points between them. */
export function scenesFromCuts(cuts, duration) {
  const pts = [0, ...cuts.filter((c) => c > 0 && c < duration), duration];
  const out = [];
  for (let i = 1; i < pts.length; i++) if (pts[i] - pts[i - 1] > 1e-3) out.push({ start: pts[i - 1], end: pts[i] });
  return out;
}

/** Sampling interval: twice a second, but at most `maxSamples` samples for long videos. */
export function sampleInterval(duration, maxSamples = 1200) {
  return Math.max(0.5, duration / maxSamples);
}
