// Small shared helpers. No DOM access here so everything in js/core runs under Node for tests.

let counter = 0;

/** Short unique id, stable enough for a single-user project file. */
export function uid(prefix = 'id') {
  counter = (counter + 1) % 1e6;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}

export const EPS = 1e-6;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function round(v, places = 6) {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** True when two numbers are equal within a frame-ish tolerance. */
export function near(a, b, tol = 1e-3) {
  return Math.abs(a - b) <= tol;
}
