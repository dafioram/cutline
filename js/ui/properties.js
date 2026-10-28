// Properties panel: settings for whatever is selected, or the movie's settings when nothing is.

import { h, icon, button, clear, OVERLAY_ICON } from './dom.js';
import { FONTS, TRANSITIONS, OVERLAY_KINDS, RESOLUTIONS } from '../core/model.js';
import { formatTimecode, parseTime, formatHMS } from '../core/time.js';
import { formatBytes } from '../core/split.js';
import { getClip, seams, maxTransition, trimClip, movieDuration, effectiveRange } from '../core/timeline.js';
import { formatStamp } from '../core/mp4meta.js';
import { storage } from '../engine/storage.js';
import { converterCached, cacheConverter } from '../engine/convert.js';
import { toast } from './dialogs.js';

const TYPE_LABEL = { video: 'Video clip', image: 'Photo', title: 'Title card', audio: 'Music clip' };
const TYPE_ICON = { video: 'film', image: 'image', title: 'title', audio: 'music' };

function field(label, ...controls) {
  return h('div', { class: 'field' }, h('label', {}, label), controls.length > 1 ? h('div', { class: 'field-row' }, ...controls) : controls[0]);
}

function check(label, checked, onChange) {
  const input = h('input', { type: 'checkbox', onchange: (e) => onChange(e.target.checked) });
  input.checked = !!checked;
  return h('label', { class: 'check' }, input, label);
}

function select(options, value, onChange, label) {
  const s = h('select', { 'aria-label': label, onchange: (e) => onChange(e.target.value) }, ...options.map(([v, l]) => h('option', { value: v }, l)));
  s.value = String(value);
  return s;
}

function textInput(value, onCommit, { label, multiline = false, placeholder } = {}) {
  const el = h(multiline ? 'textarea' : 'input', { type: 'text', 'aria-label': label, placeholder, spellcheck: multiline ? 'true' : 'false' });
  el.value = value ?? '';
  el.addEventListener('change', () => onCommit(el.value));
  if (!multiline) el.addEventListener('keydown', (e) => e.key === 'Enter' && el.blur());
  return el;
}

/** Time entry accepting 83.5, 1:23.5 or 0:01:23. Shows red until valid. */
function timeInput(value, onCommit, label) {
  const el = h('input', { type: 'text', 'aria-label': label, inputmode: 'decimal' });
  el.value = formatTimecode(value);
  el.addEventListener('input', () => el.classList.toggle('invalid', Number.isNaN(parseTime(el.value))));
  el.addEventListener('change', () => {
    const t = parseTime(el.value);
    if (Number.isNaN(t)) {
      el.value = formatTimecode(value);
      el.classList.remove('invalid');
      return;
    }
    onCommit(t);
  });
  el.addEventListener('keydown', (e) => e.key === 'Enter' && el.blur());
  return el;
}

function numberInput(value, onCommit, { min = 0, max = 999, step = 0.1, label } = {}) {
  const el = h('input', { type: 'number', min, max, step, 'aria-label': label });
  el.value = value;
  el.addEventListener('change', () => {
    const v = Number(el.value);
    if (Number.isFinite(v)) onCommit(Math.min(max, Math.max(min, v)));
  });
  return el;
}

function colorInput(value, onCommit, label) {
  const el = h('input', { type: 'color', 'aria-label': label });
  el.value = value || '#ffffff';
  el.addEventListener('change', () => onCommit(el.value));
  return el;
}

