import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
export const fixture = (name) => path.join(FIXTURES, name);

/** Open the app in test mode (downloads instead of the save picker) and collect page errors. */
export async function openApp(page, { url = '?test' } = {}) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(url);
  await page.waitForSelector('body[data-ready="true"]');
  return errors;
}

export async function importFiles(page, names) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import', exact: true }).click()]);
  await chooser.setFiles(names.map(fixture));
}

/** Wait until every imported media file finished importing (and sound analysis finished). */
export async function waitForMedia(page, count) {
  await page.waitForFunction(
    (n) => {
      const { store, media } = window.cutline;
      const ids = Object.keys(store.project.media);
      return ids.length >= n && ids.every((id) => media.getStatus(id).state === 'ready' && !media.getStatus(id).analyzing);
    },
    count,
    { timeout: 60_000 },
  );
}

/** Wait until queued re-renders (they run on the next animation frame) have finished. */
export const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** Bounding box of an element, retried until it is attached and visible after any re-render. */
export async function boxOf(page, locator) {
  let box = null;
  await expect
    .poll(async () => {
      await settle(page);
      box = await locator.boundingBox().catch(() => null);
      return box !== null;
    })
    .toBe(true);
  return box;
}

export const project = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.cutline.store.project)));

export const videoClips = async (page) => (await project(page)).clips.filter((c) => c.track === 'video').sort((a, b) => a.start - b.start);

/** Drag the n-th workspace item onto a lane at a time in seconds. */
export async function dragToTimeline(page, binIndex, lane, seconds) {
  const px = await page.evaluate(() => window.cutline.store.view.pxPerSec);
  const target = page.locator(`.tl-lane.${lane}`).first();
  await page.locator('.bin-item').nth(binIndex).dragTo(target, { targetPosition: { x: Math.max(1, seconds * px + 1), y: 20 } });
}

/** File names stored in a zip (reads the central directory). */
export function zipEntries(buf) {
  const names = [];
  for (let i = 0; i < buf.length - 46; i++) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x01 && buf[i + 3] === 0x02) {
      const nameLen = buf.readUInt16LE(i + 28);
      const extraLen = buf.readUInt16LE(i + 30);
      const commentLen = buf.readUInt16LE(i + 32);
      names.push(buf.toString('utf8', i + 46, i + 46 + nameLen));
      i += 45 + nameLen + extraLen + commentLen;
    }
  }
  return names;
}

export async function expectNoErrors(errors) {
  expect(errors.filter((e) => !/favicon|net::ERR/.test(e))).toEqual([]);
}
