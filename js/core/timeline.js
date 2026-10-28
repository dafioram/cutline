// Timeline operations. All functions mutate the project passed in; callers snapshot it first for undo.

import { DEFAULTS } from './model.js';
import { EPS, clamp, near, round, uid } from './util.js';

export const clipEnd = (c) => c.start + c.duration;

export function trackClips(project, track) {
  return project.clips.filter((c) => c.track === track).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

export function getClip(project, id) {
  return project.clips.find((c) => c.id === id) || null;
}

/** Length of the movie: the furthest end of anything except whole-movie overlays. */
export function movieDuration(project) {
  let end = 0;
  for (const c of project.clips) {
    if (c.track === 'overlay' && c.spanAll) continue;
    end = Math.max(end, clipEnd(c));
  }
  return round(end);
}

/** Start/end an item actually occupies (whole-movie overlays stretch to the movie length). */
export function effectiveRange(project, c) {
  if (c.track === 'overlay' && c.spanAll) return [0, Math.max(movieDuration(project), 0)];
  return [c.start, clipEnd(c)];
}

export function clipsAt(project, t, track) {
  return project.clips.filter((c) => {
    if (track && c.track !== track) return false;
    const [s, e] = effectiveRange(project, c);
    return t >= s - EPS && t < e - EPS;
  });
}

/** Candidate snap targets: start of timeline, every clip edge, the playhead and markers. */
export function snapTargets(project, { excludeIds = [], playhead = null } = {}) {
  const ex = new Set(excludeIds);
  const targets = [{ time: 0, kind: 'start' }];
  for (const c of project.clips) {
    if (ex.has(c.id)) continue;
    if (c.track === 'overlay' && c.spanAll) continue;
    targets.push({ time: c.start, kind: 'edge' }, { time: clipEnd(c), kind: 'edge' });
  }
  for (const m of project.markers) targets.push({ time: m.time, kind: 'marker' });
  if (playhead != null) targets.push({ time: playhead, kind: 'playhead' });
  return targets;
}

/**
 * Snap one or more candidate times (e.g. a block's start and end) to the nearest target.
 * Returns the offset to apply and the target used, or offset 0 when nothing is within `threshold` seconds.
 */
export function snapOffset(targets, times, threshold) {
  let best = null;
  for (const t of times) {
    for (const tg of targets) {
      const d = tg.time - t;
      if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best.offset))) {
        best = { offset: d, target: tg };
      }
    }
  }
  return best || { offset: 0, target: null };
}

/** If `t` lands inside a clip on `track`, return the nearer edge of that clip, else `t`. */
export function resolveInsertPoint(project, track, t, excludeIds = []) {
  const ex = new Set(excludeIds);
  for (const c of trackClips(project, track)) {
    if (ex.has(c.id)) continue;
    if (t > c.start + EPS && t < clipEnd(c) - EPS) {
      return t - c.start < c.duration / 2 ? c.start : clipEnd(c);
    }
  }
  return t;
}

/**
 * Settle a block of clips that was just placed on the video or music track:
 * a block dropped inside a clip moves to that clip's nearer edge, then later clips are pushed right.
 */
export function placeBlock(project, track, blockIds) {
  const ids = new Set(blockIds);
  const block = project.clips.filter((c) => ids.has(c.id) && c.track === track);
  if (!block.length) return;
  let bStart = Math.min(...block.map((c) => c.start));
  const ins = resolveInsertPoint(project, track, bStart, blockIds);
  const shiftBlock = ins - bStart;
  if (Math.abs(shiftBlock) > EPS) for (const c of block) c.start = round(c.start + shiftBlock);
  bStart = Math.min(...block.map((c) => c.start));
  const bEnd = Math.max(...block.map(clipEnd));
  const others = trackClips(project, track).filter((c) => !ids.has(c.id) && c.start >= bStart - EPS);
  if (!others.length) return;
  const push = bEnd - others[0].start;
  if (push > EPS) for (const c of others) c.start = round(c.start + push);
}

