import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProject,
  createMedia,
  createVideoClip,
  createImageClip,
  createAudioClip,
  createOverlay,
  createMarker,
} from '../../js/core/model.js';
import {
  addClip,
  appendClip,
  moveClips,
  trimClip,
  splitClip,
  deleteClips,
  insertAt,
  seams,
  setTransition,
  movieDuration,
  effectiveRange,
  snapTargets,
  snapOffset,
  bringToFront,
  sendToBack,
  reorderVideo,
  trackClips,
  markerRangeAround,
  addMarker,
  rangeOf,
} from '../../js/core/timeline.js';

function setup() {
  const p = createProject();
  const m = createMedia({ name: 'a.mp4', kind: 'video', duration: 10, hasAudio: true });
  const img = createMedia({ name: 'b.png', kind: 'image' });
  const song = createMedia({ name: 'song.mp3', kind: 'audio', duration: 120 });
  p.media[m.id] = m;
  p.media[img.id] = img;
  p.media[song.id] = song;
  return { p, m, img, song };
}

const starts = (p, track = 'video') => trackClips(p, track).map((c) => +c.start.toFixed(3));

test('appending clips lays them back to back', () => {
  const { p, m, img } = setup();
  appendClip(p, createVideoClip(m));
  appendClip(p, createImageClip(img));
  appendClip(p, createVideoClip(m, { inPoint: 2, outPoint: 6 }));
  assert.deepEqual(starts(p), [0, 10, 15]);
  assert.equal(movieDuration(p), 19);
});

test('dropping inside a clip moves to its nearer edge and pushes later clips right', () => {
  const { p, m, img } = setup();
  const a = appendClip(p, createVideoClip(m)); // 0-10
  const b = appendClip(p, createVideoClip(m)); // 10-20
  const c = addClip(p, createImageClip(img, { start: 3 })); // inside a, nearer start -> 0
  assert.equal(c.start, 0);
  assert.equal(a.start, 5);
  assert.equal(b.start, 15);
  const d = addClip(p, createImageClip(img, { start: 13 })); // inside a (5-15), nearer end -> 15
  assert.equal(d.start, 15);
  assert.equal(b.start, 20);
});

test('moving a clip keeps gaps elsewhere and does not overlap', () => {
  const { p, m } = setup();
  const a = appendClip(p, createVideoClip(m, { outPoint: 4 })); // 0-4
  const b = appendClip(p, createVideoClip(m, { outPoint: 4 })); // 4-8
  const c = appendClip(p, createVideoClip(m, { outPoint: 4 })); // 8-12
  moveClips(p, [c.id], -7); // lands at 1, inside a -> nearer start 0
  assert.equal(c.start, 0);
  assert.equal(a.start, 4);
  assert.equal(b.start, 8);
  moveClips(p, [a.id], -100); // clamped to 0, block goes to 0 and pushes
  assert.equal(a.start, 0);
  const all = trackClips(p, 'video');
  for (let i = 1; i < all.length; i++) assert.ok(all[i].start >= all[i - 1].start + all[i - 1].duration - 1e-9);
});

test('trimming respects media length and neighbours', () => {
  const { p, m } = setup();
  const a = appendClip(p, createVideoClip(m, { inPoint: 2, outPoint: 6 })); // 0-4, in 2
  const b = appendClip(p, createVideoClip(m, { outPoint: 3 })); // 4-7
  trimClip(p, a.id, 'end', 100, m.duration); // limited by neighbour at 4
  assert.equal(a.duration, 4);
  trimClip(p, b.id, 'start', 2, m.duration); // limited by a's end and b.in = 0
  assert.equal(b.start, 4);
  trimClip(p, a.id, 'start', -5, m.duration); // can reveal 2s of earlier media but not before 0
  assert.equal(a.start, 0);
  assert.equal(a.in, 2);
  trimClip(p, a.id, 'start', 1.5, m.duration);
  assert.equal(a.start, 1.5);
  assert.equal(a.in, 3.5);
  assert.equal(a.duration, 2.5);
});

test('splitting creates two clips with continuous source time', () => {
  const { p, m } = setup();
  const a = appendClip(p, createVideoClip(m, { inPoint: 1 }));
  a.fadeIn = 1;
  a.fadeOut = 1;
  const right = splitClip(p, a.id, 4);
  assert.ok(right);
  assert.equal(a.duration, 4);
  assert.equal(right.start, 4);
  assert.equal(right.in, 5);
  assert.equal(right.duration, 5);
  assert.equal(a.fadeOut, 0);
  assert.equal(right.fadeIn, 0);
  assert.equal(right.fadeOut, 1);
  assert.equal(splitClip(p, a.id, 0.01), null);
});

