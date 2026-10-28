// Export and Quick share dialogs.

import { h, clear, download } from './dom.js';
import { modal, toast, confirmDialog, messageDialog } from './dialogs.js';
import { RESOLUTIONS } from '../core/model.js';
import { formatHMS, formatTimecode, safeBaseName } from '../core/time.js';
import { formatBytes, resolveOutputSize } from '../core/split.js';
import { markerRangeAround, rangeOf, movieDuration, trackClips } from '../core/timeline.js';
import { GIF_FPS_OPTIONS, GIF_WIDTHS, GIF_LIMIT, pickWidth, nextWidth, isLegible, LEGIBLE_WIDTH } from '../core/gifplan.js';
import { deepClone } from '../core/util.js';
import { exportMovie, planExport, exportSupported, exportFileName } from '../engine/exporter.js';
import { sampleGif, estimateAt, renderGif, fitsLimit } from '../engine/gif.js';

const TEST_MODE = new URLSearchParams(location.search).has('test');

/** Keep the screen awake and warn before closing the tab while a long job runs. */
async function longJob(fn) {
  let lock = null;
  try {
    lock = await navigator.wakeLock?.request('screen');
  } catch {
    lock = null;
  }
  const guard = (e) => {
    e.preventDefault();
    e.returnValue = '';
  };
  window.addEventListener('beforeunload', guard);
  try {
    return await fn();
  } finally {
    window.removeEventListener('beforeunload', guard);
    try {
      await lock?.release();
    } catch {
      /* ignore */
    }
  }
}

function notify(title, body) {
  try {
    if (document.visibilityState === 'visible') return;
    if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body, icon: 'icons/icon-192.png' });
  } catch {
    /* ignore */
  }
}

function askNotify() {
  try {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  } catch {
    /* ignore */
  }
}

async function chooseDestination(name, isZip) {
  if (TEST_MODE || !window.showSaveFilePicker) return { writable: null };
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: name,
      types: [isZip ? { description: 'Zip archive', accept: { 'application/zip': ['.zip'] } } : name.endsWith('.webm') ? { description: 'WebM video', accept: { 'video/webm': ['.webm'] } } : { description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
    });
    return { writable: await handle.createWritable(), fileName: handle.name };
  } catch (e) {
    if (e.name === 'AbortError') return null;
    return { writable: null };
  }
}

function eta(sec) {
  if (sec == null || !Number.isFinite(sec)) return 'estimating time left';
  if (sec < 60) return `about ${Math.max(1, Math.round(sec))} seconds left`;
  return `about ${Math.round(sec / 60)} minute${Math.round(sec / 60) === 1 ? '' : 's'} left`;
}

function sourceLabel(project) {
  const first = trackClips(project, 'video').find((c) => c.type === 'video' || c.type === 'image');
  const m = first ? project.media[first.mediaId] : null;
  const { width, height } = resolveOutputSize('source', m?.width, m?.height);
  return `Same as source (${width}×${height})`;
}

