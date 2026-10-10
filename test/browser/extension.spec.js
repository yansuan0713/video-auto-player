'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { openSession, collectConsole, evidence } = require('./session');
const { server } = require('./server');
const { observe, mediaState } = require('./observe');
const { guardedBuild } = require('./guarded-build');

async function fixture(testInfo, options, action) {
  const host = await server();
  let session;
  let consoleEvents = [];
  let nativeEvents = [];
  const behavior = { injected: false, playerDetected: false, nextFound: false, navigated: false, nextPlaying: false };
  try {
    session = await openSession(options);
    consoleEvents = collectConsole(session.context);
    nativeEvents = await observe(session.context);
    await action({ session, host, nativeEvents, behavior });
    await evidence(session, testInfo.outputPath('evidence'), { status: 'passed', behavior, nativeEvents, consoleEvents });
  } catch (error) {
    if (session) await evidence(session, testInfo.outputPath('evidence'), { status: 'failed', error: error.message, behavior, nativeEvents, consoleEvents });
    throw error;
  } finally {
    if (session) await session.close();
    await host.close();
  }
}
async function firstPlayer(page) {
  const rows = await mediaState(page);
  return rows.find(video => !video.paused && video.readyState >= 2 && video.position > 0.1);
}

for (const mode of ['plain', 'nested', 'cross', 'dynamic', 'about', 'srcdoc']) {
  test(`${mode}: real 2x, natural ended, next chapter and growing playback`, async ({}, testInfo) => {
    await fixture(testInfo, {}, async ({ session, host, nativeEvents, behavior }) => {
      await session.settings({ autoNext: true, autoRate: true, autoRate2x: true, playbackRate: 2, autoSkipNonVideo: true });
      const page = await session.context.newPage();
      await page.goto(host.origin + '/course?mode=' + mode);
      await session.bind(page);
      await expect.poll(() => firstPlayer(page)).toBeTruthy();
      const initialMedia = await mediaState(page);
      const initialRows = await session.probe(); // read-only: do not hide declarative startup failures.
      behavior.injected = initialRows.every(row => row.status === 'ready' && row.version === '1.2.6');
      behavior.playerDetected = initialRows.some(row => row.videos.length);
      behavior.nextFound = initialRows.some(row => row.candidates.some(candidate => candidate.score >= 40));
      expect(behavior.injected).toBe(true);
      expect(behavior.playerDetected).toBe(true);
      expect(behavior.nextFound).toBe(true);
      expect(initialMedia.find(video => !video.paused).duration).toBeGreaterThan(15);
      expect(initialMedia.find(video => !video.paused).rate).toBe(2);
      await expect.poll(() => page.evaluate(() => window.lesson)).toBe(2);
      behavior.navigated = true;
      expect(nativeEvents.some(event => event.kind === 'ended' && event.trusted && event.seeks === 0)).toBe(true);
      await expect.poll(() => firstPlayer(page)).toBeTruthy();
      const before = await firstPlayer(page);
      expect(initialMedia.some(old => old.doc === before.doc && old.id === before.id && old.epoch === before.epoch)).toBe(false);
      await expect.poll(async () => (await firstPlayer(page))?.position || 0).toBeGreaterThan(before.position + 0.2);
      behavior.nextPlaying = true;
      expect(await page.evaluate(() => window.changes)).toBe(1);
    });
  });
}

test('page first / extension later: absence observed before document recovery', async ({}, testInfo) => {
  await fixture(testInfo, { late: true }, async ({ session, host, behavior }) => {
    const page = await session.context.newPage();
    await page.goto(host.origin + '/course?mode=about');
    await session.install();
    await session.bind(page);
    const before = await session.probe();
    expect(before.length).toBe(2);
    expect(before.every(row => !row.injected && row.status === 'not_injected')).toBe(true);
    fs.writeFileSync(testInfo.outputPath('before-recovery.json'), JSON.stringify(before, null, 2));
    await session.settings({ autoNext: true, autoRate: true, playbackRate: 2, autoSkipNonVideo: false });
    const after = await session.probe({ recover: true });
    expect(after.every(row => row.status === 'ready' && row.recovered)).toBe(true);
    behavior.injected = true;
    await expect.poll(() => firstPlayer(page)).toBeTruthy();
    behavior.playerDetected = true;
    await expect.poll(() => page.evaluate(() => window.lesson)).toBe(2);
    behavior.navigated = true;
    await expect.poll(() => firstPlayer(page)).toBeTruthy();
    const beforePlay = await firstPlayer(page);
    await expect.poll(async () => (await firstPlayer(page))?.position || 0).toBeGreaterThan(beforePlay.position + 0.2);
    behavior.nextPlaying = true;
  });
});

