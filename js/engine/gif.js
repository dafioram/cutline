// Quick share: a looping GIF under 10 MB for GitHub issues and READMEs.

import { GIFEncoder, quantize, applyPalette } from '../../vendor/gifenc.mjs';
import { estimateGifBytes, frameDelays, gifSize, GIF_TARGET } from '../core/gifplan.js';
import { FrameRenderer } from './framerender.js';
import { outputSize } from './player.js';

const SAMPLE_WIDTH = 480;
const SAMPLE_FRAMES = 6;

function frameTimes(start, end, fps) {
  const n = Math.max(1, Math.round((end - start) * fps));
  return Array.from({ length: n }, (_, i) => start + i / fps);
}

function encodeFrame(gif, ctx, w, h, delayCs, first) {
  const { data } = ctx.getImageData(0, 0, w, h);
  const palette = quantize(data, 256, { format: 'rgb444' });
  const index = applyPalette(data, palette, 'rgb444');
  gif.writeFrame(index, w, h, { palette, delay: delayCs * 10, repeat: first ? 0 : undefined });
}

function aspectOf(project) {
  const { width, height } = outputSize(project);
  return width / height;
}

/** Measure bytes per frame on a few sample frames, to predict the size at each width. */
export async function sampleGif(media, project, start, end, fps) {
  const aspect = aspectOf(project);
  const { width, height } = gifSize(SAMPLE_WIDTH, aspect);
  const renderer = new FrameRenderer(media, project, width, height, { readback: true });
  const ctx = renderer.ctx;
  try {
    const times = frameTimes(start, end, fps);
    const picks = Array.from({ length: Math.min(SAMPLE_FRAMES, times.length) }, (_, i) => times[Math.floor((i * times.length) / Math.min(SAMPLE_FRAMES, times.length))]);
    const gif = GIFEncoder();
    for (let i = 0; i < picks.length; i++) {
      await renderer.render(picks[i]);
      encodeFrame(gif, ctx, width, height, 8, i === 0);
    }
    gif.finish();
    const bytes = gif.bytesView().length;
    return { sample: { width: SAMPLE_WIDTH, bytesPerFrame: bytes / picks.length }, frames: times.length, aspect };
  } finally {
    renderer.dispose();
  }
}

export function estimateAt(sampleInfo, width) {
  return estimateGifBytes(sampleInfo.sample, width, sampleInfo.frames);
}

/** Encode the GIF at a given width. Returns a Blob. */
export async function renderGif({ media, project, start, end, fps, width, onProgress, signal }) {
  const aspect = aspectOf(project);
  const { width: w, height: h } = gifSize(width, aspect);
  const renderer = new FrameRenderer(media, project, w, h, { readback: true });
  const ctx = renderer.ctx;
  try {
    const times = frameTimes(start, end, fps);
    const delays = frameDelays(times.length, fps);
    const gif = GIFEncoder();
    for (let i = 0; i < times.length; i++) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      await renderer.render(times[i]);
      encodeFrame(gif, ctx, w, h, delays[i], i === 0);
      onProgress && onProgress((i + 1) / times.length);
      if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
    }
    gif.finish();
    return new Blob([gif.bytesView()], { type: 'image/gif' });
  } finally {
    renderer.dispose();
  }
}

export const fitsLimit = (bytes) => bytes <= GIF_TARGET;