export function openExport(app) {
  const { store, media, player } = app;
  player.pause();
  if (!store.duration()) {
    messageDialog('Nothing to export yet', 'Add clips to the timeline first, then export.');
    return;
  }
  if (!exportSupported()) {
    messageDialog('Export isn’t available in this browser', 'Exporting needs the WebCodecs video encoder. Use a recent version of Chrome or Edge.');
    return;
  }
  const set = (fn) => store.silent((p) => fn(p.export));

  const modeSingle = h('input', { type: 'radio', name: 'mode', value: 'single' });
  const modeSplit = h('input', { type: 'radio', name: 'mode', value: 'split' });
  const seconds = h('input', { type: 'number', min: '1', step: '1', 'aria-label': 'Seconds per part' });
  const res = h('select', { 'aria-label': 'Output size' }, ...RESOLUTIONS.map((r) => h('option', { value: r.id }, r.id === 'source' ? sourceLabel(store.project) : r.label)));
  const fmt = h('select', { 'aria-label': 'Format' }, h('option', { value: 'mp4' }, 'MP4 (H.264)'), h('option', { value: 'webm' }, 'WebM (VP9)'));
  const quality = h('select', { 'aria-label': 'Quality' }, h('option', { value: 'standard' }, 'Standard'), h('option', { value: 'high' }, 'High'));
  const summary = h('div', { class: 'summary' });
  const area = h('div', {});

  const e = store.project.export;
  (e.mode === 'split' ? modeSplit : modeSingle).checked = true;
  seconds.value = e.splitSeconds;
  res.value = e.resolution;
  fmt.value = e.format;
  quality.value = e.quality;

  const update = () => {
    const sec = Math.max(1, Math.round(Number(seconds.value) || 30));
    set((x) => {
      x.mode = modeSplit.checked ? 'split' : 'single';
      x.splitSeconds = sec;
      x.resolution = res.value;
      x.format = fmt.value;
      x.quality = quality.value;
    });
    const plan = planExport(store.project);
    clear(summary);
    const len = formatHMS(plan.duration);
    if (plan.parts.length > 1) {
      summary.append(
        h('strong', {}, `${plan.parts.length} parts`),
        ` of ${sec} seconds from a ${len} movie, about ${formatBytes(plan.partBytes)} each (${formatBytes(plan.bytes)} total), saved as one zip.`,
        h('br'),
        `${plan.width}×${plan.height}, ${plan.fps} fps. The dashed lines on the timeline show where each part starts.`,
      );
    } else {
      summary.append(h('strong', {}, '1 file'), `, ${len} long, about ${formatBytes(plan.bytes)}.`, h('br'), `${plan.width}×${plan.height}, ${plan.fps} fps.`);
    }
  };
  for (const el of [modeSingle, modeSplit, seconds, res, fmt, quality]) el.addEventListener('input', update);
  seconds.addEventListener('focus', () => {
    modeSplit.checked = true;
    update();
  });

  area.append(
    h('label', { class: 'choice' }, modeSingle, h('div', {}, h('div', { class: 'choice-title' }, 'Single file'), h('div', { class: 'note' }, 'The whole movie as one video.'))),
    h('label', { class: 'choice' }, modeSplit, h('div', {}, h('div', { class: 'choice-title' }, 'Split every ', seconds, ' seconds'), h('div', { class: 'note' }, 'Hard cuts into separate files, downloaded together as a zip.'))),
    h('div', { class: 'field' }, h('label', {}, 'Output'), res),
    h('div', { class: 'field' }, h('label', {}, 'Format'), fmt),
    h('div', { class: 'field' }, h('label', {}, 'Quality'), quality),
    summary,
  );
  update();

  let running = null;
  modal({
    title: 'Export movie',
    body: area,
    wide: true,
    buttons: [
      {
        label: 'Cancel',
        onClick: (close) => {
          if (running) {
            running.abort();
            return;
          }
          close(null);
        },
      },
      {
        label: 'Export',
        primary: true,
        id: 'export-start',
        onClick: async (close) => {
          if (running) return;
          const project = deepClone(store.project);
          const name = exportFileName(project);
          const dest = await chooseDestination(name, planExport(project).parts.length > 1);
          if (!dest) return;
          askNotify();
          running = new AbortController();
          const startBtn = document.getElementById('export-start');
          startBtn.disabled = true;
          const bar = h('div', {});
          const status = h('p', {}, 'Preparing…');
          clear(area).append(h('div', { class: 'progress' }, bar), status, h('p', { class: 'note' }, 'You can keep this tab in the background. The screen stays awake until the export finishes.'));
          try {
            const result = await longJob(() =>
              exportMovie({
                project,
                media,
                writable: dest.writable,
                signal: running.signal,
                onProgress: ({ done, total, part, parts, etaSec }) => {
                  bar.style.width = `${(done / total) * 100}%`;
                  status.textContent = `${parts > 1 ? `Part ${part + 1} of ${parts} · ` : ''}${Math.round((done / total) * 100)}% · ${eta(etaSec)}`;
                },
              }),
            );
            const fileName = dest.fileName || result.name;
            if (result.blob) download(result.blob, fileName);
            const what = result.parts > 1 ? `${result.parts} parts in ${fileName}` : fileName;
            toast(`Exported ${what}.`, { timeout: 8000 });
            if (result.audioCodec === 'opus' && project.export.format === 'mp4') toast('This browser can’t encode AAC sound, so the MP4 uses Opus sound. It plays in browsers and VLC; some older players may be silent.', { timeout: 12000 });
            notify('Export finished', `Saved ${what}.`);
            close(true);
          } catch (err) {
            if (err.name === 'AbortError') {
              toast('Export cancelled.');
              close(null);
            } else {
              console.error(err);
              clear(area).append(h('div', { class: 'warning-box' }, `Export failed: ${err.message || err}`), h('p', { class: 'note' }, 'Try a lower output size, or the other format.'));
              startBtn.disabled = true;
            }
            try {
              await dest.writable?.abort();
            } catch {
              /* already closed */
            }
          } finally {
            running = null;
          }
        },
      },
    ],
  }).then(() => {
    // Closing the dialog (Escape, ×) while exporting stops the export.
    if (running) running.abort();
  });
}

