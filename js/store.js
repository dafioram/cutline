// App state: the project, undo history, selection, playhead and view settings.
// Panels listen for events instead of calling each other.
//   'change'    project edited (or undo/redo/load)
//   'select'    selection changed
//   'time'      playhead moved
//   'view'      view settings changed (zoom, storyboard, preview mode)
//   'media'     media library status changed (thumbnails, conversion progress)

import { createProject } from './core/model.js';
import { History } from './core/history.js';
import { movieDuration } from './core/timeline.js';

export class Store extends EventTarget {
  constructor() {
    super();
    this.project = createProject();
    this.history = new History({ limit: 200 });
    this.selection = new Set();
    this.playhead = 0;
    this.view = {
      mode: 'timeline', // 'timeline' | 'storyboard'
      pxPerSec: 60,
      preview: 'movie', // 'movie' | 'source'
      sourceBinId: null,
      sourceIn: null,
      sourceOut: null,
      workspaceTab: 'media',
      splitPreview: false, // export dialog open with a split period
      gifRange: null,
    };
    this.dirty = false;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  on(type, fn) {
    this.addEventListener(type, (e) => fn(e.detail));
  }

  /** Apply an edit with undo support. `fn` mutates the project; return false to cancel. */
  commit(label, fn) {
    const before = JSON.stringify(this.project);
    const result = fn(this.project);
    if (result === false) return result;
    const after = JSON.stringify(this.project);
    if (after === before) return result;
    this.history.push(before, label);
    this.changed();
    return result;
  }

  /**
   * Continuous edits (dragging, sliders): `update` mutates live without undo steps,
   * `end` records a single undo step if anything changed. `cancel` restores the start state.
   */
  gesture(label) {
    const before = JSON.stringify(this.project);
    let base = JSON.parse(before);
    return {
      /** Re-apply from the gesture's start state each time, so moves don't accumulate. */
      apply: (fn) => {
        this.project = JSON.parse(before);
        fn(this.project);
        this.changed();
      },
      update: (fn) => {
        fn(this.project);
        this.changed();
      },
      end: () => {
        const after = JSON.stringify(this.project);
        if (after !== before) this.history.push(before, label);
        base = null;
        this.emit('change');
      },
      cancel: () => {
        this.project = JSON.parse(before);
        this.changed();
      },
      get base() {
        return base;
      },
    };
  }

  /** Edits that shouldn't create undo steps (e.g. media metadata arriving from analysis). */
  silent(fn) {
    fn(this.project);
    this.changed();
  }

  changed() {
    this.dirty = true;
    this.pruneSelection();
    this.emit('change');
  }

  undo() {
    const entry = this.history.undo(JSON.stringify(this.project));
    if (!entry) return false;
    this.project = JSON.parse(entry.json);
    this.changed();
    return entry.label;
  }

  redo() {
    const entry = this.history.redo(JSON.stringify(this.project));
    if (!entry) return false;
    this.project = JSON.parse(entry.json);
    this.changed();
    return entry.label;
  }

  load(project) {
    this.project = project;
    this.history.clear();
    this.selection.clear();
    this.playhead = 0;
    this.changed();
    this.emit('select');
    this.emit('time');
  }

  select(ids, { add = false, toggle = false } = {}) {
    if (!add && !toggle) this.selection.clear();
    for (const id of ids) {
      if (toggle && this.selection.has(id)) this.selection.delete(id);
      else this.selection.add(id);
    }
    this.emit('select');
  }

  clearSelection() {
    if (!this.selection.size) return;
    this.selection.clear();
    this.emit('select');
  }

  pruneSelection() {
    const ids = new Set(this.project.clips.map((c) => c.id));
    const binIds = new Set(this.project.bin.map((b) => b.id));
    let changed = false;
    for (const id of [...this.selection]) {
      if (!ids.has(id) && !binIds.has(id)) {
        this.selection.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit('select');
  }

  selectedClips() {
    return this.project.clips.filter((c) => this.selection.has(c.id));
  }

  setPlayhead(t) {
    const d = movieDuration(this.project);
    const nt = Math.max(0, Math.min(t, Math.max(d, 0)));
    if (nt === this.playhead) return;
    this.playhead = nt;
    this.emit('time');
  }

  setView(patch) {
    Object.assign(this.view, patch);
    this.emit('view');
  }

  duration() {
    return movieDuration(this.project);
  }
}
