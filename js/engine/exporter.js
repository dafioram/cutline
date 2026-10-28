// Movie export: renders every frame, encodes with WebCodecs and writes MP4/WebM files.
// Split exports produce one file per part (each starting on a keyframe) streamed into a zip.

import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Buffer, StreamTarget as Mp4Stream, FileSystemWritableFileStreamTarget as Mp4FileTarget } from '../../vendor/mp4-muxer.mjs';
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmBuffer, StreamTarget as WebmStream, FileSystemWritableFileStreamTarget as WebmFileTarget } from '../../vendor/webm-muxer.mjs';
import { Zip, ZipPassThrough } from '../../vendor/fflate.mjs';
import { computeParts, videoBitrate, estimateBytes, AUDIO_BITRATE } from '../core/split.js';
import { partFileName, safeBaseName } from '../core/time.js';
import { soundIntervals, duckPoints, fadePoints, multiplyEnvelopes, envelopeAt, normalizeGain } from '../core/audioenv.js';
import { movieDuration } from '../core/timeline.js';
import { FrameRenderer } from './framerender.js';
import { outputSize } from './player.js';

const SAMPLE_RATE = 48000;
const IN_MEMORY_LIMIT = 700 * 1024 * 1024;

export function exportSupported() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

// ---------- codec choice ----------

async function pickVideoCodec(format, width, height, fps, bitrate) {
  const list =
    format === 'webm'
      ? [
          ['vp09.00.41.08', 'V_VP9'],
          ['vp09.00.40.08', 'V_VP9'],
          ['vp8', 'V_VP8'],
        ]
      : [
          ['avc1.640034', 'avc'],
          ['avc1.640033', 'avc'],
          ['avc1.640028', 'avc'],
          ['avc1.4D0033', 'avc'],
          ['avc1.4D0028', 'avc'],
          ['avc1.420034', 'avc'],
          ['avc1.420033', 'avc'],
          ['avc1.420028', 'avc'],
          ['avc1.42001F', 'avc'],
          ['vp09.00.41.08', 'vp9'],
        ];
  for (const [codec, mux] of list) {
    const config = { codec, width, height, bitrate, framerate: fps, latencyMode: 'quality' };
    if (mux === 'avc') config.avc = { format: 'avc' };
    try {
      const r = await VideoEncoder.isConfigSupported(config);
      if (r.supported) return { config, mux };
    } catch {
      /* try next */
    }
  }
  throw new Error(`This browser can't encode ${format.toUpperCase()} video at ${width}×${height}. Try a lower resolution or the other format.`);
}

async function pickAudioCodec(format) {
  if (typeof AudioEncoder === 'undefined') return null;
  const list = format === 'webm' ? [['opus', 'A_OPUS']] : [['mp4a.40.2', 'aac'], ['opus', 'opus']];
  for (const [codec, mux] of list) {
    const config = { codec, sampleRate: SAMPLE_RATE, numberOfChannels: 2, bitrate: AUDIO_BITRATE };
    try {
      const r = await AudioEncoder.isConfigSupported(config);
      if (r.supported) return { config, mux };
    } catch {
      /* next */
    }
  }
  return null;
}

// ---------- sinks (where bytes go) ----------

/** Sequential byte sink: a file the user picked, or memory turned into a download. */
export class ByteSink {
  constructor(writable = null) {
    this.writable = writable;
    this.parts = [];
    this.pending = Promise.resolve();
    this.size = 0;
  }
  write(chunk) {
    const copy = chunk.slice ? chunk.slice() : new Uint8Array(chunk);
    this.size += copy.byteLength;
    if (this.writable) this.pending = this.pending.then(() => this.writable.write(copy));
    else this.parts.push(copy);
  }
  async close(type) {
    if (this.writable) {
      await this.pending;
      await this.writable.close();
      return null;
    }
    return new Blob(this.parts, { type });
  }
}

class ZipWriter {
  constructor(sink) {
    this.sink = sink;
    this.error = null;
    this.zip = new Zip((err, data) => {
      if (err) this.error = err;
      else if (data && data.length) sink.write(data);
    });
  }
  entry(name) {
    const f = new ZipPassThrough(name);
    this.zip.add(f);
    return {
      push: (data, final = false) => f.push(data instanceof Uint8Array ? data : new Uint8Array(data), final),
    };
  }
  end() {
    this.zip.end();
    if (this.error) throw this.error;
  }
}

// ---------- audio ----------

