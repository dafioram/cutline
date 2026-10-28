// Media library: importing, converting, probing, thumbnails, waveforms and audio decoding.
// Files are kept on disk (OPFS); only small derived data (thumbnails, peaks) stays in memory.

import { createMedia, createBinItem } from '../core/model.js';
import { detectKind, imageConverter, extensionOf } from '../core/formats.js';
import { readMp4CreationTime } from '../core/mp4meta.js';
import { parseSRT } from '../core/srt.js';
import { storage } from './storage.js';
import { convert, heicToPng } from './convert.js';

const MAX_BITMAP = 3840; // longest side kept for still images
const STRIP_FRAMES = 12;
const PEAKS_PER_SEC = 50;
const DIRECT_DECODE_LIMIT = 400 * 1024 * 1024; // bigger files get their audio extracted first
const AUDIO_CACHE_BYTES = 450 * 1024 * 1024;
const NATIVE_SOUND_CONTAINERS = ['mp4', 'm4v', 'webm', 'mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'weba'];

function waitFor(el, okEvent, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => done(new Error('timeout')), timeout);
    const ok = () => done();
    const bad = () => done(new Error(el.error ? `media error ${el.error.code}` : 'media error'));
    function done(err) {
      clearTimeout(t);
      el.removeEventListener(okEvent, ok);
      el.removeEventListener('error', bad);
      err ? reject(err) : resolve();
    }
    el.addEventListener(okEvent, ok, { once: true });
    el.addEventListener('error', bad, { once: true });
  });
}

/** Seek a media element and wait until the frame is ready. */
export async function seekTo(el, t, timeout = 15000) {
  const target = Math.max(0, Math.min(t, (el.duration || t) - 0.001));
  if (Math.abs(el.currentTime - target) < 1e-4 && el.readyState >= 2) return;
  const p = waitFor(el, 'seeked', timeout);
  el.currentTime = target;
  await p;
}

async function fixInfiniteDuration(el) {
  if (Number.isFinite(el.duration)) return;
  const p = waitFor(el, 'durationchange', 10000).catch(() => {});
  el.currentTime = 1e101;
  await p;
  el.currentTime = 0;
}

export class MediaLibrary {
  constructor(store) {
    this.store = store;
    this.files = new Map();
    this.urls = new Map();
    this.bitmaps = new Map();
    this.thumbs = new Map();
    this.strips = new Map();
    this.peaks = new Map();
    this.status = new Map();
    this.audioCache = new Map(); // id -> AudioBuffer (LRU by insertion order)
    this.audioCacheBytes = 0;
    this.analysisQueue = Promise.resolve();
  }

  // ---------- state ----------

  setStatus(id, s) {
    this.status.set(id, { ...(this.status.get(id) || {}), ...s });
    this.store.emit('media', { id });
  }

  getStatus(id) {
    return this.status.get(id) || { state: 'missing' };
  }

  isReady(id) {
    return this.getStatus(id).state === 'ready';
  }

  file(id) {
    return this.files.get(id) || null;
  }

  url(id) {
    if (!this.urls.has(id) && this.files.has(id)) this.urls.set(id, URL.createObjectURL(this.files.get(id)));
    return this.urls.get(id) || null;
  }

  setFile(id, file) {
    if (this.urls.has(id)) URL.revokeObjectURL(this.urls.get(id));
    this.urls.delete(id);
    this.files.set(id, file);
    this.bitmaps.delete(id);
    this.dropAudio(id);
  }

  meta(id) {
    return this.store.project.media[id];
  }

  // ---------- import ----------

  /**
   * Start importing files. Each appears in the workspace immediately with a progress ring;
   * conversion and analysis continue in the background. Subtitle files are returned as cues.
   */
  async importFiles(fileList, { onSubtitles, onError, onVideoReady } = {}) {
    const results = [];
    storage.persist();
    for (const file of fileList) {
      const kind = detectKind(file.name, file.type);
      if (!kind) {
        onError && onError(`“${file.name}” isn't a video, music or photo file Cutline recognises.`);
        continue;
      }
      if (kind === 'subtitles') {
        try {
          const cues = parseSRT(await file.text());
          if (!cues.length) throw new Error('no cues');
          onSubtitles && onSubtitles(cues, file.name);
        } catch {
          onError && onError(`“${file.name}” doesn't contain any subtitles Cutline can read.`);
        }
        continue;
      }
      const media = createMedia({ name: file.name, kind, size: file.size, mime: file.type });
      const item = createBinItem({ mediaId: media.id, name: file.name });
      this.store.silent((p) => {
        p.media[media.id] = media;
        p.bin.push(item);
      });
      this.setStatus(media.id, { state: 'importing', progress: 0, message: 'Importing' });
      const job = this.processImport(media.id, file)
        .then(() => {
          if (kind === 'video' && onVideoReady) onVideoReady(media.id, item.id);
        })
        .catch((e) => {
          this.setStatus(media.id, { state: 'error', message: e.message || String(e) });
          onError && onError(`Couldn't import “${file.name}”: ${e.message || e}`);
        });
      results.push({ media, item, job });
    }
    return results;
  }

