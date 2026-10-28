import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSRT, writeSRT, cueAt } from '../../js/core/srt.js';
import { soundIntervals, duckPoints, envelopeAt, fadeGainAt, fadePoints, multiplyEnvelopes, normalizeGain, rmsOf } from '../../js/core/audioenv.js';
import { pickWidth, nextWidth, estimateGifBytes, isLegible, frameDelays, GIF_TARGET, gifSize } from '../../js/core/gifplan.js';
import { histogram, histDistance, detectCuts, scenesFromCuts, sampleInterval } from '../../js/core/scenes.js';
import { readMp4CreationTime, formatStamp } from '../../js/core/mp4meta.js';
import { History } from '../../js/core/history.js';
import { cornerCenter, overlayBox, overlappingIndices, nearestCorner } from '../../js/core/overlays.js';
import { detectKind, imageConverter, extensionOf } from '../../js/core/formats.js';
import { createProject, createMedia, createVideoClip, createOverlay } from '../../js/core/model.js';
import { appendClip, addClip } from '../../js/core/timeline.js';

test('SRT parsing handles BOM, CRLF, tags and missing numbers', () => {
  const src = '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Hello</i>\r\nthere\r\n\r\n00:00:03.000 --> 00:00:04.000 X1:0\r\nSecond\r\n\r\nbad block\r\n';
  const cues = parseSRT(src);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 1, end: 2.5, text: 'Hello\nthere' });
  assert.equal(cues[1].text, 'Second');
  assert.equal(cueAt(cues, 1.2).text, 'Hello\nthere');
  assert.equal(cueAt(cues, 2.6), null);
  const round = parseSRT(writeSRT(cues));
  assert.deepEqual(round, cues);
});

test('music dims under video sound with half-second ramps', () => {
  const p = createProject();
  const loud = createMedia({ name: 'v.mp4', kind: 'video', duration: 10, hasAudio: true });
  const silent = createMedia({ name: 's.mp4', kind: 'video', duration: 10, hasAudio: false });
  p.media[loud.id] = loud;
  p.media[silent.id] = silent;
  appendClip(p, createVideoClip(silent, { outPoint: 4 })); // 0-4
  appendClip(p, createVideoClip(loud, { outPoint: 4 })); // 4-8
  const muted = appendClip(p, createVideoClip(loud, { outPoint: 4 })); // 8-12
  muted.muted = true;
  const iv = soundIntervals(p);
  assert.deepEqual(iv, [[4, 8]]);
  const pts = duckPoints(iv, 0.25);
  assert.equal(envelopeAt(pts, 2), 1);
  assert.equal(envelopeAt(pts, 4), 1);
  assert.equal(envelopeAt(pts, 4.25), 0.625);
  assert.equal(envelopeAt(pts, 6), 0.25);
  assert.equal(envelopeAt(pts, 8.25), 0.625);
  assert.equal(envelopeAt(pts, 9), 1);
});

test('close sound intervals merge so music does not pump', () => {
  const p = createProject();
  const loud = createMedia({ name: 'v.mp4', kind: 'video', duration: 10, hasAudio: true });
  p.media[loud.id] = loud;
  appendClip(p, createVideoClip(loud, { outPoint: 2 }));
  const b = appendClip(p, createVideoClip(loud, { outPoint: 2 }));
  b.start = 2.6;
  assert.deepEqual(soundIntervals(p), [[0, 4.6]]);
});

test('fades and envelope maths', () => {
  const clip = { start: 10, duration: 4, fadeIn: 1, fadeOut: 2 };
  assert.equal(fadeGainAt(clip, 10), 0);
  assert.equal(fadeGainAt(clip, 10.5), 0.5);
  assert.equal(fadeGainAt(clip, 11.5), 1);
  assert.equal(fadeGainAt(clip, 13), 0.5);
  const fp = fadePoints(clip);
  assert.equal(envelopeAt(fp, 10.5), 0.5);
  assert.equal(envelopeAt(fp, 13), 0.5);
  const product = multiplyEnvelopes(fp, [{ t: 0, v: 0.5 }]);
  assert.equal(envelopeAt(product, 12), 0.5);
  assert.equal(normalizeGain(0.05), 2);
  assert.equal(normalizeGain(0.001), 4);
  assert.equal(normalizeGain(0), 1);
  assert.ok(Math.abs(rmsOf([new Float32Array([0.5, -0.5, 0.5, -0.5])], 0, Infinity, 1) - 0.5) < 1e-9);
});

test('GIF planning steps width down to fit 10 MB', () => {
  const sample = { width: 480, bytesPerFrame: 60000 };
  const frames = 120;
  const est = (w) => estimateGifBytes(sample, w, frames);
  const w = pickWidth(est);
  assert.ok(est(w) <= GIF_TARGET);
  assert.ok(w === 640 || w === 480, String(w));
  assert.equal(nextWidth(800), 640);
  assert.equal(nextWidth(240), null);
  assert.equal(nextWidth(500), 480);
  assert.equal(pickWidth(() => Infinity), null);
  assert.ok(isLegible(480));
  assert.ok(!isLegible(360));
  assert.deepEqual(gifSize(480, 16 / 9), { width: 480, height: 270 });
});

