// Time formatting and parsing.

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Running-clock format: whole seconds as H:MM:SS (0 -> "0:00:00"). */
export function formatHMS(seconds) {
  const s = Math.max(0, Math.floor(seconds + 1e-6));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${pad(m)}:${pad(s % 60)}`;
}

/** Editor display with tenths: M:SS.t, or H:MM:SS.t past an hour. */
export function formatTimecode(seconds) {
  const neg = seconds < 0;
  const t = Math.abs(seconds);
  const tenths = Math.floor((t * 10 + 1e-6) % 10);
  const s = Math.floor(t + 1e-6);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const body = h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}.${tenths}` : `${m}:${pad(s % 60)}.${tenths}`;
  return (neg ? '-' : '') + body;
}

/** Short label for the ruler: M:SS or H:MM:SS. */
export function formatRuler(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/**
 * Parse "83.5", "1:23.5", "0:01:23" or "1:02:03.25" into seconds. Returns NaN when it can't.
 */
export function parseTime(text) {
  const str = String(text).trim();
  if (!str) return NaN;
  if (!/^[0-9:.]+$/.test(str)) return NaN;
  const parts = str.split(':');
  if (parts.length > 3 || parts.some((p) => p === '')) return NaN;
  let total = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isFinite(v)) return NaN;
    total = total * 60 + v;
  }
  return total;
}

/** Compact stamp used in part file names: MMSS, or HHMMSS when the movie is an hour or longer. */
export function fileStamp(seconds, longForm) {
  const s = Math.max(0, Math.round(seconds));
  if (longForm) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${pad(h)}${pad(m)}${pad(s % 60)}`;
  }
  return `${pad(Math.floor(s / 60))}${pad(s % 60)}`;
}

/** Safe base name for exported files. */
export function safeBaseName(name) {
  const cleaned = String(name || 'movie')
    .normalize('NFKD')
    .replace(/[^\w\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .toLowerCase();
  return cleaned || 'movie';
}

/** movie_part02_0030-0100.mp4 */
export function partFileName(base, index, total, start, end, ext, movieDuration) {
  const width = Math.max(2, String(total).length);
  const long = movieDuration >= 3600;
  return `${safeBaseName(base)}_part${pad(index + 1, width)}_${fileStamp(start, long)}-${fileStamp(end, long)}.${ext}`;
}
