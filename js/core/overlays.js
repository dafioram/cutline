// Overlay geometry helpers (pure). Sizes are given in output pixels.

export const MARGIN = 0.035; // of output height

/** Centre point for a box of size (w, h) placed in a corner of a W x H frame. */
export function cornerCenter(corner, w, h, W, H) {
  const m = Math.round(H * MARGIN);
  const left = m + w / 2;
  const right = W - m - w / 2;
  const top = m + h / 2;
  const bottom = H - m - h / 2;
  switch (corner) {
    case 'tl':
      return { x: left, y: top };
    case 'tr':
      return { x: right, y: top };
    case 'bl':
      return { x: left, y: bottom };
    case 'br':
      return { x: right, y: bottom };
    default:
      return { x: W / 2, y: H / 2 };
  }
}

/** Box (x, y = top-left) for an overlay of size w x h, honoring its corner or free position. */
export function overlayBox(overlay, w, h, W, H) {
  const c = overlay.corner ? cornerCenter(overlay.corner, w, h, W, H) : { x: overlay.x * W, y: overlay.y * H };
  return { x: c.x - w / 2, y: c.y - h / 2, w, h };
}

export function rectsOverlap(a, b, pad = 0) {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

/** Indices of boxes that overlap any other box. */
export function overlappingIndices(boxes) {
  const hit = new Set();
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (rectsOverlap(boxes[i], boxes[j])) {
        hit.add(i);
        hit.add(j);
      }
    }
  }
  return [...hit];
}

/** Nearest corner to a point, used when snapping a dragged corner overlay back into a corner. */
export function nearestCorner(x, y, W, H) {
  const v = y < H / 2 ? 't' : 'b';
  const h = x < W / 2 ? 'l' : 'r';
  return v + h;
}

/** Safe zone: inner 90% of the frame. */
export function safeZone(W, H) {
  return { x: W * 0.05, y: H * 0.05, w: W * 0.9, h: H * 0.9 };
}
