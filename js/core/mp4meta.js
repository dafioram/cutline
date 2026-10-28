// Reads the recording date from MP4/MOV files (the movie header "mvhd" creation time).
// Works with random-access reads so only a few small slices of a large file are touched.

const MAC_EPOCH_OFFSET = 2082844800; // seconds between 1904-01-01 and 1970-01-01

function u32(b, o) {
  return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}

function u64(b, o) {
  return u32(b, o) * 2 ** 32 + u32(b, o + 4);
}

function type(b, o) {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

async function readHeader(readAt, offset, end) {
  if (offset + 8 > end) return null;
  const b = await readAt(offset, 16);
  if (b.length < 8) return null;
  let size = u32(b, 0);
  const t = type(b, 4);
  let header = 8;
  if (size === 1) {
    if (b.length < 16) return null;
    size = u64(b, 8);
    header = 16;
  } else if (size === 0) {
    size = end - offset;
  }
  if (size < header) return null;
  return { type: t, size, header };
}

/**
 * @param {(offset:number, length:number) => Promise<Uint8Array>} readAt
 * @param {number} fileSize
 * @returns {Promise<number|null>} epoch milliseconds, or null when absent/implausible
 */
export async function readMp4CreationTime(readAt, fileSize) {
  let off = 0;
  let guard = 0;
  while (off < fileSize && guard++ < 10000) {
    const h = await readHeader(readAt, off, fileSize);
    if (!h) return null;
    if (h.type === 'moov') {
      let c = off + h.header;
      const end = off + h.size;
      while (c < end && guard++ < 10000) {
        const ch = await readHeader(readAt, c, end);
        if (!ch) return null;
        if (ch.type === 'mvhd') {
          const b = await readAt(c + ch.header, 20);
          const version = b[0];
          const secs = version === 1 ? u64(b, 4) : u32(b, 4);
          return plausible(secs);
        }
        c += ch.size;
      }
      return null;
    }
    off += h.size;
  }
  return null;
}

function plausible(macSeconds) {
  if (!macSeconds) return null;
  const ms = (macSeconds - MAC_EPOCH_OFFSET) * 1000;
  const min = Date.UTC(1995, 0, 1);
  const max = Date.now() + 2 * 86400000;
  return ms >= min && ms <= max ? ms : null;
}

/** Date stamp text in camcorder style. */
export function formatStamp(ms, format = 'datetime') {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const p = (n) => String(n).padStart(2, '0');
  const date = `${months[d.getMonth()]} ${p(d.getDate())} ${d.getFullYear()}`;
  if (format === 'date') return date;
  return `${date}  ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
