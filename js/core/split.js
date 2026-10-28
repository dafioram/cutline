// Export planning: split points, output size and bitrate estimates.

import { RESOLUTIONS } from './model.js';

/** Fixed-length parts. The last part keeps whatever is left (dropping a sliver shorter than one frame). */
export function computeParts(duration, period, fps = 30) {
  if (!(duration > 0)) return [];
  if (!(period > 0) || period >= duration) return [{ index: 0, start: 0, end: duration }];
  const parts = [];
  const minTail = 1 / fps;
  for (let i = 0, s = 0; s < duration - 1e-9; i++, s = i * period) {
    const e = Math.min(duration, (i + 1) * period);
    if (e - s < minTail && parts.length) {
      parts[parts.length - 1].end = e;
      break;
    }
    parts.push({ index: i, start: s, end: e });
  }
  return parts;
}

/** Split line positions for the timeline (every cut, not the movie end). */
export function splitLines(duration, period) {
  return computeParts(duration, period)
    .slice(1)
    .map((p) => p.start);
}

export function partIndexAt(t, period, duration) {
  const parts = computeParts(duration, period);
  for (const p of parts) if (t >= p.start && t < p.end) return p.index;
  return Math.max(0, parts.length - 1);
}

/** Output size. "Same as source" matches the first video clip (falling back to 1080p). */
export function resolveOutputSize(resolutionId, sourceW, sourceH) {
  let w = sourceW || 1920;
  let h = sourceH || 1080;
  const r = RESOLUTIONS.find((x) => x.id === resolutionId);
  if (r && r.height) {
    const aspect = w / h;
    h = r.height;
    w = Math.round(h * aspect);
  }
  // Encoders want even dimensions.
  w = Math.max(2, Math.round(w / 2) * 2);
  h = Math.max(2, Math.round(h / 2) * 2);
  return { width: w, height: h };
}

/** Video bitrate in bits per second, scaled by pixel count and frame rate. */
export function videoBitrate(width, height, fps, quality = 'standard') {
  const pixels = width * height;
  const bpp = quality === 'high' ? 0.14 : 0.075; // bits per pixel per frame
  const raw = pixels * fps * bpp;
  return Math.round(Math.min(80e6, Math.max(500e3, raw)));
}

export const AUDIO_BITRATE = 160e3;

export function estimateBytes(seconds, vBitrate, aBitrate = AUDIO_BITRATE) {
  return Math.round(((vBitrate + aBitrate) * seconds) / 8 * 1.02);
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
