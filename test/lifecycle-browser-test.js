'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const puppeteer = require('puppeteer-core');
const root = path.resolve(__dirname, '..');
const manifest = require('../manifest.json');
const media = fs.readFileSync(path.join(__dirname, 'fixtures/sample.webm'));

(async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/sample.webm') { res.writeHead(200, { 'Content-Type': 'video/webm' }); res.end(media); }
    else { res.writeHead(404); res.end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const executablePath = process.env.BROWSER_PATH || [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe'
    ].find(file => fs.existsSync(file));
    assert.ok(executablePath, 'Set BROWSER_PATH to a Chromium executable');
    // Default autoplay policy; this suite does not globally disable browser policy.
    browser = await puppeteer.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<div id="container"><button id="fullscreen">Fullscreen</button><video controls></video></div>');
    await page.evaluate(() => {
      document.querySelector('#fullscreen').onclick = () => document.querySelector('#container').requestFullscreen();
      window.chrome = {
        runtime: { id: 'test', getManifest: () => ({ version: 'test' }) },
        storage: {
          local: { get: (_, cb) => cb({ autoNext: false, autoRate: false }), set: (_, cb) => cb && cb() },
          onChanged: { addListener() {} }
        }
      };
    });
    for (const file of manifest.content_scripts[0].js) await page.addScriptTag({ path: path.join(root, file) });
    const mediaUrl = 'http://127.0.0.1:' + server.address().port + '/sample.webm';
    await page.evaluate(async url => {
      const video = document.querySelector('video');
      video.src = url;
      await new Promise((resolve, reject) => {
        video.onloadedmetadata = resolve;
        video.onerror = reject;
        video.load();
      });
      AutoNext.videoHandler.configure({ minDuration: 0.1, minPlayedSeconds: 0.1 });
      AutoNext.videoHandler.scan();
    }, mediaUrl);

    const reattached = await page.evaluate(() => {
      const video = document.querySelector('video');
      video.remove();
      AutoNext.videoHandler.scan();
      document.querySelector('#container').append(video);
      AutoNext.videoHandler.scan();
      video.dispatchEvent(new Event('pause'));
      return AutoNext.videoHandler.diagnostics().endedBound;
    });
    assert.equal(reattached, true);
    console.log('PASS real DOM detach/reinsert and pause');

    // Inject only the first policy rejection; the muted retry uses native play().
    await page.evaluate(() => {
      const video = document.querySelector('video');
      AutoNext.settings.enabled = true;
      const nativePlay = video.play.bind(video);
      let first = true;
      video.play = () => {
        if (first) { first = false; return Promise.reject(new DOMException('test policy', 'NotAllowedError')); }
        return nativePlay();
      };
      AutoNext.videoHandler.tryAutoPlay(video);
    });
    await page.waitForFunction(() => AutoNext.getEvents().some(e => e.type === 'AUTOPLAY_MUTED_FALLBACK'));
    assert.equal(await page.$eval('video', video => video.muted), true);
    await page.keyboard.press('Shift');
    assert.equal(await page.$eval('video', video => video.muted), false);
    console.log('PASS injected NotAllowedError followed by native muted playback and gesture audio restore');

    await page.click('#fullscreen');
    await page.waitForFunction(() => !!document.fullscreenElement);
    await page.evaluate(() => AutoNext.toast.show('fullscreen test'));
    assert.equal(await page.evaluate(() => document.fullscreenElement.contains(document.querySelector('#__auto_next_toast__'))), true);
    await page.evaluate(() => document.exitFullscreen());
    console.log('PASS user-initiated container fullscreen and toast placement');

    await page.evaluate(() => {
      AutoNext.videoHandler.destroy();
      AutoNext.settings.enabled = false;
    });
    // Separately load a real missing resource and confirm automatic play is refused.
    await page.evaluate(async url => {
      const video = document.querySelector('video');
      await new Promise(resolve => { video.onerror = resolve; video.src = url; video.load(); });
      AutoNext.settings.enabled = true;
      AutoNext.videoHandler.scan();
    }, mediaUrl.replace('/sample.webm', '/missing.webm'));
    assert.equal(await page.evaluate(() => AutoNext.videoHandler.tryAutoPlay(document.querySelector('video'))), false);
    console.log('PASS real media loading error does not trigger play');
    assert.deepEqual(errors, []);
    console.log('4 browser cases passed; no uncaught page errors');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
