import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { openApp, importFiles, waitForMedia, project, videoClips, dragToTimeline, expectNoErrors } from './helpers.js';

test.describe('Cutline features', () => {
  test('music dims to 25% under video sound in the exported mix', async ({ page }) => {
    const errors = await openApp(page);
    await importFiles(page, ['clip-b.mp4', 'tone.wav']);
    await waitForMedia(page, 2);
    await dragToTimeline(page, 0, 'video', 0);
    await dragToTimeline(page, 1, 'music', 0);
    const ratio = await page.evaluate(async () => {
      const { store, media } = window.cutline;
      // A nearly silent video clip still counts as "sound playing", so only the music is measured.
      store.commit('test', (p) => {
        p.clips.find((c) => c.type === 'video').volume = 0.0001;
      });
      const { renderAudio } = await import('./js/engine/exporter.js');
      const buf = await renderAudio(store.project, media, 0, 4);
      const rms = (a, b) => {
        const d = buf.getChannelData(0).subarray(Math.floor(a * 48000), Math.floor(b * 48000));
        let s = 0;
        for (const v of d) s += v * v;
        return Math.sqrt(s / d.length);
      };
      return rms(0.7, 1.9) / rms(2.7, 3.9);
    });
    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(0.3);
    await expectNoErrors(errors);
  });

  test('overlays can be dragged into place in the preview', async ({ page }) => {
    const errors = await openApp(page);
    await importFiles(page, ['clip-a.webm']);
    await waitForMedia(page, 1);
    await dragToTimeline(page, 0, 'video', 0);
    await page.evaluate(() => window.cutline.seek(1));
    await page.getByRole('tab', { name: 'Overlays' }).click();
    await page.locator('.tile', { hasText: 'Running clock' }).click();
    await page.waitForTimeout(300);
    const { box, id } = await page.evaluate(() => {
      const b = window.cutline.player.boxes.find((x) => x.kind === 'clock');
      return { box: b.box, id: b.id };
    });
    const canvas = await page.locator('.preview-stage canvas').boundingBox();
    const W = await page.evaluate(() => window.cutline.player.size.width);
    const s = canvas.width / W;
    const x = canvas.x + (box.x + box.w / 2) * s;
    const y = canvas.y + (box.y + box.h / 2) * s;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - canvas.width * 0.4, y - canvas.height * 0.4, { steps: 8 });
    await page.mouse.up();
    const clock = (await project(page)).clips.find((c) => c.id === id);
    expect(clock.corner).toBeNull();
    expect(clock.x).toBeLessThan(0.6);
    // One undo step puts it back in its corner.
    await page.locator('.tl-body').focus();
    await page.keyboard.press('Control+z');
    expect((await project(page)).clips.find((c) => c.id === id).corner).toBe('br');
    await expectNoErrors(errors);
  });

  test('finds scenes and trims a clip in the preview before adding it', async ({ page }) => {
    const errors = await openApp(page);
    await importFiles(page, ['scenes.mp4']);
    await waitForMedia(page, 1);
    await page.locator('.bin-item').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Split into scenes' }).click();
    await expect(page.locator('.bin-item.child')).toHaveCount(3);
    const scenes = (await project(page)).bin.filter((b) => b.parentId).map((b) => [Math.round(b.in), Math.round(b.out)]);
    expect(scenes).toEqual([
      [0, 2],
      [2, 4],
      [4, 6],
    ]);

    await page.locator('.bin-item.child').nth(1).dblclick();
    await expect(page.getByText('Trimming')).toBeVisible();
    // A scene opens at its own start.
    await page.waitForFunction(() => document.querySelector('.preview-stage video')?.readyState >= 1);
    expect(await page.evaluate(() => document.querySelector('.preview-stage video').currentTime)).toBeCloseTo(2, 1);
    // Seek, wait for the seek to land, then set In.
    await page.evaluate(() => (document.querySelector('.preview-stage video').currentTime = 2.5));
    await page.waitForFunction(() => {
      const v = document.querySelector('.preview-stage video');
      return !v.seeking && Math.abs(v.currentTime - 2.5) < 0.01;
    });
    await page.keyboard.press('i');
    await expect.poll(() => page.evaluate(() => window.cutline.store.view.sourceIn)).toBeCloseTo(2.5, 1);
    await page.getByRole('button', { name: 'Add selection to movie' }).click();
    const [clip] = await videoClips(page);
    expect(clip.in).toBeCloseTo(2.5, 1);
    expect(clip.duration).toBeCloseTo(1.5, 1);
    await page.getByRole('button', { name: 'Back to movie' }).click();
    await expectNoErrors(errors);
  });

  test('exports WebM', async ({ page }) => {
    const errors = await openApp(page);
    await importFiles(page, ['clip-a.webm']);
    await waitForMedia(page, 1);
    await dragToTimeline(page, 0, 'video', 0);
    await page.getByRole('button', { name: 'Export' }).click();
    await page.locator('input[value="single"]').check();
    await page.getByLabel('Format').selectOption('webm');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), page.locator('#export-start').click()]);
    expect(dl.suggestedFilename()).toBe('untitled_movie.webm');
    const buf = fs.readFileSync(await dl.path());
    expect(buf.readUInt32BE(0)).toBe(0x1a45dfa3);
    await expectNoErrors(errors);
  });

  test('storyboard reorders clips and takes transitions', async ({ page }) => {
    const errors = await openApp(page);
    await importFiles(page, ['clip-a.webm', 'photo.png']);
    await waitForMedia(page, 2);
    await page.getByRole('button', { name: 'Storyboard' }).click();
    await page.locator('.bin-item').nth(0).dragTo(page.locator('.sb-gap').first());
    await page.locator('.bin-item').nth(1).dragTo(page.locator('.sb-gap').last());
    await expect(page.locator('.sb-card')).toHaveCount(2);
    let clips = await videoClips(page);
    expect(clips.map((c) => c.type)).toEqual(['video', 'image']);
    // Drag the photo card in front of the video.
    await page.locator('.sb-card').nth(1).dragTo(page.locator('.sb-gap').first());
    clips = await videoClips(page);
    expect(clips.map((c) => c.type)).toEqual(['image', 'video']);
    expect(clips[1].start).toBeCloseTo(clips[0].duration, 3);
    await page.getByRole('tab', { name: 'Transitions' }).click();
    await page.locator('.tile', { hasText: 'Wipe' }).dragTo(page.locator('.sb-slot').first());
    expect((await videoClips(page))[1].transition.type).toBe('wipe');
    await expectNoErrors(errors);
  });
});
