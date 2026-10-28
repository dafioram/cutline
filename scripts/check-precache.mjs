// Checks that the service worker's precache list matches the files the app needs, and that every
// relative import in the app resolves to a real file. Run with `npm run check:sw`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');

function listFrom(name) {
  const m = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(sw);
  if (!m) throw new Error(`Could not find ${name} in sw.js`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}

const precache = listFrom('PRECACHE');
const onDemand = listFrom('ON_DEMAND');
const problems = [];

for (const p of [...precache, ...onDemand]) {
  if (p === './') continue;
  if (!fs.existsSync(path.join(root, p))) problems.push(`Listed in sw.js but missing on disk: ${p}`);
}

const required = new Set(['index.html', 'manifest.webmanifest']);
for (const dir of ['js', 'css', 'vendor']) {
  for (const f of walk(dir)) {
    if (f.startsWith('vendor/licenses/')) continue;
    if (onDemand.includes(f)) continue;
    required.add(f);
  }
}
// Icons referenced by the page or the manifest.
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) if (!m[1].startsWith('http') && !m[1].endsWith('.js') && m[1] !== 'manifest.webmanifest') required.add(m[1]);
for (const icon of manifest.icons) required.add(icon.src);

for (const f of required) {
  if (!precache.includes(f)) problems.push(`Needed offline but not in the sw.js precache list: ${f}`);
}

// Every relative import in the app must resolve.
const importRe = /(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g;
for (const f of walk('js')) {
  if (!f.endsWith('.js')) continue;
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  for (const m of src.matchAll(importRe)) {
    const spec = m[1] || m[2];
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), spec));
    if (!fs.existsSync(path.join(root, target))) problems.push(`${f} imports missing file ${spec}`);
  }
}

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join('\n'));
  process.exit(1);
}
console.log(`✓ Service worker precaches all ${precache.length} app files; ${onDemand.length} large files load on demand. All imports resolve.`);