/** Overlays: stacking lanes. Keep the requested lane if free, else move up to the first free lane. */
export function assignLane(project, clip) {
  const [s, e] = effectiveRange(project, clip);
  const busy = (lane) =>
    project.clips.some((o) => {
      if (o === clip || o.track !== 'overlay' || o.lane !== lane) return false;
      const [os, oe] = effectiveRange(project, o);
      return os < e - EPS && oe > s + EPS;
    });
  let lane = Math.max(0, clip.lane | 0);
  while (busy(lane)) lane++;
  clip.lane = lane;
}

/** Renumber lanes 0..n-1 preserving order, so empty lanes disappear. */
export function normalizeLanes(project) {
  const overlays = project.clips.filter((c) => c.track === 'overlay');
  const lanes = [...new Set(overlays.map((c) => c.lane))].sort((a, b) => a - b);
  const map = new Map(lanes.map((l, i) => [l, i]));
  for (const c of overlays) c.lane = map.get(c.lane);
}

export function laneCount(project) {
  const overlays = project.clips.filter((c) => c.track === 'overlay');
  return overlays.length ? Math.max(...overlays.map((c) => c.lane)) + 1 : 1;
}

function overlappingOverlays(project, clip) {
  const [s, e] = effectiveRange(project, clip);
  return project.clips.filter((o) => {
    if (o === clip || o.track !== 'overlay') return false;
    const [os, oe] = effectiveRange(project, o);
    return os < e - EPS && oe > s + EPS;
  });
}

export function bringToFront(project, id) {
  const c = getClip(project, id);
  if (!c || c.track !== 'overlay') return;
  const ov = overlappingOverlays(project, c);
  if (!ov.length) return;
  const top = Math.max(...ov.map((o) => o.lane));
  if (c.lane > top) return;
  c.lane = top + 1;
  normalizeLanes(project);
}

export function sendToBack(project, id) {
  const c = getClip(project, id);
  if (!c || c.track !== 'overlay') return;
  const ov = overlappingOverlays(project, c);
  if (!ov.length) return;
  const bottom = Math.min(...ov.map((o) => o.lane));
  if (c.lane < bottom) return;
  c.lane = bottom - 1;
  normalizeLanes(project);
}

/** Add a clip at its own start time on its track, pushing later clips if needed. */
export function addClip(project, clip) {
  project.clips.push(clip);
  if (clip.track === 'overlay') {
    assignLane(project, clip);
    normalizeLanes(project);
  } else {
    clip.start = Math.max(0, clip.start);
    placeBlock(project, clip.track, [clip.id]);
  }
  return clip;
}

export function trackEnd(project, track) {
  const cs = trackClips(project, track);
  return cs.length ? Math.max(...cs.map(clipEnd)) : 0;
}

export function appendClip(project, clip) {
  clip.start = trackEnd(project, clip.track);
  project.clips.push(clip);
  if (clip.track === 'overlay') {
    assignLane(project, clip);
    normalizeLanes(project);
  }
  return clip;
}

/**
 * Move clips by `delta` seconds. Overlays may also change lane by `laneDelta`.
 * Video/music clips are settled as a block per track (drop-inside rule, then push later clips).
 */
export function moveClips(project, ids, delta, { laneDelta = 0 } = {}) {
  const sel = project.clips.filter((c) => ids.includes(c.id));
  if (!sel.length) return;
  const movable = sel.filter((c) => !(c.track === 'overlay' && c.spanAll));
  const minStart = movable.length ? Math.min(...movable.map((c) => c.start)) : 0;
  const d = Math.max(delta, -minStart);
  for (const c of movable) c.start = round(c.start + d);
  for (const track of ['video', 'music']) {
    const blockIds = sel.filter((c) => c.track === track).map((c) => c.id);
    if (blockIds.length) placeBlock(project, track, blockIds);
  }
  const overlays = sel.filter((c) => c.track === 'overlay');
  if (overlays.length) {
    // Lift the moving overlays out first so they don't block each other.
    for (const o of overlays) o.lane = Math.max(0, o.lane + laneDelta);
    const order = [...overlays].sort((a, b) => a.lane - b.lane);
    for (const o of order) assignLane(project, o);
    normalizeLanes(project);
  }
}

