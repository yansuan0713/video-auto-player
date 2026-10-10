'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const puppeteer = require('puppeteer-core');

(async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><div class="posCatalog_active" id="lesson1">第一节</div>
      <div id="lesson2">第二节</div><button id="next">下一节</button>
      <iframe></iframe><iframe sandbox="allow-scripts"></iframe>
      <script>window.clicks=0;window.changeLesson=false;
      document.querySelector('#next').onclick=()=>{window.clicks++;
        if(window.changeLesson){document.querySelector('#lesson1').className='';
          document.querySelector('#lesson2').className='posCatalog_active';}};</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    const executablePath = process.env.BROWSER_PATH || [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
    ].find(file => fs.existsSync(file));
    assert.ok(executablePath, 'Set BROWSER_PATH to a Chromium browser with Extensions.loadUnpacked support');
    browser = await puppeteer.launch({ executablePath, headless: true, pipe: true, enableExtensions: true });
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:' + server.address().port);
    // Install AFTER the page is loaded: host access does not retroactively run static scripts.
    const id = await browser.installExtension(path.resolve(__dirname, '..'));
    const popup = await browser.newPage();
    await popup.goto('chrome-extension://' + id + '/popup.html');
    const tabId = await popup.evaluate(async () => (await chrome.tabs.query({})).find(t => t.url?.startsWith('http://127.0.0.1:')).id);
    const before = await popup.evaluate(async tabId => chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, world: 'ISOLATED', func: probeFrame
    }), tabId);
    assert.equal(before.length, 3);
    assert.ok(before.every(row => row.result.startupStatus === 'not_injected'));
    console.log('PASS installed extension on preexisting page reproduces missing scripts in top and about:blank frames');

    const repaired = await popup.evaluate(async tabId => {
      await chrome.storage.local.set({ autoNext: true, autoSkipNonVideo: false, autoRate: false });
      const [a, b] = await Promise.all([prepareFrames({ id: tabId }), prepareFrames({ id: tabId })]);
      return { sameResult: a === b, rows: a };
    }, tabId);
    assert.ok(repaired.sameResult);
    assert.equal(repaired.rows.length, 3);
    assert.ok(repaired.rows.every(row => row.result.injected && row.result.startupStatus === 'ready' && row.result.recovered));
    console.log('PASS concurrent document-targeted recovery starts all three frames including sandbox about:blank');

    const top = repaired.rows.find(row => row.frameId === 0);
    const outcome = await popup.evaluate(async ({ tabId, documentId }) => {
      const target = { tabId, documentIds: [documentId] };
      const result = await chrome.scripting.executeScript({ target, world: 'ISOLATED', func: probeClickNext });
      return result[0].result;
    }, { tabId, documentId: top.documentId });
    assert.equal(outcome.status, 'unconfirmed');
    assert.equal(await page.evaluate(() => window.clicks), 1);
    console.log('PASS real click with no page change reports unconfirmed');

    const concurrent = await popup.evaluate(async ({ tabId, documentId }) => chrome.scripting.executeScript({
      target: { tabId, documentIds: [documentId] }, world: 'ISOLATED',
      func: async () => Promise.all([window.__AUTO_NEXT__.manualNavigateNext(), window.__AUTO_NEXT__.manualNavigateNext()])
    }), { tabId, documentId: top.documentId });
    assert.deepEqual(concurrent[0].result.map(row => row.status), ['unconfirmed', 'busy']);
    assert.equal(await page.evaluate(() => window.clicks), 2);
    console.log('PASS concurrent manual requests dispatch one click and report busy');

    await page.evaluate(() => { window.changeLesson = true; });
    const changed = await popup.evaluate(async ({ tabId, documentId }) => chrome.scripting.executeScript({
      target: { tabId, documentIds: [documentId] }, world: 'ISOLATED', func: probeClickNext
    }), { tabId, documentId: top.documentId });
    assert.equal(changed[0].result.status, 'confirmed');
    assert.equal(changed[0].result.reason, 'active-catalog-node-changed');
    assert.equal(await page.evaluate(() => window.clicks), 3);
    console.log('PASS active chapter change is confirmed through actual extension popup probe');

    await page.reload({ waitUntil: 'networkidle0' });
    const fresh = await popup.evaluate(async tabId => prepareFrames({ id: tabId }), tabId);
    assert.ok(fresh.every(row => row.result.startupStatus === 'ready' && !row.result.recovered));
    console.log('PASS manifest-ordered declarative startup in top, plain and sandbox about:blank frames');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
