// Project data model: plain JSON so it can be autosaved, exported and snapshotted for undo.
// Media bytes never live here, only metadata; the engine keeps the files on disk (OPFS).

import { uid } from './util.js';

export const PROJECT_VERSION = 1;

export const TRACKS = ['overlay', 'video', 'music'];

export const DEFAULTS = {
  imageDuration: 5,
  imageFade: 1,
  titleDuration: 4,
  freezeDuration: 3,
  transitionDuration: 1,
  fadeDuration: 1,
  overlayDuration: 5,
  musicDim: 0.25,
  minClip: 0.1,
};

export const FONTS = [
  { id: 'sans', label: 'Sans', css: "'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" },
  { id: 'serif', label: 'Serif', css: "Georgia, 'Times New Roman', serif" },
  { id: 'mono', label: 'Mono', css: "Consolas, 'Courier New', monospace" },
  { id: 'round', label: 'Friendly', css: "'Trebuchet MS', Verdana, sans-serif" },
  { id: 'bold', label: 'Poster', css: "Impact, 'Arial Black', sans-serif" },
];

export function fontCss(id) {
  return (FONTS.find((f) => f.id === id) || FONTS[0]).css;
}

export const TRANSITIONS = [
  { id: 'crossfade', label: 'Cross-fade' },
  { id: 'fadeblack', label: 'Fade through black' },
  { id: 'wipe', label: 'Wipe' },
];

export const OVERLAY_KINDS = [
  { id: 'clock', label: 'Running clock' },
  { id: 'image', label: 'Image / logo' },
  { id: 'text', label: 'Text label' },
  { id: 'lowerthird', label: 'Lower third' },
  { id: 'part', label: 'Part indicator' },
  { id: 'blur', label: 'Blur / pixelate box' },
  { id: 'subtitles', label: 'Subtitles (SRT)' },
  { id: 'shape', label: 'Shape / arrow' },
  { id: 'date', label: 'Date stamp' },
];

// Each corner overlay type gets its own default corner so they don't pile up.
export const DEFAULT_CORNER = {
  clock: 'br',
  image: 'tr',
  part: 'tl',
  date: 'bl',
};

export const RESOLUTIONS = [
  { id: 'source', label: 'Same as source' },
  { id: '720', label: '720p', height: 720 },
  { id: '1080', label: '1080p', height: 1080 },
  { id: '2160', label: '4K', height: 2160 },
];

export function createProject(name = 'Untitled movie') {
  return {
    version: PROJECT_VERSION,
    id: uid('proj'),
    name,
    settings: {
      fps: 30,
      evenOutVolume: false,
      safeZone: true,
      snapping: true,
    },
    export: {
      mode: 'single', // 'single' | 'split'
      splitSeconds: 30,
      resolution: 'source',
      format: 'mp4',
      quality: 'standard',
    },
    media: {},
    bin: [],
    clips: [],
    markers: [],
  };
}

/** Media metadata record. The file itself is kept by the engine. */
export function createMedia({ id = uid('m'), name, kind, duration = 0, width = 0, height = 0, hasAudio = false, size = 0, mime = '', recordedAt = null, recordedAtSource = null, converted = false }) {
  return { id, name, kind, duration, width, height, hasAudio, size, mime, recordedAt, recordedAtSource, converted, addedAt: Date.now() };
}

/** Workspace (bin) item. Several items can point at one media file with different in/out points. */
export function createBinItem({ mediaId, name, inPoint = 0, outPoint = null, parentId = null }) {
  return { id: uid('b'), mediaId, name, in: inPoint, out: outPoint, parentId, collapsed: true };
}

function baseClip(track, type, start, duration) {
  return { id: uid('c'), track, type, start, duration, fadeIn: 0, fadeOut: 0, name: '' };
}

export function createVideoClip(media, { start = 0, inPoint = 0, outPoint = null, name } = {}) {
  const out = outPoint ?? media.duration;
  const c = baseClip('video', 'video', start, Math.max(0.1, out - inPoint));
  return { ...c, mediaId: media.id, in: inPoint, volume: 1, muted: false, transition: null, name: name || media.name };
}