function neighbors(project, clip) {
  const cs = trackClips(project, clip.track).filter((c) => c.id !== clip.id);
  let prev = null;
  let next = null;
  for (const c of cs) {
    if (clipEnd(c) <= clip.start + EPS) prev = c;
    else if (c.start >= clipEnd(clip) - EPS && !next) next = c;
  }
  return { prev, next };
}

/**
 * Drag a clip edge. `mediaDuration` limits how far media-backed clips can extend.
 * Video/music clips stop at their neighbours; overlays re-stack if they now overlap.
 */
export function trimClip(project, id, edge, time, mediaDuration = Infinity) {
  const c = getClip(project, id);
  if (!c) return;
  const min = DEFAULTS.minClip;
  const hasSource = c.type === 'video' || c.type === 'audio';
  if (c.track === 'overlay' && c.spanAll) {
    const [s, e] = effectiveRange(project, c);
    c.spanAll = false;
    c.start = s;
    c.duration = Math.max(min, e - s);
  }
  const lanes = c.track !== 'overlay';
  const { prev, next } = lanes ? neighbors(project, c) : { prev: null, next: null };
  const end = clipEnd(c);
  if (edge === 'start') {
    let lo = prev ? clipEnd(prev) : 0;
    if (hasSource) lo = Math.max(lo, c.start - c.in);
    const t = clamp(time, lo, end - min);
    if (hasSource) c.in = round(c.in + (t - c.start));
    c.duration = round(end - t);
    c.start = round(t);
  } else {
    let hi = next ? next.start : Infinity;
    if (hasSource) hi = Math.min(hi, c.start + (mediaDuration - c.in));
    const t = clamp(time, c.start + min, hi);
    c.duration = round(t - c.start);
  }
  c.fadeIn = Math.min(c.fadeIn, c.duration);
  c.fadeOut = Math.min(c.fadeOut, c.duration);
  if (c.track === 'overlay') {
    assignLane(project, c);
    normalizeLanes(project);
  }
}

/** Split a clip at time t. Returns the new right-hand clip, or null if t isn't inside it. */
export function splitClip(project, id, t) {
  const c = getClip(project, id);
  if (!c) return null;
  if (c.track === 'overlay' && c.spanAll) {
    const [s, e] = effectiveRange(project, c);
    c.spanAll = false;
    c.start = s;
    c.duration = e - s;
  }
  const min = 0.05;
  if (t <= c.start + min || t >= clipEnd(c) - min) return null;
  const left = round(t - c.start);
  const right = JSON.parse(JSON.stringify(c));
  right.id = uid('c');
  right.start = round(t);
  right.duration = round(c.duration - left);
  if ('in' in c) right.in = round(c.in + left);
  right.fadeIn = 0;
  right.transition = null;
  if (c.track === 'overlay' && c.kind === 'subtitles') {
    // Subtitle cues are relative to the overlay start; keep each half's cues.
    right.props.cues = c.props.cues
      .filter((q) => q.end > left)
      .map((q) => ({ ...q, start: Math.max(0, q.start - left), end: q.end - left }));
    c.props.cues = c.props.cues.filter((q) => q.start < left).map((q) => ({ ...q, end: Math.min(q.end, left) }));
  }
  c.duration = left;
  c.fadeOut = 0;
  project.clips.push(right);
  if (c.track === 'overlay') {
    right.lane = c.lane;
    normalizeLanes(project);
  }
  return right;
}