  async processImport(id, file) {
    const m = this.meta(id);
    let final = file;
    if (m.kind === 'image') final = await this.prepareImage(id, file);
    else if (m.kind === 'video') final = await this.prepareVideo(id, file);
    else if (m.kind === 'audio') final = await this.prepareAudio(id, file);
    this.setStatus(id, { state: 'saving', message: 'Saving', progress: 1 });
    this.setFile(id, final);
    try {
      await storage.saveMedia(id, final);
    } catch (e) {
      console.warn('Could not save media to disk', e);
    }
    this.setStatus(id, { state: 'ready', message: '', progress: 1 });
    if (m.kind !== 'image') this.queueAnalysis(id);
  }

  async prepareImage(id, file) {
    let blob = file;
    const conv = imageConverter(file.name, file.type);
    if (conv === 'heic') {
      this.setStatus(id, { state: 'converting', message: 'Converting photo', progress: 0.2 });
      blob = await heicToPng(file);
    } else if (conv === 'ffmpeg') {
      blob = await this.convertWithProgress(id, file, 'image', 'Converting photo');
    }
    let bmp;
    try {
      bmp = await this.makeBitmap(blob);
    } catch {
      if (conv) throw new Error('the photo could not be decoded');
      blob = await this.convertWithProgress(id, file, 'image', 'Converting photo');
      bmp = await this.makeBitmap(blob);
    }
    this.bitmaps.set(id, bmp);
    this.thumbs.set(id, this.thumbFromSource(bmp, bmp.width, bmp.height));
    const name = blob === file ? file.name : file.name.replace(/\.[^.]+$/, '.png');
    this.store.silent((p) => Object.assign(p.media[id], { width: bmp.width, height: bmp.height, converted: blob !== file, recordedAt: file.lastModified || null, recordedAtSource: 'file' }));
    return blob instanceof File ? blob : new File([blob], name, { type: blob.type || 'image/png' });
  }

  async prepareVideo(id, file) {
    this.setStatus(id, { state: 'importing', message: 'Reading video', progress: 0.1 });
    let final = file;
    let info = await this.probeVideo(file).catch(() => null);
    if (!info) {
      final = await this.convertWithProgress(id, file, 'video', 'Converting video');
      info = await this.probeVideo(final);
      this.store.silent((p) => (p.media[id].converted = true));
    }
    let recordedAt = null;
    let src = 'file';
    if (['mp4', 'mov', 'm4v', '3gp', 'qt'].includes(extensionOf(file.name))) {
      recordedAt = await readMp4CreationTime(async (o, l) => new Uint8Array(await file.slice(o, o + l).arrayBuffer()), file.size).catch(() => null);
      if (recordedAt) src = 'metadata';
    }
    if (!recordedAt) recordedAt = file.lastModified || null;
    this.store.silent((p) =>
      Object.assign(p.media[id], {
        duration: info.duration,
        width: info.width,
        height: info.height,
        hasAudio: true,
        recordedAt,
        recordedAtSource: src,
        name: p.media[id].name,
      }),
    );
    await this.makeStrip(id, final, info.duration);
    return final;
  }

  async prepareAudio(id, file) {
    let final = file;
    let duration = await this.probeAudio(file).catch(() => null);
    if (duration == null) {
      final = await this.convertWithProgress(id, file, 'audio', 'Converting audio');
      duration = await this.probeAudio(final);
      this.store.silent((p) => (p.media[id].converted = true));
    }
    this.store.silent((p) => Object.assign(p.media[id], { duration, hasAudio: true }));
    return final;
  }

  async convertWithProgress(id, file, kind, message) {
    this.setStatus(id, { state: 'converting', message, progress: 0 });
    return convert(file, kind, (pr) => this.setStatus(id, { state: 'converting', message, progress: pr }));
  }

  async makeBitmap(blob) {
    const probe = await createImageBitmap(blob);
    const scale = Math.min(1, MAX_BITMAP / Math.max(probe.width, probe.height));
    if (scale >= 1) return probe;
    const w = Math.round(probe.width * scale);
    const h = Math.round(probe.height * scale);
    probe.close();
    return createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
  }