export function createImageClip(media, { start = 0, duration = DEFAULTS.imageDuration, name, fades = true } = {}) {
  const c = baseClip('video', 'image', start, duration);
  const f = fades ? DEFAULTS.imageFade : 0;
  return { ...c, mediaId: media.id, fadeIn: f, fadeOut: f, transition: null, name: name || media.name };
}

export function createTitleClip({ start = 0, duration = DEFAULTS.titleDuration, text = 'Your title' } = {}) {
  const c = baseClip('video', 'title', start, duration);
  return {
    ...c,
    name: 'Title',
    fadeIn: 0.5,
    fadeOut: 0.5,
    transition: null,
    title: { text, font: 'sans', size: 96, color: '#ffffff', bg: '#101420' },
  };
}

export function createAudioClip(media, { start = 0, inPoint = 0, outPoint = null, name } = {}) {
  const out = outPoint ?? media.duration;
  const c = baseClip('music', 'audio', start, Math.max(0.1, out - inPoint));
  return { ...c, mediaId: media.id, in: inPoint, volume: 1, muted: false, dimEnabled: true, dimLevel: DEFAULTS.musicDim, name: name || media.name };
}

/** Overlay defaults per kind. Positions are normalized (0..1) box centers; `corner` wins until the user drags it. */
export function createOverlay(kind, { start = 0, duration = DEFAULTS.overlayDuration, lane = 0, mediaId = null, cues = null } = {}) {
  const c = baseClip('overlay', 'overlay', start, duration);
  const o = {
    ...c,
    kind,
    lane,
    opacity: 1,
    spanAll: false,
    corner: DEFAULT_CORNER[kind] || null,
    x: 0.5,
    y: 0.5,
    props: {},
  };
  switch (kind) {
    case 'clock':
      o.name = 'Running clock';
      o.spanAll = true;
      o.props = { startAt: 0, restartEachPart: false, size: 44, color: '#ffffff', box: true, font: 'mono' };
      break;
    case 'image':
      o.name = 'Logo';
      o.spanAll = true;
      o.opacity = 0.85;
      o.mediaId = mediaId;
      o.props = { width: 0.14 };
      break;
    case 'text':
      o.name = 'Text';
      o.corner = null;
      o.x = 0.5;
      o.y = 0.2;
      o.fadeIn = 0.3;
      o.fadeOut = 0.3;
      o.props = { text: 'Label', font: 'sans', size: 56, color: '#ffffff', box: true, boxColor: '#000000' };
      break;
    case 'lowerthird':
      o.name = 'Lower third';
      o.corner = null;
      o.x = 0.3;
      o.y = 0.82;
      o.fadeIn = 0.4;
      o.fadeOut = 0.4;
      o.props = { text: 'Jane Smith', subtext: 'Coach', font: 'sans', size: 48, color: '#ffffff', barColor: '#1e3a8a' };
      break;
    case 'part':
      o.name = 'Part indicator';
      o.spanAll = true;
      o.props = { size: 36, color: '#ffffff', box: true, font: 'sans' };
      break;
    case 'blur':
      o.name = 'Blur box';
      o.corner = null;
      o.props = { w: 0.2, h: 0.2, mode: 'blur', strength: 12 };
      break;
    case 'subtitles':
      o.name = 'Subtitles';
      o.corner = null;
      o.x = 0.5;
      o.y = 0.88;
      o.props = { cues: cues || [], size: 44, font: 'sans', color: '#ffffff', box: true };
      break;
    case 'shape':
      o.name = 'Arrow';
      o.corner = null;
      o.props = { shape: 'arrow', w: 0.18, h: 0.1, color: '#ffcc00', lineWidth: 8, fill: false, angle: 0 };
      break;
    case 'date':
      o.name = 'Date stamp';
      o.spanAll = true;
      o.props = { mode: 'auto', manual: '', format: 'datetime', size: 36, color: '#ffb000' };
      break;
    default:
      break;
  }
  return o;
}

export function createMarker(time, label = '') {
  return { id: uid('mk'), time, label };
}

export function isVisualVideoClip(c) {
  return c.track === 'video' && (c.type === 'video' || c.type === 'image' || c.type === 'title');
}
