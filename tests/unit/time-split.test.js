import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatHMS, formatTimecode, parseTime, partFileName, formatRuler, safeBaseName } from '../../js/core/time.js';
import { computeParts, splitLines, partIndexAt, resolveOutputSize, videoBitrate, estimateBytes, formatBytes } from '../../js/core/split.js';

test('running clock uses H:MM:SS and starts at 0', () => {
  assert.equal(formatHMS(0), '0:00:00');
  assert.equal(formatHMS(0.99), '0:00:00');
  assert.equal(formatHMS(1), '0:00:01');
  assert.equal(formatHMS(30), '0:00:30');
  assert.equal(formatHMS(3599.5), '0:59:59');
  assert.equal(formatHMS(3600), '1:00:00');
  assert.equal(formatHMS(36125), '10:02:05');
});

test('timecode and ruler formats', () => {
  assert.equal(formatTimecode(83.56), '1:23.5');
  assert.equal(formatTimecode(3723.2), '1:02:03.2');
  assert.equal(formatRuler(65), '1:05');
  assert.equal(formatRuler(3725), '1:02:05');
});

test('parseTime accepts seconds, M:SS and H:MM:SS', () => {
  assert.equal(parseTime('83.5'), 83.5);
  assert.equal(parseTime('1:23.5'), 83.5);
  assert.equal(parseTime('0:01:23'), 83);
  assert.equal(parseTime('1:02:03.25'), 3723.25);
  assert.ok(Number.isNaN(parseTime('abc')));
  assert.ok(Number.isNaN(parseTime('1::2')));
  assert.ok(Number.isNaN(parseTime('')));
});

test('parts are fixed length with a shorter last part', () => {
  assert.deepEqual(
    computeParts(95, 30).map((p) => [p.start, p.end]),
    [
      [0, 30],
      [30, 60],
      [60, 90],
      [90, 95],
    ],
  );
  assert.equal(computeParts(90, 30).length, 3);
  assert.equal(computeParts(10, 30).length, 1);
  assert.equal(computeParts(0, 30).length, 0);
  // A sliver shorter than one frame folds into the previous part.
  const p = computeParts(60.01, 30, 30);
  assert.equal(p.length, 2);
  assert.equal(p[1].end, 60.01);
});

test('split lines and part lookup', () => {
  assert.deepEqual(splitLines(95, 30), [30, 60, 90]);
  assert.equal(partIndexAt(29.9, 30, 95), 0);
  assert.equal(partIndexAt(30, 30, 95), 1);
  assert.equal(partIndexAt(94, 30, 95), 3);
});

test('part file names include the time range', () => {
  assert.equal(partFileName('movie', 1, 6, 30, 60, 'mp4', 170), 'movie_part02_0030-0100.mp4');
  assert.equal(partFileName('My Trip!', 0, 120, 0, 30, 'webm', 3600 * 2), 'my_trip_part001_000000-000030.webm');
  assert.equal(safeBaseName('  '), 'movie');
});

test('output size: same as source, presets keep aspect and even numbers', () => {
  assert.deepEqual(resolveOutputSize('source', 1280, 720), { width: 1280, height: 720 });
  assert.deepEqual(resolveOutputSize('1080', 1280, 720), { width: 1920, height: 1080 });
  assert.deepEqual(resolveOutputSize('720', 1080, 1920), { width: 406, height: 720 });
  assert.deepEqual(resolveOutputSize('source', 0, 0), { width: 1920, height: 1080 });
  assert.deepEqual(resolveOutputSize('source', 641, 361), { width: 642, height: 362 });
});

test('bitrate and size estimates are sane', () => {
  const b = videoBitrate(1920, 1080, 30, 'standard');
  assert.ok(b > 3e6 && b < 8e6, String(b));
  assert.ok(videoBitrate(1920, 1080, 30, 'high') > b);
  const bytes = estimateBytes(30, 4e6);
  assert.ok(bytes > 15e6 && bytes < 17e6);
  assert.equal(formatBytes(1536), '2 KB');
  assert.equal(formatBytes(10 * 1024 * 1024), '10.0 MB');
});
