// Sets the service worker's cache VERSION to a hash of the precached files, so every deploy that
// changes the app makes installed copies update. Usage: node scripts/stamp-sw.mjs [siteDir]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = path.resolve(process.argv[2] || '.');
const swPath = path.join(dir, 'sw.js');
let sw = fs.readFileSync(swPath, 'utf8');
const list = /const PRECACHE = \[([\s\S]*?)\];/.exec(sw)[1];
const files = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((f) => f !== './');
const hash = crypto.createHash('sha256');
for (const f of files) {
  hash.update(f);
  hash.update(fs.readFileSync(path.join(dir, f)));
}
const version = `cutline-${hash.digest('hex').slice(0, 12)}`;
sw = sw.replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`);
fs.writeFileSync(swPath, sw);
console.log(`Service worker version: ${version}`);