test('deleting closes the gap by default and can leave it', () => {
  const { p, m } = setup();
  const a = appendClip(p, createVideoClip(m, { outPoint: 3 }));
  const b = appendClip(p, createVideoClip(m, { outPoint: 3 }));
  const c = appendClip(p, createVideoClip(m, { outPoint: 3 }));
  deleteClips(p, [b.id]);
  assert.deepEqual(starts(p), [0, 3]);
  assert.equal(c.start, 3);
  deleteClips(p, [a.id], { ripple: false });
  assert.deepEqual(starts(p), [3]);
});

test('insertAt splits the clip under the playhead and pushes the rest', () => {
  const { p, m, img } = setup();
  appendClip(p, createVideoClip(m)); // 0-10
  const freeze = createImageClip(img, { duration: 3, fades: false });
  insertAt(p, freeze, 4);
  assert.deepEqual(starts(p), [0, 4, 7]);
  assert.equal(movieDuration(p), 13);
});

test('transitions only sit on touching clips and are clamped', () => {
  const { p, m, img } = setup();
  appendClip(p, createVideoClip(m, { outPoint: 2 }));
  const b = appendClip(p, createImageClip(img, { duration: 0.5 }));
  assert.equal(seams(p).length, 1);
  assert.ok(setTransition(p, b.id, 'crossfade', 5));
  assert.equal(b.transition.duration, 0.5);
  assert.equal(b.fadeIn, 0, 'a transition replaces the photo fade at the seam');
  assert.equal(b.fadeOut, 1, 'the far edge keeps its fade');
  const c = addClip(p, createImageClip(img, { start: 10 }));
  assert.equal(setTransition(p, c.id, 'wipe'), false);
});

test('whole-movie overlays stretch to the movie length', () => {
  const { p, m } = setup();
  appendClip(p, createVideoClip(m));
  const clock = addClip(p, createOverlay('clock'));
  assert.deepEqual(effectiveRange(p, clock), [0, 10]);
  appendClip(p, createVideoClip(m));
  assert.deepEqual(effectiveRange(p, clock), [0, 20]);
  assert.equal(movieDuration(p), 20);
});

test('overlapping overlays get their own lanes; bring to front / send to back reorder them', () => {
  const { p, m } = setup();
  appendClip(p, createVideoClip(m));
  const clock = addClip(p, createOverlay('clock'));
  const text = addClip(p, createOverlay('text', { start: 2, duration: 3 }));
  const shape = addClip(p, createOverlay('shape', { start: 8, duration: 1 }));
  assert.equal(clock.lane, 0);
  assert.equal(text.lane, 1);
  assert.equal(shape.lane, 1); // no overlap with text, so it reuses lane 1
  sendToBack(p, text.id);
  assert.ok(text.lane < clock.lane);
  bringToFront(p, text.id);
  assert.ok(text.lane > clock.lane);
});

test('snapping picks the closest target within the threshold', () => {
  const { p, m } = setup();
  const a = appendClip(p, createVideoClip(m, { outPoint: 4 }));
  addMarker(p, createMarker(7));
  const targets = snapTargets(p, { excludeIds: [], playhead: 5.5 });
  assert.equal(snapOffset(targets, [4.1], 0.3).offset.toFixed(2), '-0.10');
  assert.equal(snapOffset(targets, [6.9], 0.3).target.kind, 'marker');
  assert.equal(snapOffset(targets, [5.45], 0.3).target.kind, 'playhead');
  assert.equal(snapOffset(targets, [9], 0.3).offset, 0);
  assert.ok(a);
});

test('storyboard reorder packs clips back to back', () => {
  const { p, m, img } = setup();
  const a = appendClip(p, createVideoClip(m, { outPoint: 2 }));
  const b = addClip(p, createImageClip(img, { start: 10 }));
  reorderVideo(p, [b.id, a.id]);
  assert.equal(b.start, 0);
  assert.equal(a.start, 5);
});

test('music clips push each other but not video clips', () => {
  const { p, m, song } = setup();
  appendClip(p, createVideoClip(m));
  const s1 = appendClip(p, createAudioClip(song, { outPoint: 5 }));
  const s2 = addClip(p, createAudioClip(song, { start: 1, outPoint: 5 }));
  assert.equal(s2.start, 0);
  assert.equal(s1.start, 5);
  assert.deepEqual(starts(p, 'video'), [0]);
});

test('marker ranges and selection ranges', () => {
  const { p, m } = setup();
  const a = appendClip(p, createVideoClip(m, { outPoint: 4 }));
  const b = appendClip(p, createVideoClip(m, { outPoint: 4 }));
  addMarker(p, createMarker(1));
  addMarker(p, createMarker(3));
  addMarker(p, createMarker(6));
  assert.deepEqual(markerRangeAround(p, 4), [3, 6]);
  assert.deepEqual(markerRangeAround(p, 0), [1, 3]);
  assert.deepEqual(rangeOf(p, [a.id, b.id]), [0, 8]);
});