/** Mix the movie's sound for [start, end) exactly as the preview plays it. */
export async function renderAudio(project, media, start, end) {
  const length = Math.max(1, Math.ceil((end - start) * SAMPLE_RATE));
  const ctx = new OfflineAudioContext(2, length, SAMPLE_RATE);
  const intervals = soundIntervals(project);
  const evenOut = project.settings.evenOutVolume;
  for (const c of project.clips) {
    const isVideo = c.track === 'video' && c.type === 'video';
    const isMusic = c.track === 'music' && c.type === 'audio';
    if (!isVideo && !isMusic) continue;
    const m = project.media[c.mediaId];
    if (!m || c.muted || !(c.volume > 0)) continue;
    if (isVideo && !m.hasAudio) continue;
    const ws = Math.max(c.start, start);
    const we = Math.min(c.start + c.duration, end);
    if (we <= ws) continue;
    let buf;
    try {
      buf = await media.decodeAudio(c.mediaId);
    } catch {
      continue;
    }
    const offset = c.in + (ws - c.start);
    if (offset >= buf.duration) continue;
    let env = fadePoints(c);
    if (isMusic && c.dimEnabled) env = multiplyEnvelopes(env, duckPoints(intervals, c.dimLevel ?? 0.25));
    const base = (c.volume ?? 1) * (evenOut && m.rms ? normalizeGain(m.rms) : 1);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    src.connect(g).connect(ctx.destination);
    g.gain.setValueAtTime(base * envelopeAt(env, ws), ws - start);
    for (const p of env) if (p.t > ws && p.t < we) g.gain.linearRampToValueAtTime(base * p.v, p.t - start);
    g.gain.linearRampToValueAtTime(base * envelopeAt(env, we), we - start);
    src.start(ws - start, offset, we - ws);
  }
  return ctx.startRendering();
}

async function encodeAudio(buffer, audioCodec) {
  const chunks = [];
  let error = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => chunks.push({ chunk, meta }),
    error: (e) => (error = e),
  });
  enc.configure(audioCodec.config);
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const step = 4800;
  for (let i = 0; i < buffer.length; i += step) {
    const n = Math.min(step, buffer.length - i);
    const data = new Float32Array(n * 2);
    data.set(left.subarray(i, i + n), 0);
    data.set(right.subarray(i, i + n), n);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: SAMPLE_RATE, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((i / SAMPLE_RATE) * 1e6), data });
    enc.encode(ad);
    ad.close();
  }
  await enc.flush();
  enc.close();
  if (error) throw error;
  return chunks;
}

// ---------- one file ----------

function makeMuxer(format, target, video, audio, W, H, fps, mode) {
  if (format === 'webm') {
    return new WebmMuxer({
      target,
      video: { codec: video.mux, width: W, height: H, frameRate: fps },
      audio: audio ? { codec: audio.mux, sampleRate: SAMPLE_RATE, numberOfChannels: 2 } : undefined,
      firstTimestampBehavior: 'offset',
      streaming: mode === 'stream',
    });
  }
  return new Mp4Muxer({
    target,
    video: { codec: video.mux, width: W, height: H, frameRate: fps },
    audio: audio ? { codec: audio.mux, sampleRate: SAMPLE_RATE, numberOfChannels: 2 } : undefined,
    fastStart: mode === 'memory' ? 'in-memory' : mode === 'stream' ? 'fragmented' : false,
    firstTimestampBehavior: 'offset',
  });
}

/**
 * Encode [start, end) of the movie into one file.
 * output: { kind: 'memory' } | { kind: 'stream', write(u8) } | { kind: 'file', writable }
 */
async function encodeRange({ project, media, renderer, start, end, part, W, H, fps, format, video, audio, output, onFrame, signal }) {
  let target;
  let mode;
  if (output.kind === 'file') {
    target = format === 'webm' ? new WebmFileTarget(output.writable) : new Mp4FileTarget(output.writable);
    mode = 'file';
  } else if (output.kind === 'stream') {
    let expected = 0;
    const onData = (data, position) => {
      if (position !== expected) throw new Error('Unexpected out-of-order write while streaming.');
      expected += data.byteLength;
      output.write(data);
    };
    target = format === 'webm' ? new WebmStream({ onData }) : new Mp4Stream({ onData });
    mode = 'stream';
  } else {
    target = format === 'webm' ? new WebmBuffer() : new Mp4Buffer();
    mode = 'memory';
  }
  const muxer = makeMuxer(format, target, video, audio, W, H, fps, mode);

  // Sound first (small), then interleave its chunks with the video in timestamp order.
  let audioChunks = [];
  if (audio) {
    const buf = await renderAudio(project, media, start, end);
    audioChunks = await encodeAudio(buf, audio);
  }
  let ai = 0;
  const flushAudio = (uptoUs) => {
    while (ai < audioChunks.length && audioChunks[ai].chunk.timestamp <= uptoUs) {
      muxer.addAudioChunk(audioChunks[ai].chunk, audioChunks[ai].meta);
      ai++;
    }
  };

  let encodeError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      try {
        flushAudio(chunk.timestamp);
        muxer.addVideoChunk(chunk, meta);
      } catch (e) {
        encodeError = e;
      }
    },
    error: (e) => (encodeError = e),
  });
  encoder.configure(video.config);

  const frames = Math.max(1, Math.round((end - start) * fps));
  const keyEvery = fps * 2;
  try {
    for (let i = 0; i < frames; i++) {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      if (encodeError) throw encodeError;
      const t = start + i / fps;
      const canvas = await renderer.render(Math.min(t, end - 1e-4), { part });
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i / fps) * 1e6), duration: Math.round(1e6 / fps) });
      encoder.encode(frame, { keyFrame: i % keyEvery === 0 });
      frame.close();
      while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 4));
      onFrame && onFrame();
    }
    await encoder.flush();
    if (encodeError) throw encodeError;
    flushAudio(Infinity);
    muxer.finalize();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  return mode === 'memory' ? new Uint8Array(target.buffer) : null;
}

