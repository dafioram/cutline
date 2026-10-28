// Cutline: wires the store, media engine and panels together, and handles shortcuts,
// autosave, panel resizing, offline support and files opened from the desktop.

import { Store } from './store.js';
import { MediaLibrary } from './engine/media.js';
import { Player } from './engine/player.js';
import { storage } from './engine/storage.js';
import { Actions } from './actions.js';
import { mountToolbar } from './ui/toolbar.js';
import { mountWorkspace } from './ui/workspace.js';
import { mountPreview } from './ui/preview.js';
import { mountProperties } from './ui/properties.js';
import { mountTimeline } from './ui/timeline.js';
import { renderStoryboard } from './ui/storyboard.js';
import { openExport, openQuickShare } from './ui/export-dialog.js';
import { toast } from './ui/dialogs.js';
import { closeMenu } from './ui/menu.js';
import { moveClips, setTransition as setTransitionCore } from './core/timeline.js';
import { PROJECT_VERSION } from './core/model.js';

const store = new Store();
const media = new MediaLibrary(store);
const player = new Player(store, media, document.createElement('canvas'));

const app = {
  store,
  media,
  player,
  undo() {
    const label = store.undo();
    if (label) toast(`Undid ${label.toLowerCase()}.`, { timeout: 2000 });
  },
  redo() {
    const label = store.redo();
    if (label) toast(`Redid ${label.toLowerCase()}.`, { timeout: 2000 });
  },
  seek(t) {
    store.setPlayhead(t);
    if (player.playing) {
      player.startT = store.playhead;
      player.startPerf = performance.now();
    }
  },
  stepFrames(n) {
    player.pause();
    app.seek(store.playhead + n / store.project.settings.fps);
  },
  openSource(binId) {
    const item = store.project.bin.find((b) => b.id === binId);
    if (!item || !media.isReady(item.mediaId)) return;
    store.select([binId]);
    store.setView({ preview: 'source', sourceBinId: binId });
  },
  focusProperties() {
    app.properties?.focus();
  },
  openExport: () => openExport(app),
  openQuickShare: () => openQuickShare(app),
  moveClipTo(project, clip, t) {
    moveClips(project, [clip.id], t - clip.start);
  },
  setTransition(project, id, type, duration) {
    return setTransitionCore(project, id, type, duration);
  },
  renderStoryboard: (host) => renderStoryboard(host, app),
  sourceKeys: null,
};
app.actions = new Actions(app);

const toolbar = mountToolbar(document.getElementById('toolbar'), app);
mountWorkspace(document.getElementById('workspace'), app);
mountPreview(document.getElementById('preview'), app);
app.properties = mountProperties(document.getElementById('properties'), app);
app.timeline = mountTimeline(document.getElementById('timeline'), app);

// ---------- panel splitters ----------
const SIZES_KEY = 'cutline.layout';
function loadSizes() {
  try {
    return JSON.parse(localStorage.getItem(SIZES_KEY)) || {};
  } catch {
    return {};
  }
}
function saveSizes(s) {
  try {
    localStorage.setItem(SIZES_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}
const sizes = loadSizes();
const rootStyle = document.documentElement.style;
if (sizes.left) rootStyle.setProperty('--left-w', `${sizes.left}px`);
if (sizes.right) rootStyle.setProperty('--right-w', `${sizes.right}px`);
if (sizes.timeline) rootStyle.setProperty('--timeline-h', `${sizes.timeline}px`);

for (const sp of document.querySelectorAll('.splitter')) {
  sp.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    sp.classList.add('dragging');
    sp.setPointerCapture(e.pointerId);
    const kind = sp.dataset.split;
    const startX = e.clientX;
    const startY = e.clientY;
    const cs = getComputedStyle(document.documentElement);
    const start = {
      left: parseFloat(cs.getPropertyValue('--left-w')),
      right: parseFloat(cs.getPropertyValue('--right-w')),
      timeline: parseFloat(cs.getPropertyValue('--timeline-h')),
    };
    const move = (ev) => {
      if (kind === 'left') sizes.left = Math.max(200, Math.min(520, start.left + ev.clientX - startX));
      if (kind === 'right') sizes.right = Math.max(240, Math.min(520, start.right - (ev.clientX - startX)));
      if (kind === 'timeline') sizes.timeline = Math.max(150, Math.min(window.innerHeight - 260, start.timeline - (ev.clientY - startY)));
      rootStyle.setProperty(`--${kind === 'timeline' ? 'timeline-h' : kind + '-w'}`, `${sizes[kind]}px`);
    };
    const up = () => {
      sp.classList.remove('dragging');
      sp.removeEventListener('pointermove', move);
      saveSizes(sizes);
    };
    sp.addEventListener('pointermove', move);
    sp.addEventListener('pointerup', up, { once: true });
  });
}

// Mouse clicks on buttons don't keep focus, so Space keeps meaning play/pause.
// Keyboard users still Tab to buttons and activate them normally.
document.addEventListener('mousedown', (e) => {
  if (e.button === 0 && e.target.closest('.btn, .tab, .menu-item') && !e.target.closest('.dialog')) e.preventDefault();
});

store.on('change', () => {
  document.title = store.project.clips.length || store.project.name !== 'Untitled movie' ? `${store.project.name} – Cutline` : 'Cutline';
});

