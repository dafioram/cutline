// File type detection. The browser decides what it can play natively; this decides which path to try.

const EXT = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg', 'heic', 'heif', 'tif', 'tiff', 'jxl'],
  audio: ['mp3', 'm4a', 'aac', 'wav', 'wave', 'ogg', 'oga', 'opus', 'flac', 'wma', 'amr', 'aif', 'aiff', 'caf', 'weba', 'mka', 'ac3'],
  video: ['mp4', 'm4v', 'mov', 'qt', 'webm', 'mkv', 'avi', 'wmv', 'flv', '3gp', '3g2', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', 'ogv', 'vob', 'mxf', 'dv', 'asf'],
  subtitles: ['srt'],
};

export function extensionOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

/** 'video' | 'audio' | 'image' | 'subtitles' | null */
export function detectKind(name, mime = '') {
  const ext = extensionOf(name);
  for (const [kind, list] of Object.entries(EXT)) if (list.includes(ext)) return kind;
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/x-subrip') return 'subtitles';
  return null;
}

/** HEIC/HEIF need the HEIC decoder; TIFF/JXL and friends go through the general converter. */
export function imageConverter(name, mime = '') {
  const ext = extensionOf(name);
  if (ext === 'heic' || ext === 'heif' || /hei[cf]/.test(mime)) return 'heic';
  if (['tif', 'tiff', 'jxl'].includes(ext)) return 'ffmpeg';
  return null;
}

export function acceptAttribute() {
  const all = Object.values(EXT).flat();
  return ['video/*', 'audio/*', 'image/*', ...all.map((e) => '.' + e)].join(',');
}

export const SUPPORTED_EXTENSIONS = EXT;