/** Delete clips. With ripple, later clips on the same video/music track slide left to close the gap. */
export function deleteClips(project, ids, { ripple = true } = {}) {
  const del = project.clips.filter((c) => ids.includes(c.id)).sort((a, b) => b.start - a.start);
  for (const c of del) {
    project.clips = project.clips.filter((x) => x.id !== c.id);
    if (ripple && c.track !== 'overlay') {
      for (const o of project.clips) {
        if (o.track === c.track && o.start >= clipEnd(c) - EPS) o.start = round(o.start - c.duration);
      }
    }
  }
  normalizeLanes(project);
}

/**
 * Insert a clip at time t on its track: splits a clip under t if needed, then pushes everything at or
 * after t right by the new clip's length. Used for freeze frames and storyboard inserts.
 */
export function insertAt(project, clip, t) {
  const under = trackClips(project, clip.track).find((c) => t > c.start + EPS && t < clipEnd(c) - EPS);
  if (under) splitClip(project, under.id, t);
  for (const o of project.clips) {
    if (o.track === clip.track && o.start >= t - EPS) o.start = round(o.start + clip.duration);
  }
  clip.start = round(t);
  project.clips.push(clip);
  return clip;
}

/** Points where two video-track clips touch; transitions live on these seams. */
export function seams(project) {
  const cs = trackClips(project, 'video');
  const out = [];
  for (let i = 1; i < cs.length; i++) {
    if (near(clipEnd(cs[i - 1]), cs[i].start)) out.push({ time: cs[i].start, a: cs[i - 1], b: cs[i] });
  }
  return out;
}

export function seamNear(project, t, tolerance) {
  let best = null;
  for (const s of seams(project)) {
    const d = Math.abs(s.time - t);
    if (d <= tolerance && (!best || d < Math.abs(best.time - t))) best = s;
  }
  return best;
}

/** Longest a transition can be on a seam: the length of the shorter neighbour. */
export function maxTransition(seam) {
  return round(Math.max(0.1, Math.min(seam.a.duration, seam.b.duration)));
}

export function setTransition(project, bId, type, duration = DEFAULTS.transitionDuration) {
  const s = seams(project).find((x) => x.b.id === bId);
  if (!s) return false;
  if (!type) {
    s.b.transition = null;
    return true;
  }
  s.b.transition = { type, duration: clamp(duration, 0.1, maxTransition(s)) };
  // The transition replaces any fade at this seam (photos fade in and out by default).
  s.a.fadeOut = 0;
  s.b.fadeIn = 0;
  return true;
}

/** Storyboard order: lay the video clips back to back from 0 in the given order. */
export function reorderVideo(project, orderedIds) {
  let t = 0;
  for (const id of orderedIds) {
    const c = getClip(project, id);
    if (!c || c.track !== 'video') continue;
    c.start = round(t);
    t += c.duration;
  }
}

export function addMarker(project, marker) {
  project.markers.push(marker);
  project.markers.sort((a, b) => a.time - b.time);
}

export function removeMarker(project, id) {
  project.markers = project.markers.filter((m) => m.id !== id);
}

/** Time span covered by the given clips. */
export function rangeOf(project, ids) {
  const cs = project.clips.filter((c) => ids.includes(c.id));
  if (!cs.length) return null;
  const ranges = cs.map((c) => effectiveRange(project, c));
  return [Math.min(...ranges.map((r) => r[0])), Math.max(...ranges.map((r) => r[1]))];
}

/** The pair of markers around `t` (or the first two markers), for "between markers" ranges. */
export function markerRangeAround(project, t) {
  const ms = [...project.markers].sort((a, b) => a.time - b.time);
  if (ms.length < 2) return null;
  for (let i = 1; i < ms.length; i++) {
    if (t >= ms[i - 1].time && t <= ms[i].time) return [ms[i - 1].time, ms[i].time];
  }
  return [ms[0].time, ms[1].time];
}