// ---------- keyboard ----------
function typing(e) {
  const t = e.target;
  return t && (t.isContentEditable || (t.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button'].includes(t.type)) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
}

window.addEventListener('keydown', (e) => {
  if (document.querySelector('.backdrop')) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'z' && !e.shiftKey) {
    if (typing(e)) return;
    e.preventDefault();
    app.undo();
    return;
  }
  if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
    if (typing(e)) return;
    e.preventDefault();
    app.redo();
    return;
  }
  if (typing(e)) return;
  // A focused button (reached with Tab) handles Space and Enter itself.
  if ((key === ' ' || key === 'enter') && e.target.closest?.('button, [role="button"], [role="tab"]')) return;
  if (mod && key === 'd') {
    e.preventDefault();
    app.actions.duplicate();
    return;
  }
  if (mod && key === 'a') {
    e.preventDefault();
    store.select(store.project.clips.map((c) => c.id));
    return;
  }
  if (mod && key === 's') {
    e.preventDefault();
    toast('Cutline saves automatically. Use “Save a copy” in the ⋯ menu to keep a project file.');
    return;
  }
  if (mod || e.altKey) return;

  // Source (trim) mode keys.
  if (store.view.preview === 'source' && app.sourceKeys) {
    if (key === 'i') return void app.sourceKeys.setIn();
    if (key === 'o') return void app.sourceKeys.setOut();
    if (key === ' ') {
      e.preventDefault();
      return void app.sourceKeys.toggle();
    }
    if (key === 'arrowleft') return void app.sourceKeys.step(e.shiftKey ? -1 : -1 / 30);
    if (key === 'arrowright') return void app.sourceKeys.step(e.shiftKey ? 1 : 1 / 30);
    if (key === 'escape') return void store.setView({ preview: 'movie', sourceBinId: null });
  }

  switch (key) {
    case ' ':
      e.preventDefault();
      player.toggle();
      break;
    case 's':
      app.actions.splitAtPlayhead();
      break;
    case 'm':
      app.actions.addMarkerAt();
      break;
    case 'delete':
    case 'backspace':
      e.preventDefault();
      app.actions.deleteSelection({ ripple: !e.shiftKey });
      break;
    case 'arrowleft':
      e.preventDefault();
      if (e.shiftKey) app.seek(store.playhead - 1);
      else app.stepFrames(-1);
      break;
    case 'arrowright':
      e.preventDefault();
      if (e.shiftKey) app.seek(store.playhead + 1);
      else app.stepFrames(1);
      break;
    case 'home':
      app.seek(0);
      break;
    case 'end':
      app.seek(store.duration());
      break;
    case '+':
    case '=':
      app.timeline.zoomBy(1.4);
      break;
    case '-':
      app.timeline.zoomBy(1 / 1.4);
      break;
    case 'escape':
      closeMenu();
      store.clearSelection();
      break;
    default:
      break;
  }
});

// ---------- dropping files outside the drop targets ----------
window.addEventListener('dragover', (e) => {
  if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  // The workspace, timeline and storyboard handle their own drops; this catches the rest.
  if (e.defaultPrevented || !e.dataTransfer?.files?.length) return;
  e.preventDefault();
  app.actions.importFiles([...e.dataTransfer.files]);
});

// ---------- autosave ----------
let saveTimer = 0;
let saving = Promise.resolve();
store.on('change', () => {
  toolbar.setSaveState('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const snapshot = store.project;
    saving = saving
      .then(() => storage.saveProject(snapshot))
      .then(() => toolbar.setSaveState('All changes saved'))
      .catch(() => toolbar.setSaveState('Not saved'));
  }, 700);
});

async function restore() {
  if (!storage.supported()) {
    toast('This browser can’t store files locally, so your work won’t be kept after closing the tab.', { kind: 'error', timeout: 12000 });
    return;
  }
  const saved = await storage.loadProject();
  if (saved && saved.version <= PROJECT_VERSION && Array.isArray(saved.clips)) {
    store.load(saved);
    toolbar.setSaveState('All changes saved');
    await media.restore(saved);
    const missing = Object.keys(saved.media).filter((id) => media.getStatus(id).state === 'missing');
    if (missing.length) toast(`${missing.length} media file${missing.length > 1 ? 's' : ''} couldn’t be found in storage. Use Relink in the workspace.`, { timeout: 10000 });
  }
}

// ---------- files opened with Cutline from the desktop (installed app) ----------
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files?.length) return;
    const files = await Promise.all(params.files.map((f) => f.getFile()));
    app.actions.importFiles(files);
  });
}

// ---------- offline support ----------
let updateRequested = false;
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker
    .register('sw.js')
    .then((reg) => {
      const offerUpdate = (worker) => {
        const banner = toast('A new version of Cutline is ready.', {
          timeout: 0,
          action: {
            label: 'Reload',
            run: () => {
              updateRequested = true;
              worker.postMessage({ type: 'skipWaiting' });
            },
          },
        });
        banner.classList.add('update-banner');
      };
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(w);
        });
      });
    })
    .catch((e) => console.warn('Offline support unavailable:', e));
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Only reload when the user asked for the update, never on first install.
    if (reloading || !updateRequested) return;
    reloading = true;
    location.reload();
  });
}

window.addEventListener('error', (e) => {
  console.error(e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  const msg = e.reason?.message || String(e.reason);
  if (e.reason?.name === 'AbortError') return;
  toast(`Something went wrong: ${msg}`, { kind: 'error', timeout: 8000 });
});

restore().finally(() => {
  document.body.dataset.ready = 'true';
});

// For debugging and tests.
window.cutline = app;