export function openQuickShare(app) {
  const { store, media, player } = app;
  player.pause();
  const p = store.project;
  const d = movieDuration(p);
  if (!d) {
    messageDialog('Nothing to share yet', 'Add clips to the timeline first.');
    return;
  }
  const options = [];
  const sel = rangeOf(p, [...store.selection]);
  if (sel && sel[1] - sel[0] > 0.1) options.push({ id: 'selection', label: 'Selected clips', range: sel });
  const mr = markerRangeAround(p, store.playhead);
  if (mr && mr[1] - mr[0] > 0.1) options.push({ id: 'markers', label: 'Between markers', range: mr });
  options.push({ id: 'all', label: 'Whole movie', range: [0, d] });

  let range = options[0].range;
  let fps = 12;
  let sample = null;
  let sampling = null;
  const est = h('div', { class: 'summary' }, 'Measuring…');
  const radios = options.map((o, i) => {
    const r = h('input', { type: 'radio', name: 'gif-range', value: o.id });
    r.checked = i === 0;
    r.addEventListener('change', () => {
      range = o.range;
      measure();
    });
    return h('label', { class: 'choice' }, r, h('div', {}, h('div', { class: 'choice-title' }, o.label), h('div', { class: 'note' }, `${formatTimecode(o.range[0])} – ${formatTimecode(o.range[1])} (${formatHMS(o.range[1] - o.range[0])})`)));
  });
  const fpsSel = h('select', { 'aria-label': 'Frame rate' }, ...GIF_FPS_OPTIONS.map((f) => h('option', { value: f }, `${f} fps`)));
  fpsSel.value = fps;
  fpsSel.addEventListener('change', () => {
    fps = Number(fpsSel.value);
    measure();
  });
  const area = h(
    'div',
    {},
    h('p', {}, 'A silent, looping GIF under 10 MB, sized for GitHub issues and READMEs. Width steps down automatically until it fits.'),
    ...radios,
    h('div', { class: 'field' }, h('label', {}, 'Frame rate'), fpsSel),
    est,
  );

  async function measure() {
    const mine = Symbol('m');
    sampling = mine;
    clear(est).append('Measuring…');
    try {
      const s = await sampleGif(media, deepClone(store.project), range[0], range[1], fps);
      if (sampling !== mine) return;
      sample = s;
      const w = pickWidth((x) => estimateAt(s, x));
      clear(est);
      if (w == null) {
        est.append(h('strong', {}, 'Too long for 10 MB'), ', even at 240 px wide. Shorten the range or lower the frame rate.');
      } else {
        est.append(h('strong', {}, `${w} px wide`), `, about ${formatBytes(estimateAt(s, w))} (${s.frames} frames).`);
        if (!isLegible(w)) est.append(h('div', { class: 'warning-box' }, `Below ${LEGIBLE_WIDTH} px, on-screen text may be hard to read. A shorter range or lower frame rate keeps it sharper.`));
      }
    } catch (e) {
      if (sampling === mine) clear(est).append(`Couldn’t measure: ${e.message}`);
    }
  }
  measure();

  let running = null;
  modal({
    title: 'Quick share GIF',
    body: area,
    buttons: [
      { label: 'Cancel', onClick: (close) => (running ? running.abort() : close(null)) },
      {
        label: 'Make GIF',
        primary: true,
        id: 'gif-start',
        onClick: async (close) => {
          if (running) return;
          if (!sample) await measure();
          if (!sample) return;
          let width = pickWidth((x) => estimateAt(sample, x)) ?? GIF_WIDTHS[GIF_WIDTHS.length - 1];
          if (!isLegible(width) && !(await confirmDialog('Text may be hard to read', `To fit 10 MB this GIF needs to be ${width} px wide. Shortening the range or lowering the frame rate keeps text sharper.`, { ok: 'Make it smaller', cancel: 'Go back' }))) return;
          running = new AbortController();
          document.getElementById('gif-start').disabled = true;
          const bar = h('div', {});
          const status = h('p', {}, '');
          clear(area).append(h('div', { class: 'progress' }, bar), status);
          const project = deepClone(store.project);
          try {
            let blob = null;
            for (;;) {
              status.textContent = `Making a ${width} px GIF…`;
              blob = await longJob(() => renderGif({ media, project, start: range[0], end: range[1], fps, width, signal: running.signal, onProgress: (f) => (bar.style.width = `${f * 100}%`) }));
              if (fitsLimit(blob.size)) break;
              const next = nextWidth(width);
              if (next == null) {
                clear(area).append(h('div', { class: 'warning-box' }, `Still ${formatBytes(blob.size)} at ${width} px, over the 10 MB limit. Shorten the range or lower the frame rate.`));
                blob = null;
                break;
              }
              if (isLegible(width) && !isLegible(next)) {
                const ok = await confirmDialog('Text may be hard to read', `At ${width} px the GIF is ${formatBytes(blob.size)}. Going down to ${next} px will fit, but on-screen text may blur. You could shorten the range or lower the frame rate instead.`, { ok: `Continue at ${next} px`, cancel: 'Go back' });
                if (!ok) {
                  blob = null;
                  close(null);
                  break;
                }
              }
              width = next;
            }
            if (blob) {
              const name = `${safeBaseName(project.name)}.gif`;
              download(blob, name);
              toast(`Saved ${name}: ${width} px, ${formatBytes(blob.size)} (limit ${formatBytes(GIF_LIMIT)}).`, { timeout: 9000 });
              close(true);
            }
          } catch (e) {
            if (e.name === 'AbortError') close(null);
            else clear(area).append(h('div', { class: 'warning-box' }, `Couldn’t make the GIF: ${e.message}`));
          } finally {
            running = null;
          }
        },
      },
    ],
  }).then(() => running && running.abort());
}