// ---------- public ----------

/** Everything the export dialog shows before starting. */
export function planExport(project) {
  const duration = movieDuration(project);
  const { width, height } = outputSize(project);
  const fps = project.settings.fps;
  const bitrate = videoBitrate(width, height, fps, project.export.quality);
  const parts = project.export.mode === 'split' ? computeParts(duration, project.export.splitSeconds, fps) : [{ index: 0, start: 0, end: duration }];
  const bytes = estimateBytes(duration, bitrate);
  const partBytes = estimateBytes(Math.min(duration, project.export.splitSeconds || duration), bitrate);
  return { duration, width, height, fps, bitrate, parts, bytes, partBytes };
}

export function exportFileName(project) {
  const plan = planExport(project);
  const ext = project.export.format === 'webm' ? 'webm' : 'mp4';
  return plan.parts.length > 1 ? `${safeBaseName(project.name)}_parts.zip` : `${safeBaseName(project.name)}.${ext}`;
}

/**
 * Export the movie.
 * @param {object} o
 *   project (a frozen copy), media, writable (FileSystemWritableFileStream from the save picker, or null)
 *   onProgress({done, total, part, parts, etaSec}), signal
 * @returns {Promise<{blob: Blob|null, name: string, parts: number}>}
 */
export async function exportMovie({ project, media, writable = null, onProgress, signal }) {
  const plan = planExport(project);
  if (plan.duration <= 0) throw new Error('The movie is empty.');
  const { width: W, height: H, fps, bitrate, parts } = plan;
  const format = project.export.format === 'webm' ? 'webm' : 'mp4';
  const ext = format;
  const video = await pickVideoCodec(format, W, H, fps, bitrate);
  const audio = await pickAudioCodec(format);
  const split = parts.length > 1;
  const renderer = new FrameRenderer(media, project, W, H, { parts: split ? parts : null });
  const total = parts.reduce((n, p) => n + Math.max(1, Math.round((p.end - p.start) * fps)), 0);
  let done = 0;
  const t0 = performance.now();
  const tick = (partIndex) => {
    done++;
    if (onProgress && (done % 3 === 0 || done === total)) {
      const el = (performance.now() - t0) / 1000;
      onProgress({ done, total, part: partIndex, parts: parts.length, etaSec: done > 5 ? (el / done) * (total - done) : null });
    }
  };
  const name = exportFileName(project);
  try {
    if (!split) {
      const big = plan.bytes > IN_MEMORY_LIMIT;
      if (writable) {
        await encodeRange({ project, media, renderer, start: 0, end: plan.duration, part: null, W, H, fps, format, video, audio, output: { kind: 'file', writable }, onFrame: () => tick(0), signal });
        await writable.close();
        return { blob: null, name, parts: 1, audioCodec: audio?.config.codec || null };
      }
      if (big) {
        const sink = new ByteSink();
        await encodeRange({ project, media, renderer, start: 0, end: plan.duration, part: null, W, H, fps, format, video, audio, output: { kind: 'stream', write: (d) => sink.write(d) }, onFrame: () => tick(0), signal });
        return { blob: await sink.close(`video/${ext}`), name, parts: 1, audioCodec: audio?.config.codec || null };
      }
      const bytes = await encodeRange({ project, media, renderer, start: 0, end: plan.duration, part: null, W, H, fps, format, video, audio, output: { kind: 'memory' }, onFrame: () => tick(0), signal });
      return { blob: new Blob([bytes], { type: `video/${ext}` }), name, parts: 1, audioCodec: audio?.config.codec || null };
    }

    // Split: one file per part, streamed into a zip without compression.
    const sink = new ByteSink(writable);
    const zip = new ZipWriter(sink);
    for (const p of parts) {
      const fileName = partFileName(project.name, p.index, parts.length, p.start, p.end, ext, plan.duration);
      const entry = zip.entry(fileName);
      const bigPart = estimateBytes(p.end - p.start, bitrate) > IN_MEMORY_LIMIT;
      if (bigPart) {
        await encodeRange({ project, media, renderer, start: p.start, end: p.end, part: p, W, H, fps, format, video, audio, output: { kind: 'stream', write: (d) => entry.push(d) }, onFrame: () => tick(p.index), signal });
        entry.push(new Uint8Array(0), true);
      } else {
        const bytes = await encodeRange({ project, media, renderer, start: p.start, end: p.end, part: p, W, H, fps, format, video, audio, output: { kind: 'memory' }, onFrame: () => tick(p.index), signal });
        entry.push(bytes, true);
      }
      await sink.pending;
    }
    zip.end();
    const blob = await sink.close('application/zip');
    return { blob, name, parts: parts.length, audioCodec: audio?.config.codec || null };
  } finally {
    renderer.dispose();
    media.clearAudioCache();
  }
}
