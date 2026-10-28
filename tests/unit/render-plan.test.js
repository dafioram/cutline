import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createMedia, createVideoClip, createImageClip, createOverlay } from '../../js/core/model.js';
import { appendClip, addClip, setTransition } from '../../js/core/timeline.js';
import { planFrame, transitionAt } from '../../js/core/render-plan.js';

function setup() {
  const p = createProject();
  const v = createMedia({ name: 'v.mp4', kind: 'video', duration: 20, hasAudio: true });
  const img = createMedia({ name: 'i.png', kind: 'image' });
  p.media[v.id] = v;
  p.media[img.id] = img;
  const a = appendClip(p, createVideoClip(v, { inPoint: 2, outPoint: 6 })); // 0-4, source 2-6
  const b = appendClip(p, createImageClip(img, { duration: 4, fades: false })); // 4-8
  return { p, a, b };
}

test('plain playback maps movie time to source time', () => {
  const { p, a } = setup();
  const f = planFrame(p, 1.5);
  assert.equal(f.layers.length, 1);
  assert.equal(f.layers[0].clip.id, a.id);
  assert.equal(f.layers[0].sourceTime, 3.5);
  assert.equal(f.layers[0].alpha, 1);
  assert.equal(planFrame(p, 9).layers.length, 0);
});

test('cross-fade blends both clips around the seam', () => {
  const { p, a, b } = setup();
  setTransition(p, b.id, 'crossfade', 1);
  assert.equal(transitionAt(p, 3.4), null);
  const f = planFrame(p, 4);
  assert.equal(f.layers.length, 2);
  assert.equal(f.layers[0].clip.id, a.id);
  assert.equal(f.layers[1].clip.id, b.id);
  assert.equal(f.layers[1].alpha, 0.5);
  // Clip A continues its source past its own end during the overlap.
  assert.equal(f.layers[0].sourceTime, 6);
});

test('fade through black hands over at the seam', () => {
  const { p, a, b } = setup();
  setTransition(p, b.id, 'fadeblack', 2);
  const before = planFrame(p, 3.5);
  assert.equal(before.layers.length, 1);
  assert.equal(before.layers[0].clip.id, a.id);
  assert.equal(before.layers[0].alpha, 0.5);
  const after = planFrame(p, 4.5);
  assert.equal(after.layers[0].clip.id, b.id);
  assert.equal(after.layers[0].alpha, 0.5);
});

test('wipe reveals the next clip progressively', () => {
  const { p, b } = setup();
  setTransition(p, b.id, 'wipe', 1);
  const f = planFrame(p, 4.25);
  assert.equal(f.layers[1].wipe, 0.75);
});

test('overlays are ordered by lane with opacity and fades applied', () => {
  const { p } = setup();
  const clock = addClip(p, createOverlay('clock'));
  const text = addClip(p, createOverlay('text', { start: 1, duration: 2 }));
  text.fadeIn = 1;
  const f = planFrame(p, 1.5);
  assert.deepEqual(
    f.overlays.map((o) => o.clip.id),
    [clock.id, text.id],
  );
  assert.equal(f.overlays[1].alpha, 0.5);
  assert.equal(f.overlays[0].localTime, 1.5);
});
