// Editing commands shared by menus, keyboard shortcuts, toolbar buttons and drag and drop.

import {
  createVideoClip,
  createImageClip,
  createAudioClip,
  createTitleClip,
  createOverlay,
  createMarker,
  createBinItem,
  createProject,
  DEFAULTS,
  PROJECT_VERSION,
} from './core/model.js';
import {
  addClip,
  appendClip,
  splitClip,
  deleteClips,
  insertAt,
  getClip,
  clipsAt,
  setTransition,
  addMarker,
  removeMarker,
  bringToFront,
  sendToBack,
  clipEnd,
  movieDuration,
  trackClips,
} from './core/timeline.js';
import { acceptAttribute } from './core/formats.js';
import { formatHMS, safeBaseName } from './core/time.js';
import { uid, deepClone } from './core/util.js';
import { renderStill } from './engine/framerender.js';
import { findScenes } from './engine/scenes.js';
import { outputSize } from './engine/player.js';
import { storage } from './engine/storage.js';
import { toast, confirmDialog, messageDialog } from './ui/dialogs.js';
import { download } from './ui/dom.js';

export function pickFiles({ accept = acceptAttribute(), multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve([...input.files]);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

export class Actions {
  constructor(app) {
    this.app = app;
  }

  get store() {
    return this.app.store;
  }

  get media() {
    return this.app.media;
  }

  get project() {
    return this.store.project;
  }

  // ---------- import ----------

  async importDialog() {
    const files = await pickFiles();
    if (files.length) await this.importFiles(files);
  }

  /** Import files; with `at`, also place them on the timeline in order once they're ready. */
  async importFiles(files, { at = null } = {}) {
    let placeAt = at;
    const results = await this.media.importFiles(files, {
      onSubtitles: (cues, name) => this.addSubtitles(cues, name),
      onError: (msg) => toast(msg, { kind: 'error', timeout: 9000 }),
      onVideoReady: (mediaId, binId) => {
        const m = this.project.media[mediaId];
        if (m && m.duration > 60) {
          toast(`“${m.name}” is ${formatHMS(m.duration)} long. Split it into scenes?`, {
            timeout: 15000,
            action: { label: 'Split into scenes', run: () => this.splitIntoScenes(binId) },
          });
        }
      },
    });
    if (placeAt != null) {
      for (const r of results) {
        await r.job;
        if (!this.media.isReady(r.media.id)) continue;
        const clip = this.addBinItem(r.item.id, { at: placeAt, select: false });
        if (clip) placeAt = clipEnd(clip);
      }
    }
    return results;
  }

  addSubtitles(cues, name) {
    const end = Math.max(...cues.map((c) => c.end));
    const o = createOverlay('subtitles', { start: 0, duration: Math.max(1, end), cues });
    o.name = name.replace(/\.srt$/i, '');
    this.store.commit('Add subtitles', (p) => addClip(p, o));
    this.store.select([o.id]);
    toast(`Added ${cues.length} subtitle lines from “${name}”.`);
  }

  async splitIntoScenes(binId) {
    const item = this.project.bin.find((b) => b.id === binId);
    if (!item) return;
    const m = this.project.media[item.mediaId];
    const file = this.media.file(item.mediaId);
    if (!m || !file) return;
    this.media.setStatus(m.id, { scanning: true, progress: 0, message: 'Finding scenes' });
    try {
      const scenes = await findScenes(file, m.duration, { onProgress: (p) => this.media.setStatus(m.id, { progress: p }) });
      if (scenes.length < 2) {
        toast(`No scene changes found in “${m.name}”.`);
        return;
      }
      this.store.commit('Split into scenes', (p) => {
        const parent = p.bin.find((b) => b.id === binId);
        parent.collapsed = false;
        scenes.forEach((s, i) => {
          const child = createBinItem({ mediaId: m.id, name: `Scene ${i + 1}`, inPoint: s.start, outPoint: s.end, parentId: binId });
          p.bin.push(child);
        });
      });
      toast(`Found ${scenes.length} scenes in “${m.name}”.`);
    } catch (e) {
      toast(`Couldn't scan “${m.name}” for scenes: ${e.message}`, { kind: 'error' });
    } finally {
      this.media.setStatus(m.id, { scanning: false, message: '' });
    }
  }

  // ---------- adding to the timeline ----------

  clipFromBin(itemId, start = 0) {
    const item = this.project.bin.find((b) => b.id === itemId);
    if (!item) return null;
    const m = this.project.media[item.mediaId];
    if (!m || !this.media.isReady(m.id)) return null;
    const name = item.parentId ? `${m.name} · ${item.name}` : m.name;
    if (m.kind === 'video') return createVideoClip(m, { start, inPoint: item.in || 0, outPoint: item.out ?? m.duration, name });
    if (m.kind === 'image') return createImageClip(m, { start, name });
    if (m.kind === 'audio') return createAudioClip(m, { start, inPoint: item.in || 0, outPoint: item.out ?? m.duration, name });
    return null;
  }

  addBinItem(itemId, { at = null, select = true } = {}) {
    const clip = this.clipFromBin(itemId, at ?? 0);
    if (!clip) {
      toast('That item is still importing or its file is missing.');
      return null;
    }
    this.store.commit('Add clip', (p) => (at == null ? appendClip(p, clip) : addClip(p, clip)));
    if (select) this.store.select([clip.id]);
    return clip;
  }

  /** Add a trimmed source selection (from the preview's In/Out) to the end of the movie. */
  addSourceRange(binId, inPoint, outPoint) {
    const item = this.project.bin.find((b) => b.id === binId);
    if (!item) return;
    const m = this.project.media[item.mediaId];
    const clip = m.kind === 'audio' ? createAudioClip(m, { inPoint, outPoint }) : createVideoClip(m, { inPoint, outPoint });
    this.store.commit('Add clip', (p) => appendClip(p, clip));
    this.store.select([clip.id]);
    toast(`Added ${formatHMS(outPoint - inPoint)} of “${m.name}” to the end of the movie.`);
  }

  saveSourceRange(binId, inPoint, outPoint) {
    const item = this.project.bin.find((b) => b.id === binId);
    if (!item) return;
    const parentId = item.parentId || item.id;
    this.store.commit('Save clip', (p) => {
      const count = p.bin.filter((b) => b.parentId === parentId).length + 1;
      p.bin.push(createBinItem({ mediaId: item.mediaId, name: `Clip ${count}`, inPoint, outPoint, parentId }));
      const parent = p.bin.find((b) => b.id === parentId);
      if (parent) parent.collapsed = false;
    });
    toast('Saved the selection as a new clip in the workspace.');
  }

  addTitle({ at = null } = {}) {
    const clip = createTitleClip({ start: at ?? this.store.playhead });
    this.store.commit('Add title', (p) => (at == null ? insertAt(p, clip, this.titleInsertPoint(p)) : addClip(p, clip)));
    this.store.select([clip.id]);
  }

  titleInsertPoint(p) {
    const t = this.store.playhead;
    const under = trackClips(p, 'video').find((c) => t > c.start && t < clipEnd(c));
    if (!under) return Math.min(t, movieDuration(p));
    return t - under.start < under.duration / 2 ? under.start : clipEnd(under);
  }

  async addOverlay(kind, { at = null, lane = 0 } = {}) {
    if (kind === 'subtitles') {
      const files = await pickFiles({ accept: '.srt', multiple: false });
      if (files.length) await this.importFiles(files);
      return;
    }
    let mediaId = null;
    if (kind === 'image') {
      mediaId = await this.pickLogo();
      if (!mediaId) return;
    }
    const start = at ?? this.store.playhead;
    const o = createOverlay(kind, { start, lane, mediaId });
    if (kind === 'shape') o.x = 0.5;
    this.store.commit('Add overlay', (p) => addClip(p, o));
    this.store.select([o.id]);
    if (!this.store.duration()) toast('Overlays show once the movie has clips in it.');
  }

  /** Choose an image already in the workspace, or import one. */
  async pickLogo() {
    const sel = [...this.store.selection].map((id) => this.project.bin.find((b) => b.id === id)).find((b) => b && this.project.media[b.mediaId]?.kind === 'image');
    if (sel) return sel.mediaId;
    const files = await pickFiles({ accept: 'image/*,.heic,.heif', multiple: false });
    if (!files.length) return null;
    const [r] = await this.media.importFiles(files, { onError: (m) => toast(m, { kind: 'error' }) });
    if (!r) return null;
    await r.job;
    return this.media.isReady(r.media.id) ? r.media.id : null;
  }

  addTransition(bId, type) {
    let ok = false;
    this.store.commit('Add transition', (p) => {
      ok = setTransition(p, bId, type, DEFAULTS.transitionDuration);
      return ok;
    });
    return ok;
  }

  // ---------- editing ----------

  splitAtPlayhead() {
    const t = this.store.playhead;
    const selected = this.store.selectedClips().filter((c) => clipsAt(this.project, t).includes(c));
    const targets = selected.length ? selected : clipsAt(this.project, t, 'video');
    if (!targets.length) {
      toast('Move the playhead over a clip to split it.');
      return;
    }
    const ids = targets.map((c) => c.id);
    let made = 0;
    this.store.commit('Split', (p) => {
      for (const id of ids) if (splitClip(p, id, t)) made++;
      return made > 0;
    });
    if (!made) toast('The playhead is too close to the clip edge to split there.');
  }

  deleteSelection({ ripple = true } = {}) {
    const clipIds = this.store.selectedClips().map((c) => c.id);
    const binIds = this.project.bin.filter((b) => this.store.selection.has(b.id)).map((b) => b.id);
    if (clipIds.length) {
      this.store.commit(ripple ? 'Delete' : 'Delete (leave gap)', (p) => deleteClips(p, clipIds, { ripple }));
    } else if (binIds.length) {
      this.removeBinItems(binIds);
    }
  }

  removeBinItems(ids) {
    this.store.commit('Remove from workspace', (p) => {
      const all = new Set(ids);
      for (const b of p.bin) if (b.parentId && all.has(b.parentId)) all.add(b.id);
      p.bin = p.bin.filter((b) => !all.has(b.id));
    });
  }

  duplicate(ids = [...this.store.selection]) {
    const clips = ids.map((id) => getClip(this.project, id)).filter(Boolean);
    if (!clips.length) return;
    const made = [];
    this.store.commit('Duplicate', (p) => {
      for (const c of clips) {
        const copy = deepClone(c);
        copy.id = uid('c');
        if (c.track === 'overlay') {
          copy.lane = c.lane + 1;
          if (!c.spanAll) copy.start = c.start;
        } else {
          copy.start = clipEnd(c);
          copy.transition = null;
        }
        addClip(p, copy);
        made.push(copy.id);
      }
    });
    this.store.select(made);
  }

  setFade(id, which, on) {
    this.store.commit(on ? 'Add fade' : 'Remove fade', (p) => {
      const c = getClip(p, id);
      if (!c) return false;
      const key = which === 'in' ? 'fadeIn' : 'fadeOut';
      c[key] = on ? Math.min(DEFAULTS.fadeDuration, c.duration / 2) : 0;
    });
  }

  detachAudio(id) {
    const c = getClip(this.project, id);
    if (!c || c.type !== 'video') return;
    const m = this.project.media[c.mediaId];
    if (!m.hasAudio) {
      toast('This clip has no sound to detach.');
      return;
    }
    const a = createAudioClip(m, { start: c.start, inPoint: c.in, outPoint: c.in + c.duration, name: `${c.name} (sound)` });
    a.dimEnabled = false;
    a.volume = c.volume;
    let shifted = false;
    this.store.commit('Detach audio', (p) => {
      getClip(p, id).muted = true;
      const before = new Map(p.clips.filter((x) => x.track === 'music').map((x) => [x.id, x.start]));
      addClip(p, a);
      shifted = [...before].some(([cid, st]) => getClip(p, cid).start !== st);
    });
    this.store.select([a.id]);
    toast(shifted ? 'Moved the sound to the music track. Music that was already there moved later to make room.' : 'Moved the sound to the music track.');
    if (!this.media.peaks.has(m.id)) this.media.queueAnalysis(m.id);
  }

  toggleMute(id) {
    this.store.commit('Mute', (p) => {
      const c = getClip(p, id);
      if (c) c.muted = !c.muted;
    });
  }

  setSpanAll(id, on) {
    this.store.commit('Change overlay length', (p) => {
      const c = getClip(p, id);
      if (!c) return false;
      if (!on && c.spanAll) {
        c.start = 0;
        c.duration = Math.max(1, movieDuration(p));
      }
      c.spanAll = on;
    });
  }

  front(id) {
    this.store.commit('Bring to front', (p) => bringToFront(p, id));
  }

  back(id) {
    this.store.commit('Send to back', (p) => sendToBack(p, id));
  }

  addMarkerAt(t = this.store.playhead) {
    const m = createMarker(t);
    this.store.commit('Add marker', (p) => addMarker(p, m));
  }

  deleteMarker(id) {
    this.store.commit('Delete marker', (p) => removeMarker(p, id));
  }

  async freezeFrame() {
    const t = this.store.playhead;
    const under = clipsAt(this.project, t, 'video').find((c) => c.type === 'video' || c.type === 'image' || c.type === 'title');
    if (!under) {
      toast('Move the playhead over a video clip to freeze its frame.');
      return;
    }
    const { width, height } = outputSize(this.project);
    const blob = await renderStill(this.media, deepClone(this.project), t, width, height, { overlays: false });
    const m = await this.media.addGeneratedImage(blob, `Freeze ${formatHMS(t)}.png`);
    const clip = createImageClip(m, { duration: DEFAULTS.freezeDuration, fades: false, name: `Freeze frame ${formatHMS(t)}` });
    this.store.commit('Freeze frame', (p) => {
      p.media[m.id] = m;
      insertAt(p, clip, t);
    });
    this.store.select([clip.id]);
  }

  async saveFrame() {
    if (!this.store.duration()) {
      toast('Add something to the movie first.');
      return;
    }
    const { width, height } = outputSize(this.project);
    const t = this.store.playhead;
    const blob = await renderStill(this.media, deepClone(this.project), Math.min(t, this.store.duration() - 0.001), width, height);
    download(blob, `${safeBaseName(this.project.name)}_${formatHMS(t).replace(/:/g, '-')}.png`);
    toast('Saved the frame as a PNG.');
  }

  // ---------- projects ----------

  async newProject() {
    if (this.project.clips.length && !(await confirmDialog('Start a new movie?', 'The current movie is replaced. Use “Save a copy” first if you want to keep it.', { ok: 'Start new movie', danger: true }))) return;
    this.app.player.reset();
    this.store.load(createProject());
    toast('Started a new movie.');
  }

  saveCopy() {
    const json = JSON.stringify({ app: 'cutline', ...this.project }, null, 2);
    download(new Blob([json], { type: 'application/json' }), `${safeBaseName(this.project.name)}.cutline.json`);
    toast('Saved a copy of the project. Media files stay in this browser; you can relink them when opening the project elsewhere.');
  }

  async openProject() {
    const [file] = await pickFiles({ accept: '.json,application/json', multiple: false });
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      messageDialog('Can’t open that file', 'It isn’t a Cutline project file.');
      return;
    }
    if (!data || !Array.isArray(data.clips) || !data.media || data.version > PROJECT_VERSION) {
      messageDialog('Can’t open that file', 'It isn’t a Cutline project file, or it was made by a newer version.');
      return;
    }
    delete data.app;
    this.app.player.reset();
    this.store.load(data);
    await this.media.restore(data);
    const missing = Object.keys(data.media).filter((id) => this.media.getStatus(id).state === 'missing');
    if (missing.length) toast(`${missing.length} media file${missing.length > 1 ? 's are' : ' is'} missing. Use Relink in the workspace to point to ${missing.length > 1 ? 'them' : 'it'}.`, { timeout: 10000 });
  }

  async relink(mediaId) {
    const [file] = await pickFiles({ multiple: false });
    if (!file) return;
    try {
      await this.media.relink(mediaId, file);
      this.store.changed();
      toast(`Relinked “${file.name}”.`);
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  }

  /** Delete stored media that nothing in the project uses any more. */
  async cleanUp() {
    const used = new Set();
    for (const b of this.project.bin) used.add(b.mediaId);
    for (const c of this.project.clips) if (c.mediaId) used.add(c.mediaId);
    const onDisk = await storage.listMedia();
    const unused = onDisk.filter((id) => !used.has(id));
    if (!unused.length) {
      toast('Nothing to clean up. Every stored file is in use.');
      return;
    }
    if (!(await confirmDialog('Clean up unused media?', `${unused.length} stored file${unused.length > 1 ? 's aren’t' : ' isn’t'} used by this movie or the workspace. Deleting them frees space, and undo history is cleared.`, { ok: 'Delete unused files', danger: true }))) return;
    for (const id of unused) await this.media.forget(id);
    this.store.silent((p) => {
      for (const id of unused) delete p.media[id];
    });
    this.store.history.clear();
    this.store.changed();
    toast(`Deleted ${unused.length} unused file${unused.length > 1 ? 's' : ''}.`);
  }
}
