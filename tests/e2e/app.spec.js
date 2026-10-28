import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { openApp, importFiles, waitForMedia, project, videoClips, dragToTimeline, zipEntries, expectNoErrors, boxOf } from './helpers.js';

test.describe('Cutline', () => {
  test('loads cleanly with offline support and an install manifest', async ({ page }) => {
    const errors = await openApp(page);
    await expect(page).toHaveTitle(/Cutline/);
    await expect(page.getByText('Drag videos, music and photos here.')).toBeVisible();
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', 'manifest.webmanifest');
    const swReady = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return !!reg.active;
    });
    expect(swReady).toBe(true);
    await expectNoErrors(errors);
  });

  test('imports video, photos, music and subtitles', async ({ page }) => {
    const errors = await openApp(page);
    await importFiles(page, ['clip-a.webm', 'clip-b.mp4', 'photo.png', 'tone.wav', 'subs.srt']);
    await waitForMedia(page, 4);
    await expect(page.locator('.bin-item')).toHaveCount(4);
    const p = await project(page);
    const byName = Object.fromEntries(Object.values(p.media).map((m) => [m.name, m]));
    expect(byName['clip-a.webm'].kind).toBe('video');
    expect(byName['clip-a.webm'].duration).toBeGreaterThan(2.9);
    expect(byName['clip-a.webm'].hasAudio).toBe(true);
    expect(byName['clip-b.mp4'].recordedAt).toBe(Date.UTC(2024, 5, 1, 12, 30, 0));
    expect(byName['clip-b.mp4'].recordedAtSource).toBe('metadata');
    expect(byName['photo.png'].width).toBe(320);
    expect(byName['tone.wav'].kind).toBe('audio');
    const subs = p.clips.find((c) => c.kind === 'subtitles');
    expect(subs.props.cues.map((c) => c.text)).toEqual(['Hello from Cutline', 'Second line']);
    await expectNoErrors(errors);
  });

  test('edits on the timeline: drop, snap, transition, split, undo, delete, trim, menus', async ({ page }) => {
    const errors = await openApp(page);
    await importFiles(page, ['clip-a.webm', 'clip-b.mp4', 'photo.png']);
    await waitForMedia(page, 3);

    await dragToTimeline(page, 0, 'video', 0);
    let clips = await videoClips(page);
    expect(clips).toHaveLength(1);
    const firstEnd = clips[0].start + clips[0].duration;
    // Dropped close to the first clip's end, the second clip snaps onto it.
    await dragToTimeline(page, 1, 'video', firstEnd + 0.05);
    clips = await videoClips(page);
    expect(clips).toHaveLength(2);
    expect(clips[1].start).toBeCloseTo(firstEnd, 2);

    // Cross-fade dropped on the seam.
    await page.getByRole('tab', { name: 'Transitions' }).click();
    const px = await page.evaluate(() => window.cutline.store.view.pxPerSec);
    await page.locator('.tile', { hasText: 'Cross-fade' }).dragTo(page.locator('.tl-lane.video'), { targetPosition: { x: firstEnd * px + 2, y: 30 } });
    clips = await videoClips(page);
    expect(clips[1].transition).toEqual({ type: 'crossfade', duration: 1 });
    await expect(page.locator('.transition-mark')).toHaveCount(1);

    // Split at the playhead, undo, redo.
    await page.evaluate(() => window.cutline.seek(1));
    await page.locator('.tl-body').focus();
    await page.keyboard.press('s');
    expect(await videoClips(page)).toHaveLength(3);
    await page.keyboard.press('Control+z');
    expect(await videoClips(page)).toHaveLength(2);
    await page.keyboard.press('Control+y');
    clips = await videoClips(page);
    expect(clips).toHaveLength(3);

    // Delete the middle piece: the gap closes.
    const second = clips[1];
    await page.locator(`.clip[data-id="${second.id}"]`).click();
    await page.keyboard.press('Delete');
    clips = await videoClips(page);
    expect(clips).toHaveLength(2);
    expect(clips[1].start).toBeCloseTo(1, 2);

    // Trim the first clip by dragging its end handle left.
    const handle = page.locator(`.clip[data-id="${clips[0].id}"] .handle.end`);
    const box = await boxOf(page, handle);
    await page.mouse.move(box.x + 3, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x - 20, box.y + 10, { steps: 5 });
    await page.mouse.up();
    const trimmed = (await videoClips(page))[0];
    expect(trimmed.duration).toBeLessThan(1);

    // Right-click menu adds a fade.
    await page.locator(`.clip[data-id="${clips[1].id}"]`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Fade in' }).click();
    expect((await videoClips(page))[1].fadeIn).toBeGreaterThan(0);

    // Marker and storyboard.
    await page.locator('.tl-body').focus();
    await page.keyboard.press('m');
    expect((await project(page)).markers).toHaveLength(1);
    await page.getByRole('button', { name: 'Storyboard' }).click();
    await expect(page.locator('.sb-card')).toHaveCount(2);
    await page.getByRole('button', { name: 'Timeline' }).click();
    await expect(page.locator('.tl-lane.video .clip')).toHaveCount(2);
    await expectNoErrors(errors);
  });

  test('overlays, title card and freeze frame', async ({ page }) => {
    const errors = await openApp(page);
    await importFiles(page, ['clip-a.webm']);
    await waitForMedia(page, 1);
    await dragToTimeline(page, 0, 'video', 0);
    await page.getByRole('tab', { name: 'Overlays' }).click();
    for (const name of ['Running clock', 'Text label', 'Shape / arrow', 'Blur / pixelate box', 'Date stamp', 'Lower third', 'Part indicator']) {
      await page.locator('.tile', { hasText: name }).click();
    }
    const p = await project(page);
    const kinds = p.clips.filter((c) => c.track === 'overlay').map((c) => c.kind);
    expect(kinds.sort()).toEqual(['blur', 'clock', 'date', 'lowerthird', 'part', 'shape', 'text']);
    // Overlapping overlays stack in separate lanes.
    expect(new Set(p.clips.filter((c) => c.track === 'overlay').map((c) => c.lane)).size).toBeGreaterThan(1);

    await page.locator('.tile', { hasText: 'Title card' }).click();
    expect((await videoClips(page)).some((c) => c.type === 'title')).toBe(true);

    await page.evaluate(() => window.cutline.seek(1.5));
    await page.getByRole('button', { name: 'Freeze', exact: true }).click();
    await expect.poll(async () => (await videoClips(page)).filter((c) => c.name.startsWith('Freeze frame')).length).toBe(1);
    const freeze = (await videoClips(page)).find((c) => c.name.startsWith('Freeze frame'));
    expect(freeze.duration).toBe(3);

    const [png] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save frame' }).click()]);
    expect(png.suggestedFilename()).toMatch(/\.png$/);
    await expectNoErrors(errors);
  });

  test('exports a split movie as a zip of parts named by time range', async ({ page }) => {
    const errors = await openApp(page);
    await importFiles(page, ['clip-a.webm', 'clip-b.mp4', 'tone.wav']);
    await waitForMedia(page, 3);
    await dragToTimeline(page, 0, 'video', 0);
    const first = (await videoClips(page))[0];
    await dragToTimeline(page, 1, 'video', first.duration + 0.05);
    await dragToTimeline(page, 2, 'music', 0);
    await page.getByRole('tab', { name: 'Overlays' }).click();
    await page.locator('.tile', { hasText: 'Running clock' }).click();
    await page.locator('.tile', { hasText: 'Part indicator' }).click();

    await page.getByRole('button', { name: 'Export' }).click();
    await page.locator('input[value="split"]').check();
    await page.getByLabel('Seconds per part').fill('2');
    await expect(page.locator('.dialog .summary')).toContainText('3 parts');
    // Split points appear on the timeline while splitting is on.
    await expect(page.locator('.split-line')).toHaveCount(2);
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), page.locator('#export-start').click()]);
    expect(dl.suggestedFilename()).toBe('untitled_movie_parts.zip');
    const buf = fs.readFileSync(await dl.path());
    expect(zipEntries(buf)).toEqual(['untitled_movie_part01_0000-0002.mp4', 'untitled_movie_part02_0002-0004.mp4', 'untitled_movie_part03_0004-0005.mp4']);
    await expectNoErrors(errors);
  });

  test('exports a single MP4 file', async ({ page }) => {
    const errors = await openApp(page);
    await importFiles(page, ['clip-b.mp4']);
    await waitForMedia(page, 1);
    await dragToTimeline(page, 0, 'video', 0);
    await page.getByRole('button', { name: 'Export' }).click();
    await page.locator('input[value="single"]').check();
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), page.locator('#export-start').click()]);
    expect(dl.suggestedFilename()).toBe('untitled_movie.mp4');
    const buf = fs.readFileSync(await dl.path());
    expect(buf.toString('latin1', 4, 8)).toBe('ftyp');
    await expectNoErrors(errors);
  });

  test('quick share makes a looping GIF under 10 MB', async ({ page }) => {
    const errors = await openApp(page);
    await importFiles(page, ['clip-a.webm']);
    await waitForMedia(page, 1);
    await dragToTimeline(page, 0, 'video', 0);
    await page.getByRole('button', { name: 'Quick share' }).click();
    await expect(page.locator('.dialog .summary')).toContainText('px wide', { timeout: 60_000 });
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), page.locator('#gif-start').click()]);
    const buf = fs.readFileSync(await dl.path());
    expect(buf.toString('latin1', 0, 6)).toBe('GIF89a');
    expect(buf.includes(Buffer.from('NETSCAPE2.0'))).toBe(true);
    expect(buf.length).toBeLessThan(10 * 1024 * 1024);
    await expectNoErrors(errors);
  });

  test('keeps the project and media after a reload, and works offline', async ({ page, context }) => {
    const errors = await openApp(page);
    await importFiles(page, ['clip-a.webm', 'photo.png']);
    await waitForMedia(page, 2);
    await dragToTimeline(page, 0, 'video', 0);
    await page.getByRole('textbox', { name: 'Movie name' }).first().fill('Beach day');
    await page.getByRole('textbox', { name: 'Movie name' }).first().press('Enter');
    await expect(page.getByText('All changes saved')).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready);

    await context.setOffline(true);
    await page.reload();
    await page.waitForSelector('body[data-ready="true"]');
    await waitForMedia(page, 2);
    const p = await project(page);
    expect(p.name).toBe('Beach day');
    expect(p.clips.filter((c) => c.track === 'video')).toHaveLength(1);
    await expect(page.locator('.bin-item')).toHaveCount(2);
    await context.setOffline(false);
    await expectNoErrors(errors);
  });

  test('converts formats the browser cannot play (AVI) with the bundled converter', async ({ page }) => {
    test.setTimeout(240_000);
    const errors = await openApp(page);
    await importFiles(page, ['old.avi']);
    await page.waitForFunction(
      () => {
        const { store, media } = window.cutline;
        const m = Object.values(store.project.media)[0];
        return m && ['ready', 'error'].includes(media.getStatus(m.id).state) && !media.getStatus(m.id).analyzing;
      },
      null,
      { timeout: 200_000 },
    );
    const m = Object.values((await project(page)).media)[0];
    expect(m.converted).toBe(true);
    expect(m.width).toBe(160);
    expect(m.duration).toBeGreaterThan(0.5);
    await expectNoErrors(errors);
  });
});
