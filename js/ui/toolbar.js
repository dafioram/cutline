// Top bar: import, undo/redo, view switch, project name, export.

import { h, icon, button, clear, isMac } from './dom.js';
import { showMenu } from './menu.js';
import { modal } from './dialogs.js';

const MOD = isMac ? '⌘' : 'Ctrl';

export function shortcutsDialog() {
  const rows = [
    ['Play / pause', 'Space'],
    ['Undo', `${MOD}+Z`],
    ['Redo', `${MOD}+Y or ${MOD}+Shift+Z`],
    ['Split at playhead', 'S'],
    ['Delete (close gap)', 'Delete'],
    ['Delete (leave gap)', 'Shift+Delete'],
    ['Add marker', 'M'],
    ['Step one frame', '← / →'],
    ['Jump one second', 'Shift+← / →'],
    ['Go to start / end', 'Home / End'],
    ['Set source in / out', 'I / O'],
    ['Duplicate', `${MOD}+D`],
    ['Select all clips', `${MOD}+A`],
    ['Zoom timeline', `${MOD}+scroll, + / −`],
    ['Snap off while dragging', 'Hold Alt'],
  ];
  modal({
    title: 'Keyboard shortcuts',
    body: h('table', { class: 'kbd-table' }, ...rows.map(([a, k]) => h('tr', {}, h('td', {}, a), h('td', {}, ...k.split(' or ').flatMap((x, i) => (i ? [' or ', h('kbd', {}, x)] : [h('kbd', {}, x)])))))),
    buttons: [{ label: 'Close', value: true, primary: true }],
  });
}

export function aboutDialog() {
  modal({
    title: 'About Cutline',
    body: h(
      'div',
      {},
      h('p', {}, 'Cutline edits video entirely in your browser. Files you import are stored in this browser’s private storage and never uploaded anywhere.'),
      h('p', {}, 'It works offline once loaded. Install it from the browser’s address bar to use it like a desktop app.'),
      h('p', {}, 'Open-source components: mp4-muxer, webm-muxer, fflate, gifenc (MIT), heic2any (MIT) and ffmpeg.wasm (MIT wrapper, GPL core) for converting unusual formats.'),
    ),
    buttons: [{ label: 'Close', value: true, primary: true }],
  });
}

export function mountToolbar(root, app) {
  const { store, actions } = app;
  const undoBtn = button('Undo', { iconName: 'undo', cls: 'icon-only ghost', kbd: `${MOD}+Z`, onClick: () => app.undo() });
  const redoBtn = button('Redo', { iconName: 'redo', cls: 'icon-only ghost', kbd: `${MOD}+Y`, onClick: () => app.redo() });
  const timelineBtn = button('Timeline', { iconName: 'timeline', onClick: () => store.setView({ mode: 'timeline' }) });
  const storyBtn = button('Storyboard', { iconName: 'storyboard', onClick: () => store.setView({ mode: 'storyboard' }) });
  const name = h('input', {
    class: 'project-name',
    type: 'text',
    'aria-label': 'Movie name',
    spellcheck: 'false',
    onchange: (e) => {
      const v = e.target.value.trim() || 'Untitled movie';
      store.commit('Rename movie', (p) => {
        p.name = v;
      });
    },
    onkeydown: (e) => {
      if (e.key === 'Enter') e.target.blur();
    },
  });
  const saveState = h('span', { class: 'save-state', 'aria-live': 'polite' });
  const more = button('More', {
    iconName: 'more',
    cls: 'icon-only ghost',
    onClick: (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      showMenu(r.left, r.bottom + 4, [
        { label: 'New movie', onClick: () => actions.newProject() },
        { label: 'Open project file…', onClick: () => actions.openProject() },
        { label: 'Save a copy…', onClick: () => actions.saveCopy() },
        'sep',
        { label: 'Add title card', onClick: () => actions.addTitle() },
        { label: 'Freeze frame at playhead', onClick: () => actions.freezeFrame() },
        { label: 'Clean up unused media…', onClick: () => actions.cleanUp() },
        'sep',
        { label: 'Keyboard shortcuts', onClick: shortcutsDialog },
        { label: 'About Cutline', onClick: aboutDialog },
      ]);
    },
  });

  clear(root).append(
    h('div', { class: 'brand' }, h('img', { src: 'icons/favicon.svg', alt: '' }), 'Cutline'),
    button('Import', { iconName: 'import', onClick: () => actions.importDialog() }),
    h('div', { class: 'toolbar-group' }, undoBtn, redoBtn),
    h('div', { class: 'seg', role: 'group', 'aria-label': 'View' }, timelineBtn, storyBtn),
    name,
    h('div', { class: 'spacer' }),
    saveState,
    button('Save frame', { iconName: 'camera', cls: 'ghost', title: 'Save the current frame as a PNG', onClick: () => actions.saveFrame() }),
    button('Quick share', { iconName: 'share', title: 'Make a looping GIF under 10 MB for GitHub', onClick: () => app.openQuickShare() }),
    button('Export', { iconName: 'export', primary: true, onClick: () => app.openExport() }),
    more,
  );

  const sync = () => {
    undoBtn.disabled = !store.history.canUndo();
    redoBtn.disabled = !store.history.canRedo();
    undoBtn.title = store.history.canUndo() ? `Undo ${store.history.nextUndoLabel().toLowerCase()} (${MOD}+Z)` : 'Nothing to undo';
    redoBtn.title = store.history.canRedo() ? `Redo ${store.history.nextRedoLabel().toLowerCase()} (${MOD}+Y)` : 'Nothing to redo';
    if (document.activeElement !== name) name.value = store.project.name;
    timelineBtn.classList.toggle('active', store.view.mode === 'timeline');
    storyBtn.classList.toggle('active', store.view.mode === 'storyboard');
    timelineBtn.setAttribute('aria-pressed', store.view.mode === 'timeline');
    storyBtn.setAttribute('aria-pressed', store.view.mode === 'storyboard');
  };
  store.on('change', sync);
  store.on('view', sync);
  sync();

  return {
    setSaveState(text) {
      saveState.textContent = text;
    },
  };
}