  async probeVideo(blob) {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.playsInline = true;
    const url = URL.createObjectURL(blob);
    try {
      const meta = waitFor(v, 'loadedmetadata');
      v.src = url;
      await meta;
      await fixInfiniteDuration(v);
      if (!v.videoWidth || !(v.duration > 0)) throw new Error('no video');
      await seekTo(v, Math.min(0.1, v.duration / 2));
      const c = document.createElement('canvas');
      c.width = 4;
      c.height = 4;
      c.getContext('2d').drawImage(v, 0, 0, 4, 4);
      return { duration: v.duration, width: v.videoWidth, height: v.videoHeight };
    } finally {
      v.removeAttribute('src');
      v.load();
      URL.revokeObjectURL(url);
    }
  }

  async probeAudio(blob) {
    const a = document.createElement('audio');
    a.preload = 'auto';
    const url = URL.createObjectURL(blob);
    try {
      const meta = waitFor(a, 'loadedmetadata');
      a.src = url;
      await meta;
      await fixInfiniteDuration(a);
      if (!(a.duration > 0)) throw new Error('no audio');
      return a.duration;
    } finally {
      a.removeAttribute('src');
      a.load();
      URL.revokeObjectURL(url);
    }
  }

  thumbFromSource(src, w, h, tw = 160, th = 90) {
    const c = document.createElement('canvas');
    c.width = tw;
    c.height = th;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, tw, th);
    const s = Math.min(tw / w, th / h);
    ctx.drawImage(src, (tw - w * s) / 2, (th - h * s) / 2, w * s, h * s);
    return c.toDataURL('image/jpeg', 0.72);
  }

  /** Thumbnails across the video for the workspace and timeline. */
  async makeStrip(id, blob, duration) {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    const url = URL.createObjectURL(blob);
    const frames = [];
    try {
      const meta = waitFor(v, 'loadedmetadata');
      v.src = url;
      await meta;
      for (let i = 0; i < STRIP_FRAMES; i++) {
        const t = ((i + 0.5) / STRIP_FRAMES) * duration;
        await seekTo(v, t);
        frames.push({ t, src: this.thumbFromSource(v, v.videoWidth, v.videoHeight) });
        this.setStatus(id, { progress: 0.3 + (0.6 * (i + 1)) / STRIP_FRAMES });
      }
    } catch (e) {
      console.warn('thumbnail strip failed', e);
    } finally {
      v.removeAttribute('src');
      v.load();
      URL.revokeObjectURL(url);
    }
    if (frames.length) {
      this.strips.set(id, frames);
      this.thumbs.set(id, frames[Math.min(1, frames.length - 1)].src);
    }
  }

  /** Thumbnail for a point in a video (nearest strip frame). */
  thumbAt(id, t) {
    const strip = this.strips.get(id);
    if (!strip || !strip.length) return this.thumbs.get(id) || null;
    let best = strip[0];
    for (const f of strip) if (Math.abs(f.t - t) < Math.abs(best.t - t)) best = f;
    return best.src;
  }

  // ---------- audio ----------

  queueAnalysis(id) {
    this.analysisQueue = this.analysisQueue.then(() => this.analyze(id)).catch((e) => console.warn('analysis failed', e));
    return this.analysisQueue;
  }

  async analyze(id) {
    const m = this.meta(id);
    if (!m || !this.files.has(id)) return;
    this.setStatus(id, { analyzing: true });
    let buf = null;
    try {
      buf = await this.decodeAudio(id, { cache: false });
    } catch {
      buf = null;
    }
    if (!buf && m.kind === 'video' && !m.converted && !NATIVE_SOUND_CONTAINERS.includes(extensionOf(m.name))) {
      // The browser shows the picture but can't decode this file's sound: convert the whole file.
      try {
        const converted = await this.convertWithProgress(id, this.files.get(id), 'video', 'Converting sound');
        this.setFile(id, converted);
        await storage.saveMedia(id, converted).catch(() => {});
        this.store.silent((p) => (p.media[id].converted = true));
        this.setStatus(id, { state: 'ready', message: '' });
        buf = await this.decodeAudio(id, { cache: false }).catch(() => null);
      } catch {
        this.setStatus(id, { state: 'ready', message: '' });
      }
    }
    if (!buf) {
      this.store.silent((p) => p.media[id] && Object.assign(p.media[id], { hasAudio: false, rms: 0 }));
      this.setStatus(id, { analyzing: false });
      return;
    }
    const { peaks, rms } = computePeaks(buf);
    this.peaks.set(id, peaks);
    this.store.silent((p) => p.media[id] && Object.assign(p.media[id], { hasAudio: rms > 1e-4, rms }));
    this.setStatus(id, { analyzing: false });
  }

  /** Decode a media file's sound at 48 kHz. Large files have their audio extracted first. */
  async decodeAudio(id, { cache = true } = {}) {
    if (this.audioCache.has(id)) {
      const b = this.audioCache.get(id);
      this.audioCache.delete(id);
      this.audioCache.set(id, b);
      return b;
    }
    let file = this.files.get(id);
    if (!file) throw new Error('missing file');
    if (file.size > DIRECT_DECODE_LIMIT) file = await convert(file, 'extractAudio');
    const ctx = new OfflineAudioContext(2, 1, 48000);
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    if (cache) {
      const bytes = buf.length * buf.numberOfChannels * 4;
      this.audioCache.set(id, buf);
      this.audioCacheBytes += bytes;
      for (const [k, b] of this.audioCache) {
        if (this.audioCacheBytes <= AUDIO_CACHE_BYTES || k === id) break;
        this.audioCache.delete(k);
        this.audioCacheBytes -= b.length * b.numberOfChannels * 4;
      }
    }
    return buf;
  }

  dropAudio(id) {
    const b = this.audioCache.get(id);
    if (b) {
      this.audioCache.delete(id);
      this.audioCacheBytes -= b.length * b.numberOfChannels * 4;
    }
  }

  clearAudioCache() {
    this.audioCache.clear();
    this.audioCacheBytes = 0;
  }

  // ---------- images ----------

  async bitmap(id) {
    if (this.bitmaps.has(id)) return this.bitmaps.get(id);
    const f = this.files.get(id);
    if (!f) return null;
    const b = await this.makeBitmap(f);
    this.bitmaps.set(id, b);
    return b;
  }

  /** Add an image made inside the app (freeze frame). */
  async addGeneratedImage(blob, name) {
    const media = createMedia({ name, kind: 'image', size: blob.size, mime: 'image/png' });
    const file = new File([blob], name, { type: 'image/png' });
    const bmp = await this.makeBitmap(file);
    media.width = bmp.width;
    media.height = bmp.height;
    this.bitmaps.set(media.id, bmp);
    this.thumbs.set(media.id, this.thumbFromSource(bmp, bmp.width, bmp.height));
    this.setFile(media.id, file);
    this.bitmaps.set(media.id, bmp);
    this.setStatus(media.id, { state: 'ready' });
    storage.saveMedia(media.id, file).catch(() => {});
    return media;
  }

  // ---------- restore / relink ----------

  /** After loading a saved project, reattach files from disk and rebuild thumbnails. */
  async restore(project) {
    for (const id of Object.keys(project.media)) {
      const f = await storage.loadMedia(id);
      if (f) {
        this.setFile(id, f);
        this.setStatus(id, { state: 'ready' });
      } else {
        this.setStatus(id, { state: 'missing', message: 'File missing' });
      }
    }
    for (const id of Object.keys(project.media)) {
      if (!this.files.has(id)) continue;
      const m = project.media[id];
      try {
        if (m.kind === 'image') {
          const b = await this.bitmap(id);
          this.thumbs.set(id, this.thumbFromSource(b, b.width, b.height));
          this.store.emit('media', { id });
        } else if (m.kind === 'video') {
          await this.makeStrip(id, this.files.get(id), m.duration);
          this.setStatus(id, { state: 'ready' });
        }
        if (m.kind !== 'image') this.queueAnalysis(id);
      } catch (e) {
        console.warn('restore failed for', m.name, e);
      }
    }
  }

  async relink(id, file) {
    const m = this.meta(id);
    const kind = detectKind(file.name, file.type);
    if (kind !== m.kind) throw new Error(`That file is ${kind || 'not a media file'}, but “${m.name}” was ${m.kind}.`);
    this.setStatus(id, { state: 'importing', message: 'Relinking', progress: 0 });
    await this.processImport(id, file);
  }

  async forget(id) {
    this.setFile(id, null);
    this.files.delete(id);
    this.thumbs.delete(id);
    this.strips.delete(id);
    this.peaks.delete(id);
    this.status.delete(id);
    await storage.deleteMedia(id);
  }
}

/** Waveform peaks (0..255 per bucket) and overall RMS loudness. */
export function computePeaks(buf) {
  const chans = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  const step = Math.max(1, Math.floor(buf.sampleRate / PEAKS_PER_SEC));
  const n = Math.ceil(buf.length / step);
  const peaks = new Uint8Array(n);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    let max = 0;
    const from = i * step;
    const to = Math.min(buf.length, from + step);
    for (const ch of chans) {
      for (let j = from; j < to; j += 2) {
        const v = Math.abs(ch[j]);
        if (v > max) max = v;
        sum += ch[j] * ch[j];
        count++;
      }
    }
    peaks[i] = Math.min(255, Math.round(Math.sqrt(max) * 255));
  }
  return { peaks, rms: count ? Math.sqrt(sum / count) : 0, perSec: PEAKS_PER_SEC };
}

export { PEAKS_PER_SEC };
