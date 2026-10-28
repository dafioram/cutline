import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { openApp, waitForMedia, project, videoClips, fixture, expectNoErrors } from './helpers.js';

/** Simulate dropping files from the desktop onto an element. */
async function dropFiles(page, selector, names, offsetX = 40) {
  const list = names.map((n) => ({ name: n, b64: fs.readFileSync(fixture(n)).toString('base64'), type: n.endsWith('.webm') ? 'video/webm' : n.endsWith('.mp4') ? 'video/mp4' : 'image/png' }));
  const dataTransfer = await page.evaluateHandle((files) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
    return dt;
  }, list);
  const box = await page.locator(selector).first().boundingBox();
  const pos = { clientX: box.x + offsetX, clientY: box.y + box.height / 2 };
  for (const type of ['dragenter', 'dragover', 'drop']) await page.dispatchEvent(selector, type, { dataTransfer, ...pos });
}

test.describe('Dropping files from the desktop', () => {
  test('one or several files onto the workspace import once each', async ({ page }) => {
    const errors = await openApp(page);
    await dropFiles(page, '#workspace', ['clip-a.webm']);
    await waitForMedia(page, 1);
    await dropFiles(page, '#workspace', ['clip-b.mp4', 'scenes.mp4', 'photo.png']);
    await waitForMedia(page, 4);
    await expect(page.locator('.bin-item')).toHaveCount(4);
    expect((await project(page)).clips).toHaveLength(0);
    await expectNoErrors(errors);
  });

  test('several videos onto the timeline land back to back in order', async ({ page }) => {
    const errors = await openApp(page);
    await dropFiles(page, '.tl-lane.video', ['clip-a.webm', 'clip-b.mp4'], 5);
    await expect.poll(async () => (await videoClips(page)).length).toBe(2);
    const clips = await videoClips(page);
    expect(clips.map((c) => c.name)).toEqual(['clip-a.webm', 'clip-b.mp4']);
    expect(clips[1].start).toBeCloseTo(clips[0].start + clips[0].duration, 3);
    expect((await project(page)).bin).toHaveLength(2);
    await expectNoErrors(errors);
  });

  test('several videos onto the storyboard', async ({ page }) => {
    const errors = await openApp(page);
    await page.getByRole('button', { name: 'Storyboard' }).click();
    await dropFiles(page, '.sb-gap', ['clip-a.webm', 'clip-b.mp4'], 2);
    await expect(page.locator('.sb-card')).toHaveCount(2);
    expect((await project(page)).bin).toHaveLength(2);
    await expectNoErrors(errors);
  });
});
