// Format conversion for files the browser can't play natively.
// HEIC photos use a small HEIC decoder; everything else goes through ffmpeg (WebAssembly),
// which is only downloaded the first time it's needed and then cached for offline use.

const base = new URL('../../vendor/', import.meta.url);

let heicPromise = null;
function loadHeic() {
  if (!heicPromise) {
    heicPromise = new Promise((resolve, reject) => {
      if (window.heic2any) return resolve(window.heic2any);
      const s = document.createElement('script');
      s.src = new URL('heic2any.min.js', base).href;
      s.onload = () => resolve(window.heic2any);
      s.onerror = () => reject(new Error('Could not load the HEIC decoder.'));
      document.head.appendChild(s);
    });
  }
  return heicPromise;
}

export async function heicToPng(blob) {
  const heic2any = await loadHeic();
  const out = await heic2any({ blob, toType: 'image/png' });
  return Array.isArray(out) ? out[0] : out;
}

// ---------- ffmpeg ----------

let ffmpegPromise = null;
let queue = Promise.resolve();
let progressListener = null;

export const CONVERTER_URLS = [
  new URL('ffmpeg/ffmpeg-core.js', base).href,
  new URL('ffmpeg/ffmpeg-core.wasm', base).href,
];

async function getFFmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const { FFmpeg } = await import(new URL('ffmpeg/index.js', base).href);
      const ff = new FFmpeg();
      ff.on('progress', ({ progress }) => progressListener && progressListener(Math.max(0, Math.min(1, progress))));
      await ff.load({ coreURL: CONVERTER_URLS[0], wasmURL: CONVERTER_URLS[1] });
      return ff;
    })().catch((e) => {
      ffmpegPromise = null;
      console.warn('Converter failed to load', e);
      throw new Error(
        navigator.onLine
          ? 'this browser can’t play it and the format converter couldn’t be loaded'
          : 'this format needs the converter, which hasn’t been downloaded yet. Connect to the internet and try again',
      );
    });
  }
  return ffmpegPromise;
}

/** True once the converter files are in the offline cache. */
export async function converterCached() {
  if (!('caches' in window)) return false;
  for (const url of CONVERTER_URLS) {
    const hit = await caches.match(url);
    if (!hit) return false;
  }
  return true;
}

/** Download the converter now so it works offline later. */
export async function cacheConverter(onProgress) {
  let done = 0;
  for (const url of CONVERTER_URLS) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Download failed');
    await res.arrayBuffer();
    done++;
    onProgress && onProgress(done / CONVERTER_URLS.length);
  }
}

const PRESETS = {
  // High-quality intermediates so the final export is the only lossy step that matters.
  video: { ext: 'mp4', mime: 'video/mp4', args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'] },
  audio: { ext: 'flac', mime: 'audio/flac', args: ['-vn', '-c:a', 'flac'] },
  image: { ext: 'png', mime: 'image/png', args: ['-frames:v', '1'] },
  extractAudio: { ext: 'flac', mime: 'audio/flac', args: ['-vn', '-ac', '2', '-ar', '48000', '-c:a', 'flac'] },
};

let jobCounter = 0;

/**
 * Convert a file with ffmpeg. The input is mounted read-only (WORKERFS), so it is read from disk
 * as needed rather than copied into memory. Conversions run one at a time.
 */
export function convert(file, kind, onProgress) {
  const job = queue.then(async () => {
    const ff = await getFFmpeg();
    const preset = PRESETS[kind];
    const id = ++jobCounter;
    const dir = `/in${id}`;
    const out = `/out${id}.${preset.ext}`;
    const name = file.name || 'input';
    await ff.createDir(dir);
    await ff.mount('WORKERFS', { files: [new File([file], name, { type: file.type })] }, dir);
    progressListener = onProgress || null;
    try {
      const code = await ff.exec(['-hide_banner', '-y', '-i', `${dir}/${name}`, ...preset.args, out]);
      if (code !== 0) throw new Error(`The converter could not read “${name}”.`);
      const data = await ff.readFile(out);
      await ff.deleteFile(out);
      const base = name.replace(/\.[^.]+$/, '');
      return new File([data], `${base}.${preset.ext}`, { type: preset.mime });
    } finally {
      progressListener = null;
      try {
        await ff.unmount(dir);
        await ff.deleteDir(dir);
      } catch {
        /* ignore */
      }
    }
  });
  queue = job.catch(() => {});
  return job;
}
