// What is being dragged from the workspace (dataTransfer can't be read during dragover).

export const MIME = 'application/x-cutline';

export const drag = {
  payload: null, // {type: 'bin'|'transition'|'overlay'|'title', id?, kind?}
};

export function startDrag(e, payload, label = '') {
  drag.payload = payload;
  e.dataTransfer.effectAllowed = 'copy';
  e.dataTransfer.setData(MIME, JSON.stringify(payload));
  e.dataTransfer.setData('text/plain', label);
}

export function endDrag() {
  drag.payload = null;
}

/** Payload for a drop: our own drag, or OS files. */
export function readDrop(e) {
  const raw = e.dataTransfer.getData(MIME);
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      /* fall through */
    }
  }
  if (e.dataTransfer.files && e.dataTransfer.files.length) return { type: 'files', files: [...e.dataTransfer.files] };
  return drag.payload;
}

export function isFileDrag(e) {
  return [...(e.dataTransfer?.types || [])].includes('Files');
}
