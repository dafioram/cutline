import { test, expect } from '@playwright/test';
import { openApp, importFiles, waitForMedia, expectNoErrors, settle } from './helpers.js';

/** Average brightness of the preview canvas (0–255). */
const brightness = (page) =>
  page.evaluate(() => {
    const c = document.querySelector('.preview-stage canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4 * 97) {
      sum += d[i] + d[i + 1] + d[i + 2];
      n++;
    }
    return sum / n / 3;
  });

test('the preview keeps showing pictures while dragging the playhead', async ({ page }) => {
  const errors = await openApp(page);
  await importFiles(page, ['scrub.mp4']);
  await waitForMedia(page, 1);
  await page.evaluate(() => {
    const { actions, store } = window.cutline;
    actions.addBinItem(store.project.bin[0].id);
    store.setView({ pxPerSec: 60 });
  });
  await settle(page);
  await expect.poll(() => brightness(page)).toBeGreaterThan(20);

  const ruler = await page.locator('.tl-ruler').boundingBox();
  await page.mouse.move(ruler.x + 5, ruler.y + 10);
  await page.mouse.down();
  const samples = [];
  for (let i = 1; i <= 40; i++) {
    await page.mouse.move(ruler.x + 5 + i * 15, ruler.y + 10);
    await page.waitForTimeout(16);
    samples.push(await brightness(page));
  }
  await page.mouse.up();
  expect(samples.filter((b) => b < 8)).toEqual([]);
  await expectNoErrors(errors);
});
