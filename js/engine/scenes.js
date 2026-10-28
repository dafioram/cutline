// Samples a video at low resolution and finds scene changes.

import { histogram, detectCuts, scenesFromCuts, sampleInterval } from '../core/scenes.js';
import { seekTo } from './media.js';

export async function findScenes(file, duration, { onProgress, signal } = {}) {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  const url = URL.createObjectURL(file);
  const canvas = new OffscreenCanvas(48, 27);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const samples = [];
  try {
    v.src = url;
    await new Promise((resolve, reject) => {
      v.addEventListener('loadedmetadata', resolve, { once: true });
      v.addEventListener('error', () => reject(new Error('could not read video')), { once: true });
    });
    const step = sampleInterval(duration);
    const n = Math.floor(duration / step);
    for (let i = 0; i <= n; i++) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const t = Math.min(duration - 0.05, i * step);
      await seekTo(v, t);
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      samples.push({ t, hist: histogram(ctx.getImageData(0, 0, canvas.width, canvas.height).data) });
      if (onProgress && i % 5 === 0) onProgress(i / n);
    }
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
  return scenesFromCuts(detectCuts(samples), duration);
}