test('GIF frame delays stay accurate over time', () => {
  const d = frameDelays(12, 12);
  assert.equal(d.reduce((a, b) => a + b, 0), 100);
  const d15 = frameDelays(15, 15);
  assert.equal(d15.reduce((a, b) => a + b, 0), 100);
});

function solid(r, g, b, n = 64) {
  const a = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) a.set([r, g, b, 255], i * 4);
  return a;
}

test('scene detection finds hard cuts but not small changes', () => {
  const red = histogram(solid(220, 20, 20));
  const red2 = histogram(solid(210, 25, 25));
  const blue = histogram(solid(20, 20, 220));
  assert.ok(histDistance(red, red2) < 0.1);
  assert.ok(histDistance(red, blue) > 0.6);
  const samples = [];
  for (let i = 0; i < 20; i++) samples.push({ t: i * 0.5, hist: i < 10 ? (i % 2 ? red : red2) : blue });
  const cuts = detectCuts(samples);
  assert.deepEqual(cuts, [5]);
  assert.deepEqual(scenesFromCuts(cuts, 10), [
    { start: 0, end: 5 },
    { start: 5, end: 10 },
  ]);
  assert.equal(sampleInterval(60), 0.5);
  assert.equal(sampleInterval(3600), 3);
});

function box(type, payload) {
  const size = 8 + payload.length;
  const b = new Uint8Array(size);
  new DataView(b.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
  b.set(payload, 8);
  return b;
}

test('reads the recording date from an MP4 movie header', async () => {
  const when = Date.UTC(2024, 5, 1, 12, 30, 0);
  const macSecs = when / 1000 + 2082844800;
  const mvhd = new Uint8Array(100);
  new DataView(mvhd.buffer).setUint32(4, macSecs);
  const moov = box('moov', box('mvhd', mvhd));
  const file = new Uint8Array([...box('ftyp', new Uint8Array(8)), ...box('mdat', new Uint8Array(50)), ...moov]);
  const readAt = async (o, l) => file.slice(o, o + l);
  assert.equal(await readMp4CreationTime(readAt, file.length), when);
  const noDate = new Uint8Array([...box('ftyp', new Uint8Array(8)), ...box('moov', box('mvhd', new Uint8Array(100)))]);
  assert.equal(await readMp4CreationTime(async (o, l) => noDate.slice(o, o + l), noDate.length), null);
  assert.equal(await readMp4CreationTime(async () => new Uint8Array(0), 0), null);
  assert.match(formatStamp(when, 'date'), /^[A-Z]{3} \d\d 2024$/);
});

test('undo and redo walk snapshots in order', () => {
  const h = new History({ limit: 3 });
  h.push('s0', 'a');
  h.push('s1', 'b');
  assert.equal(h.undo('s2').json, 's1');
  assert.equal(h.redo('s1').json, 's2');
  h.push('s2', 'c');
  h.push('s3', 'd');
  assert.equal(h.undoStack.length, 3);
  assert.ok(!h.canRedo());
});

test('overlay corners, boxes and overlap flags', () => {
  const W = 1920;
  const H = 1080;
  const c = cornerCenter('br', 200, 60, W, H);
  assert.ok(c.x + 100 < W && c.y + 30 < H);
  const o = { corner: 'tl' };
  const b = overlayBox(o, 200, 60, W, H);
  assert.ok(b.x > 0 && b.y > 0);
  assert.deepEqual(overlappingIndices([b, { ...b, x: b.x + 10 }, { x: 1500, y: 900, w: 10, h: 10 }]), [0, 1]);
  assert.equal(nearestCorner(100, 1000, W, H), 'bl');
});

test('file kinds by extension and mime', () => {
  assert.equal(detectKind('clip.MOV'), 'video');
  assert.equal(detectKind('photo.heic'), 'image');
  assert.equal(detectKind('song.flac'), 'audio');
  assert.equal(detectKind('subs.srt'), 'subtitles');
  assert.equal(detectKind('x.bin', 'video/x-unknown'), 'video');
  assert.equal(detectKind('x.bin'), null);
  assert.equal(imageConverter('IMG_1.HEIC'), 'heic');
  assert.equal(imageConverter('a.tiff'), 'ffmpeg');
  assert.equal(imageConverter('a.png'), null);
  assert.equal(extensionOf('a.b.WebM'), 'webm');
});

test('model: overlay defaults use different corners', () => {
  const corners = ['clock', 'image', 'part', 'date'].map((k) => createOverlay(k).corner);
  assert.equal(new Set(corners).size, 4);
  const p = createProject();
  const clock = addClip(p, createOverlay('clock'));
  assert.equal(clock.props.startAt, 0);
});
