// Quick share (GitHub-sized GIF) planning.

export const GIF_LIMIT = 10 * 1024 * 1024;
export const GIF_TARGET = Math.floor(GIF_LIMIT * 0.97); // a little headroom
export const GIF_WIDTHS = [800, 640, 480, 360, 240];
export const LEGIBLE_WIDTH = 480;
export const GIF_FPS_OPTIONS = [10, 12, 15];

export function gifSize(width, aspect) {
  const w = Math.round(width);
  const h = Math.max(2, Math.round(w / aspect));
  return { width: w, height: h };
}

/** Next smaller width step, or null at the floor. */
export function nextWidth(width) {
  const i = GIF_WIDTHS.indexOf(width);
  if (i === -1) return GIF_WIDTHS.find((w) => w < width) ?? null;
  return GIF_WIDTHS[i + 1] ?? null;
}

/**
 * Estimate bytes at each width from a measured sample: bytes scale roughly with pixel count.
 * `sample` = { width, bytesPerFrame } measured by encoding a few frames.
 */
export function estimateGifBytes(sample, width, frames) {
  const scale = (width / sample.width) ** 2;
  return Math.round(sample.bytesPerFrame * scale * frames + 800);
}

/** Widest step whose estimate fits the target; null if even the floor is too big. */
export function pickWidth(estimateFor) {
  for (const w of GIF_WIDTHS) if (estimateFor(w) <= GIF_TARGET) return w;
  return null;
}

export function isLegible(width) {
  return width >= LEGIBLE_WIDTH;
}

/** Hundredths-of-a-second frame delay GIF uses, kept exact over time by carrying the remainder. */
export function frameDelays(frameCount, fps) {
  const out = [];
  let acc = 0;
  let emitted = 0;
  for (let i = 0; i < frameCount; i++) {
    acc += 100 / fps;
    const d = Math.round(acc) - emitted;
    out.push(Math.max(2, d));
    emitted += d;
  }
  return out;
}
