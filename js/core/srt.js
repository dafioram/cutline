// SubRip (.srt) parsing and writing.

function parseStamp(s) {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/.exec(s.trim());
  if (!m) return NaN;
  const ms = Number(m[4].padEnd(3, '0'));
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + ms / 1000;
}

/** Returns [{start, end, text}] sorted by start. Tolerates BOMs, CRLF, missing cue numbers and simple tags. */
export function parseSRT(input) {
  const text = String(input).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks = text.split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l, i, arr) => !(l.trim() === '' && (i === 0 || i === arr.length - 1)));
    if (!lines.length) continue;
    let i = 0;
    if (!lines[0].includes('-->') && lines.length > 1) i = 1;
    const timing = lines[i];
    if (!timing || !timing.includes('-->')) continue;
    const [a, b] = timing.split('-->');
    const start = parseStamp(a);
    const end = parseStamp(b.trim().split(/\s+/)[0]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const body = lines
      .slice(i + 1)
      .join('\n')
      .replace(/<\/?[^>]+>/g, '')
      .replace(/\{\\[^}]*\}/g, '')
      .trim();
    cues.push({ start, end, text: body });
  }
  return cues.sort((x, y) => x.start - y.start);
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

function stamp(t) {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

export function writeSRT(cues) {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n');
}

export function cueAt(cues, t) {
  for (const c of cues) if (t >= c.start && t < c.end) return c;
  return null;
}