export function mountProperties(root, app) {
  const { store, media, actions } = app;
  const head = h('div', { class: 'panel-head' }, h('h2', { class: 'panel-title' }, 'Properties'));
  const body = h('div', { class: 'props' });
  root.append(head, body);

  /** Slider that previews live and records one undo step on release. */
  function slider(value, { min, max, step, format, label }, apply) {
    const out = h('span', { class: 'value' }, format(value));
    const input = h('input', { type: 'range', min, max, step, 'aria-label': label });
    input.value = value;
    let g = null;
    input.addEventListener('input', () => {
      if (!g) g = store.gesture(label);
      const v = Number(input.value);
      out.textContent = format(v);
      g.apply((p) => apply(p, v));
      app.player.requestRender();
    });
    input.addEventListener('change', () => {
      g && g.end();
      g = null;
    });
    return [input, out];
  }

  const edit = (label, fn) => store.commit(label, fn);
  const editClip = (id, label, fn) =>
    edit(label, (p) => {
      const c = getClip(p, id);
      if (!c) return false;
      return fn(c, p);
    });

  // ---------- nothing selected: movie settings ----------
  function renderProject() {
    const p = store.project;
    clear(head).append(h('h2', { class: 'panel-title' }, 'Movie settings'));
    const d = movieDuration(p);
    body.append(
      h('h3', {}, 'Movie'),
      field('Name', textInput(p.name, (v) => edit('Rename movie', (pp) => void (pp.name = v.trim() || 'Untitled movie')), { label: 'Movie name' })),
      field('Length', h('span', { class: 'value', style: { textAlign: 'left' } }, d ? formatHMS(d) : 'Empty')),
      field('Frame rate', select([[24, '24 fps'], [25, '25 fps'], [30, '30 fps'], [50, '50 fps'], [60, '60 fps']], p.settings.fps, (v) => edit('Change frame rate', (pp) => void (pp.settings.fps = Number(v))), 'Frame rate')),
      field('Output size', select(RESOLUTIONS.map((r) => [r.id, r.label]), p.export.resolution, (v) => edit('Change output size', (pp) => void (pp.export.resolution = v)), 'Output size')),
      h('h3', {}, 'Sound'),
      check('Even out volume between clips', p.settings.evenOutVolume, (v) => edit('Even out volume', (pp) => void (pp.settings.evenOutVolume = v))),
      h('p', { class: 'note' }, 'Brings clips recorded on different devices to a similar loudness.'),
      h('h3', {}, 'Editing'),
      check('Snap clips to edges, markers and the playhead', p.settings.snapping, (v) => edit('Snapping', (pp) => void (pp.settings.snapping = v))),
      check('Show safe-zone guide in the preview', p.settings.safeZone, (v) => edit('Safe zone', (pp) => void (pp.settings.safeZone = v))),
    );
    renderStorage();
  }

  async function renderStorage() {
    const box = h('div', {});
    body.append(h('h3', {}, 'Storage on this computer'), box);
    const { usage, quota } = await storage.usage();
    const persisted = await storage.isPersisted();
    const cached = await converterCached().catch(() => false);
    const pct = quota ? Math.min(100, (usage / quota) * 100) : 0;
    clear(box).append(
      h('div', { class: 'meter', title: `${pct.toFixed(1)}% of the space this browser allows` }, h('div', { style: { width: `${Math.max(1, pct)}%` } })),
      h('p', { class: 'note' }, `${formatBytes(usage)} used${quota ? ` of ${formatBytes(quota)} available` : ''}. ${persisted ? 'Protected from automatic clearing.' : 'The browser may clear this if disk space runs low.'}`),
      h(
        'div',
        { class: 'btn-row' },
        button('Clean up unused media', { cls: 'btn-small', onClick: () => actions.cleanUp().then(() => render()) }),
        persisted ? null : button('Keep my files', { cls: 'btn-small', title: 'Ask the browser not to clear stored media', onClick: async () => ((await storage.persist()) ? toast('The browser will keep your stored media.') : toast('The browser declined. Installing Cutline as an app usually allows it.'), render()) }),
      ),
      h('p', { class: 'note' }, cached ? 'The format converter is available offline.' : 'Unusual formats need a one-time 32 MB converter download.'),
      cached
        ? null
        : button('Download converter for offline use', {
            cls: 'btn-small',
            onClick: async (e) => {
              const b = e.currentTarget;
              b.disabled = true;
              try {
                await cacheConverter((p) => (b.textContent = `Downloading… ${Math.round(p * 100)}%`));
                toast('The converter is ready for offline use.');
              } catch {
                toast('Couldn’t download the converter. Check your connection and try again.', { kind: 'error' });
              }
              render();
            },
          }),
    );
  }

  // ---------- workspace item ----------
  function renderBinItem(item) {
    const m = store.project.media[item.mediaId];
    if (!m) return;
    const st = media.getStatus(m.id);
    clear(head).append(h('h2', { class: 'panel-title' }, item.name));
    body.append(h('div', { class: 'kind-chip' }, icon(TYPE_ICON[m.kind === 'audio' ? 'audio' : m.kind] || 'film', 14), m.kind === 'audio' ? 'Music / sound' : m.kind === 'image' ? 'Photo' : 'Video'));
    const rows = [];
    if (item.parentId) rows.push(field('Range', h('span', {}, `${formatTimecode(item.in)} – ${formatTimecode(item.out ?? m.duration)}`)));
    if (m.kind !== 'image') rows.push(field('Length', h('span', {}, formatHMS((item.out ?? m.duration) - (item.in || 0)))));
    if (m.width) rows.push(field('Size', h('span', {}, `${m.width} × ${m.height}`)));
    rows.push(field('File', h('span', { class: 'bin-name', title: m.name }, m.name)));
    if (m.size) rows.push(field('File size', h('span', {}, formatBytes(m.size))));
    if (m.recordedAt) rows.push(field(m.recordedAtSource === 'metadata' ? 'Recorded' : 'Modified', h('span', {}, formatStamp(m.recordedAt))));
    if (m.kind === 'video') rows.push(field('Sound', h('span', {}, st.analyzing ? 'Checking…' : m.hasAudio ? 'Yes' : 'None')));
    body.append(...rows);
    if (m.converted) body.append(h('p', { class: 'note' }, 'Converted on import so this browser can play it.'));
    if (st.state === 'error') body.append(h('div', { class: 'warning-box' }, st.message));
    if (item.parentId)
      body.append(
        field(
          'Name',
          textInput(item.name, (v) =>
            edit('Rename clip', (p) => {
              const b = p.bin.find((x) => x.id === item.id);
              if (b) b.name = v.trim() || b.name;
            }),
          ),
        ),
      );
    const btns = h('div', { class: 'btn-row' });
    if (st.state === 'ready') {
      btns.append(button('Add to movie', { cls: 'btn-small', primary: true, onClick: () => actions.addBinItem(item.id) }));
      if (m.kind !== 'image') btns.append(button('Trim in preview', { cls: 'btn-small', onClick: () => app.openSource(item.id) }));
      if (m.kind === 'video' && !item.parentId) btns.append(button('Split into scenes', { cls: 'btn-small', onClick: () => actions.splitIntoScenes(item.id) }));
    }
    if (st.state === 'missing' || st.state === 'error') btns.append(button('Relink file…', { cls: 'btn-small', iconName: 'link', onClick: () => actions.relink(m.id) }));
    body.append(btns);
  }

  // ---------- clips ----------
  function timingSection(c) {
    const p = store.project;
    const [s, e] = effectiveRange(p, c);
    const mediaDur = c.mediaId ? p.media[c.mediaId]?.duration || Infinity : Infinity;
    const out = [h('h3', {}, 'Timing')];
    if (c.track === 'overlay') {
      out.push(check('Show for the whole movie', c.spanAll, (v) => actions.setSpanAll(c.id, v)));
      if (c.spanAll) return out;
    }
    out.push(
      field(
        'Start',
        timeInput(s, (t) => editClip(c.id, 'Change start', (cc, pp) => app.moveClipTo(pp, cc, t)), 'Start time'),
      ),
      field(
        'End',
        timeInput(e, (t) => editClip(c.id, 'Change end', (cc, pp) => trimClip(pp, cc.id, 'end', t, cc.type === 'video' || cc.type === 'audio' ? mediaDur : Infinity)), 'End time'),
      ),
      field(
        'Duration',
        timeInput(e - s, (d) => editClip(c.id, 'Change duration', (cc, pp) => trimClip(pp, cc.id, 'end', cc.start + d, cc.type === 'video' || cc.type === 'audio' ? mediaDur : Infinity)), 'Duration'),
      ),
    );
    return out;
  }

  function fadeSection(c) {
    const max = Math.max(0, Math.min(10, c.duration / 2));
    return [
      field(
        'Fade in',
        numberInput(c.fadeIn, (v) => editClip(c.id, 'Fade in', (cc) => void (cc.fadeIn = Math.min(v, cc.duration))), { max, label: 'Fade in seconds' }),
        h('span', { class: 'value' }, 'sec'),
      ),
      field(
        'Fade out',
        numberInput(c.fadeOut, (v) => editClip(c.id, 'Fade out', (cc) => void (cc.fadeOut = Math.min(v, cc.duration))), { max, label: 'Fade out seconds' }),
        h('span', { class: 'value' }, 'sec'),
      ),
    ];
  }

  function transitionSection(c) {
    const seam = seams(store.project).find((s) => s.b.id === c.id);
    const out = [h('h3', {}, 'Transition into this clip')];
    if (!seam) {
      out.push(h('p', { class: 'note' }, 'Transitions need this clip to touch the one before it.'));
      return out;
    }
    const tr = c.transition;
    out.push(
      field(
        'Type',
        select([['', 'None (cut)'], ...TRANSITIONS.map((t) => [t.id, t.label])], tr?.type || '', (v) => edit('Change transition', (p) => app.setTransition(p, c.id, v || null, tr?.duration || 1)), 'Transition'),
      ),
    );
    if (tr)
      out.push(
        field(
          'Length',
          numberInput(tr.duration, (v) => edit('Transition length', (p) => app.setTransition(p, c.id, tr.type, v)), { min: 0.1, max: maxTransition(seam), step: 0.1, label: 'Transition seconds' }),
          h('span', { class: 'value' }, 'sec'),
        ),
      );
    return out;
  }

  function volumeSection(c) {
    const out = [h('h3', {}, 'Sound')];
    const [range, val] = slider(c.volume ?? 1, { min: 0, max: 2, step: 0.05, label: 'Volume', format: (v) => `${Math.round(v * 100)}%` }, (p, v) => {
      const cc = getClip(p, c.id);
      if (cc) cc.volume = v;
    });
    out.push(field('Volume', range, val), check('Mute', c.muted, (v) => editClip(c.id, v ? 'Mute' : 'Unmute', (cc) => void (cc.muted = v))));
    return out;
  }

  function renderClip(c) {
    const p = store.project;
    const m = c.mediaId ? p.media[c.mediaId] : null;
    const isOverlay = c.track === 'overlay';
    const kindLabel = isOverlay ? OVERLAY_KINDS.find((k) => k.id === c.kind)?.label || 'Overlay' : TYPE_LABEL[c.type];
    clear(head).append(h('h2', { class: 'panel-title' }, c.name || kindLabel));
    body.append(h('div', { class: 'kind-chip' }, icon(isOverlay ? OVERLAY_ICON[c.kind] || 'text' : TYPE_ICON[c.type], 14), kindLabel, m && media.getStatus(m.id).state === 'missing' ? h('span', { class: 'warn', style: { color: 'var(--danger)' } }, ' · file missing') : null));

    if (c.type === 'title') {
      body.append(h('h3', {}, 'Title'));
      body.append(h('div', { class: 'field stack' }, textInput(c.title.text, (v) => editClip(c.id, 'Edit title', (cc) => void (cc.title.text = v)), { label: 'Title text', multiline: true })));
      body.append(
        field('Font', select(FONTS.map((f) => [f.id, f.label]), c.title.font, (v) => editClip(c.id, 'Title font', (cc) => void (cc.title.font = v)), 'Font')),
        field('Size', numberInput(c.title.size, (v) => editClip(c.id, 'Title size', (cc) => void (cc.title.size = v)), { min: 16, max: 300, step: 2, label: 'Text size' })),
        field('Text color', colorInput(c.title.color, (v) => editClip(c.id, 'Title color', (cc) => void (cc.title.color = v)), 'Text color')),
        field('Background', colorInput(c.title.bg, (v) => editClip(c.id, 'Title background', (cc) => void (cc.title.bg = v)), 'Background color')),
      );
    }

    body.append(...timingSection(c));
    body.append(...fadeSection(c));

    if (c.type === 'video') {
      body.append(...volumeSection(c));
      const btns = h('div', { class: 'btn-row' });
      if (m?.hasAudio && !c.muted) btns.append(button('Detach audio', { cls: 'btn-small', title: 'Move the sound to the music track as its own clip', onClick: () => actions.detachAudio(c.id) }));
      body.append(btns);
      if (m && !m.hasAudio) body.append(h('p', { class: 'note' }, 'This video has no sound.'));
    }
    if (c.type === 'audio') {
      body.append(...volumeSection(c));
      body.append(check('Dim under video sound', c.dimEnabled, (v) => editClip(c.id, 'Music dimming', (cc) => void (cc.dimEnabled = v))));
      if (c.dimEnabled) {
        const [r, val] = slider(c.dimLevel ?? 0.25, { min: 0, max: 1, step: 0.05, label: 'Dim level', format: (v) => `${Math.round(v * 100)}%` }, (pp, v) => {
          const cc = getClip(pp, c.id);
          if (cc) cc.dimLevel = v;
        });
        body.append(field('Dim to', r, val), h('p', { class: 'note' }, 'Music drops to this level while a video clip with sound plays.'));
      }
    }
    if (c.track === 'video') body.append(...transitionSection(c));
    if (isOverlay) renderOverlayProps(c);

    body.append(h('h3', {}, 'Clip'), field('Name', textInput(c.name, (v) => editClip(c.id, 'Rename clip', (cc) => void (cc.name = v)), { label: 'Clip name' })));
    const btns = h('div', { class: 'btn-row' });
    btns.append(
      button('Split at playhead', { cls: 'btn-small', iconName: 'split', onClick: () => actions.splitAtPlayhead() }),
      button('Duplicate', { cls: 'btn-small', onClick: () => actions.duplicate([c.id]) }),
      button('Delete', { cls: 'btn-small', iconName: 'trash', onClick: () => actions.deleteSelection() }),
    );
    body.append(btns);
  }

  function renderOverlayProps(c) {
    const pr = c.props;
    const set = (label, fn) => editClip(c.id, label, (cc) => void fn(cc.props, cc));
    body.append(h('h3', {}, 'Appearance'));
    const [op, opv] = slider(c.opacity ?? 1, { min: 0.05, max: 1, step: 0.05, label: 'Opacity', format: (v) => `${Math.round(v * 100)}%` }, (p, v) => {
      const cc = getClip(p, c.id);
      if (cc) cc.opacity = v;
    });
    body.append(field('Opacity', op, opv));
    if (['clock', 'image', 'part', 'date', 'text', 'lowerthird'].includes(c.kind)) {
      body.append(
        field(
          'Position',
          select(
            [
              ['tl', 'Top left'],
              ['tr', 'Top right'],
              ['bl', 'Bottom left'],
              ['br', 'Bottom right'],
              ['', 'Where I dragged it'],
            ],
            c.corner || '',
            (v) => editClip(c.id, 'Move overlay', (cc) => void (cc.corner = v || null)),
            'Position',
          ),
        ),
      );
    }
    const fontSel = (label = 'Font') => field(label, select(FONTS.map((f) => [f.id, f.label]), pr.font || 'sans', (v) => set('Font', (x) => (x.font = v)), 'Font'));
    const sizeIn = (min = 12, max = 200) => field('Size', numberInput(pr.size, (v) => set('Size', (x) => (x.size = v)), { min, max, step: 2, label: 'Text size' }));
    const colorIn = (key = 'color', label = 'Color') => field(label, colorInput(pr[key], (v) => set('Color', (x) => (x[key] = v)), label));

    switch (c.kind) {
      case 'clock':
        body.append(
          field('Start at', timeInput(pr.startAt || 0, (t) => set('Clock start', (x) => (x.startAt = Math.floor(t))), 'Clock start value')),
          check('Restart at 0:00:00 in each part', pr.restartEachPart, (v) => set('Clock restart', (x) => (x.restartEachPart = v))),
          h('p', { class: 'note' }, 'Off by default, so part 2 of a 30-second split opens at 0:00:30.'),
          sizeIn(),
          colorIn(),
          fontSel(),
          check('Background box', pr.box, (v) => set('Clock box', (x) => (x.box = v))),
        );
        break;
      case 'part':
        body.append(h('p', { class: 'note' }, 'Shows “Part 2 of 6” on each file when exporting with Split. Turn on split in Export to see it in the preview.'), sizeIn(), colorIn(), check('Background box', pr.box, (v) => set('Part box', (x) => (x.box = v))));
        break;
      case 'image':
        body.append(
          field(
            'Width',
            ...slider(pr.width, { min: 0.03, max: 1, step: 0.01, label: 'Logo width', format: (v) => `${Math.round(v * 100)}%` }, (p, v) => {
              const cc = getClip(p, c.id);
              if (cc) cc.props.width = v;
            }),
          ),
          button('Choose a different image…', {
            cls: 'btn-small',
            onClick: async () => {
              const id = await actions.pickLogo();
              if (id) editClip(c.id, 'Change logo', (cc) => void (cc.mediaId = id));
            },
          }),
        );
        break;
      case 'text':
        body.append(
          h('div', { class: 'field stack' }, textInput(pr.text, (v) => set('Edit text', (x) => (x.text = v)), { label: 'Text', multiline: true })),
          fontSel(),
          sizeIn(),
          colorIn(),
          check('Background box', pr.box, (v) => set('Text box', (x) => (x.box = v))),
          pr.box ? colorIn('boxColor', 'Box color') : null,
        );
        break;
      case 'lowerthird':
        body.append(
          field('Name', textInput(pr.text, (v) => set('Edit lower third', (x) => (x.text = v)), { label: 'Main line' })),
          field('Caption', textInput(pr.subtext, (v) => set('Edit lower third', (x) => (x.subtext = v)), { label: 'Caption line' })),
          fontSel(),
          sizeIn(),
          colorIn('color', 'Text color'),
          colorIn('barColor', 'Bar color'),
        );
        break;
      case 'blur':
        body.append(
          field(
            'Effect',
            select(
              [
                ['blur', 'Blur'],
                ['pixelate', 'Pixelate'],
              ],
              pr.mode,
              (v) => set('Blur effect', (x) => (x.mode = v)),
              'Effect',
            ),
          ),
          field(
            'Strength',
            ...slider(pr.strength, { min: 2, max: 60, step: 1, label: 'Strength', format: (v) => String(v) }, (p, v) => {
              const cc = getClip(p, c.id);
              if (cc) cc.props.strength = v;
            }),
          ),
          h('p', { class: 'note' }, 'Drag the box in the preview to cover what you want hidden. Drag its corner handle to resize.'),
        );
        break;
      case 'subtitles':
        body.append(fontSel(), sizeIn(), colorIn(), check('Background box', pr.box, (v) => set('Subtitle box', (x) => (x.box = v))));
        body.append(h('h3', {}, `Lines (${pr.cues.length})`));
        body.append(
          h(
            'div',
            { class: 'cue-list' },
            ...pr.cues.map((q, i) =>
              h(
                'div',
                { class: 'cue' },
                h('span', {}, formatTimecode(q.start + c.start)),
                textInput(q.text, (v) => set('Edit subtitle', (x) => (x.cues[i].text = v)), { label: `Subtitle ${i + 1}`, multiline: true }),
              ),
            ),
          ),
        );
        break;
      case 'shape':
        body.append(
          field(
            'Shape',
            select(
              [
                ['arrow', 'Arrow'],
                ['rect', 'Rectangle'],
                ['ellipse', 'Circle / ellipse'],
              ],
              pr.shape,
              (v) => set('Shape', (x) => (x.shape = v)),
              'Shape',
            ),
          ),
          colorIn(),
          field('Line width', numberInput(pr.lineWidth, (v) => set('Line width', (x) => (x.lineWidth = v)), { min: 1, max: 60, step: 1, label: 'Line width' })),
          field(
            'Rotation',
            ...slider(pr.angle || 0, { min: -180, max: 180, step: 5, label: 'Rotation', format: (v) => `${v}°` }, (p, v) => {
              const cc = getClip(p, c.id);
              if (cc) cc.props.angle = v;
            }),
          ),
          pr.shape !== 'arrow' ? check('Filled', pr.fill, (v) => set('Fill', (x) => (x.fill = v))) : null,
        );
        break;
      case 'date':
        body.append(
          field(
            'Date from',
            select(
              [
                ['auto', 'Each clip’s recording date'],
                ['manual', 'A date I enter'],
              ],
              pr.mode,
              (v) => set('Date source', (x) => (x.mode = v)),
              'Date source',
            ),
          ),
          pr.mode === 'manual' ? field('Date', (() => {
            const el = h('input', { type: 'datetime-local', step: 1, 'aria-label': 'Date and time' });
            el.value = pr.manual || '';
            el.addEventListener('change', () => set('Date', (x) => (x.manual = el.value)));
            return el;
          })()) : h('p', { class: 'note' }, 'Uses the date saved in each video file. Files without one use their last-modified date; choose “A date I enter” if that’s wrong.'),
          field(
            'Show',
            select(
              [
                ['datetime', 'Date and time'],
                ['date', 'Date only'],
              ],
              pr.format,
              (v) => set('Date format', (x) => (x.format = v)),
              'Date format',
            ),
          ),
          sizeIn(),
          colorIn(),
        );
        break;
      default:
        break;
    }
    body.append(h('div', { class: 'btn-row' }, button('Bring to front', { cls: 'btn-small', onClick: () => actions.front(c.id) }), button('Send to back', { cls: 'btn-small', onClick: () => actions.back(c.id) })));
  }

  function renderMulti(clips) {
    clear(head).append(h('h2', { class: 'panel-title' }, `${clips.length} items selected`));
    body.append(
      h('p', { class: 'note' }, 'Drag any of them on the timeline to move them together.'),
      h('div', { class: 'btn-row' }, button('Duplicate', { cls: 'btn-small', onClick: () => actions.duplicate() }), button('Delete', { cls: 'btn-small', iconName: 'trash', onClick: () => actions.deleteSelection() })),
    );
  }

  let queued = false;
  function render() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      // Don't rebuild while the user is typing in a field.
      const active = document.activeElement;
      if (root.contains(active) && (active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && !['checkbox', 'color'].includes(active.type)))) {
        pendingWhileFocused = true;
        return;
      }
      const scroll = body.scrollTop;
      clear(body);
      const sel = [...store.selection];
      const clips = store.selectedClips();
      const bin = store.project.bin.filter((b) => store.selection.has(b.id));
      if (clips.length === 1 && sel.length === 1) renderClip(clips[0]);
      else if (clips.length > 1) renderMulti(clips);
      else if (bin.length === 1) renderBinItem(bin[0]);
      else if (bin.length > 1) {
        clear(head).append(h('h2', { class: 'panel-title' }, `${bin.length} items selected`));
        body.append(h('div', { class: 'btn-row' }, button('Remove from workspace', { cls: 'btn-small', onClick: () => actions.removeBinItems(bin.map((b) => b.id)) })));
      } else renderProject();
      body.scrollTop = scroll;
    });
  }
  let pendingWhileFocused = false;
  root.addEventListener('focusout', () => {
    if (pendingWhileFocused) {
      pendingWhileFocused = false;
      setTimeout(render, 0);
    }
  });

  store.on('change', render);
  store.on('select', render);
  store.on('media', () => {
    if (store.selection.size) render();
  });
  render();

  return {
    focus() {
      const first = body.querySelector('input, textarea, select');
      first && first.focus();
    },
  };
}