test('manual no effect, busy, recovery and diagnostic events', async ({}, testInfo) => {
  await fixture(testInfo, {}, async ({ session, host, behavior }) => {
    await session.settings({ autoNext: true, autoSkipNonVideo: false });
    const page = await session.context.newPage();
    await page.goto(host.origin + '/manual');
    await session.bind(page);
    const rows = await session.probe();
    const top = rows.find(row => row.frameId === 0);
    behavior.injected = top.status === 'ready';
    behavior.nextFound = top.candidates.some(candidate => candidate.score >= 40);
    expect((await session.manual(top.documentId)).status).toBe('unconfirmed');
    await evidence(session, testInfo.outputPath('retained-no-effect'), { status: 'expected-failure', behavior });
    expect((await session.probe()).some(row => row.events.some(event => event.type === 'CLICK_NO_EFFECT'))).toBe(true);
    const [first, concurrent] = await Promise.all([session.manual(top.documentId), session.manual(top.documentId)]);
    expect([first.status, concurrent.status].sort()).toEqual(['busy', 'unconfirmed']);
    expect(await page.evaluate(() => window.clicks)).toBe(2);
    await page.evaluate(() => { window.effect = true; });
    expect((await session.manual(top.documentId)).status).toBe('confirmed');
    expect(await page.locator('#lesson2').getAttribute('class')).toBe('posCatalog_active');
    behavior.navigated = true;
    expect((await session.probe()).some(row => row.events.some(event => event.type === 'NAVIGATED'))).toBe(true);
  });
});

test('guarded real-test build: two natural transitions, no third click across frames', async ({}, testInfo) => {
  const extensionPath = guardedBuild(testInfo.outputPath('guarded-extension'));
  await fixture(testInfo, { extensionPath }, async ({ session, host, nativeEvents, behavior }) => {
    await session.settings({ autoNext: true, autoRate: true, playbackRate: 2, autoSkipNonVideo: false });
    expect(await session.popup.evaluate(() => chrome.runtime.sendMessage({ type: 'QA_ARM', limit: 2, hosts: ['127.0.0.1'] }))).toMatchObject({ remaining: 2 });
    const page = await session.context.newPage();
    await page.goto(host.origin + '/course?mode=nested');
    await session.bind(page);
    await expect.poll(() => page.evaluate(() => window.lesson)).toBe(3);
    const snapshot = await session.probe();
    behavior.injected = snapshot.every(row => row.status === 'ready');
    behavior.playerDetected = snapshot.some(row => row.videos.length);
    behavior.nextFound = snapshot.some(row => row.candidates.some(candidate => candidate.score >= 40));
    behavior.navigated = true;
    await expect.poll(() => firstPlayer(page)).toBeTruthy();
    behavior.nextPlaying = true;
    await expect.poll(() => nativeEvents.filter(event => event.kind === 'ended' && event.trusted).length).toBe(3);
    await expect.poll(async () => (await session.probe()).some(row => row.events.some(event => event.type === 'QA_NAVIGATION_BLOCKED'))).toBe(true);
    expect(await page.evaluate(() => window.lesson)).toBe(3);
    expect(await page.evaluate(() => window.changes)).toBe(2);
    expect(await session.popup.evaluate(() => chrome.runtime.sendMessage({ type: 'QA_STATE' }))).toMatchObject({ claims: 2, remaining: 0 });
  });
});
