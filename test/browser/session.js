'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const root = path.resolve(__dirname, '../..');

function safeUrl(value) {
  try { const url = new URL(value); return url.origin === 'null' ? url.protocol : url.origin + url.pathname; }
  catch (_) { return ''; }
}
function redact(text) {
  return String(text).replace(/https?:\/\/[^\s"'<>]+/g, url => safeUrl(url))
    .replace(/(?:token|cookie|authorization|password|enc|openc)\s*[=:]\s*[^\s,;]+/gi, '[REDACTED]');
}

async function openSession({ profile = '', headed = false, late = false, extensionPath = root } = {}) {
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: !headed, viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: late ? ['--enable-unsafe-extension-debugging'] : [
      '--disable-extensions-except=' + extensionPath, '--load-extension=' + extensionPath
    ]
  });
  let extensionId;
  async function install() {
    if (late) {
      const browser = context.browser();
      const cdp = browser ? await browser.newBrowserCDPSession() : await context.newCDPSession(context.pages()[0]);
      extensionId = (await cdp.send('Extensions.loadUnpacked', { path: extensionPath })).id;
      await cdp.detach();
    } else {
      const worker = context.serviceWorkers().find(worker => worker.url().endsWith('/background.js') || /\/qa-worker(?:-[a-f0-9]+)?\.js$/.test(worker.url()))
        || await context.waitForEvent('serviceworker', { timeout: 15000 });
      extensionId = worker.url().split('/')[2];
    }
    const popup = await context.newPage();
    await popup.goto('chrome-extension://' + extensionId + '/popup.html');
    session.popup = popup;
    return extensionId;
  }
  const session = {
    context, popup: null, install,
    async bind(page) {
      session.page = page;
      session.tabId = await session.popup.evaluate(async originPath => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find(tab => {
          try { const url = new URL(tab.url); return url.origin + url.pathname === originPath; } catch (_) { return false; }
        });
        if (!tab) throw new Error('Course tab not found');
        return tab.id;
      }, safeUrl(page.url()));
      await page.bringToFront();
    },
    async settings(values) { await session.popup.evaluate(values => chrome.storage.local.set(values), values); },
    async probe({ recover = false } = {}) {
      return session.popup.evaluate(async ({ tabId, recover }) => {
        const rows = recover ? await prepareFrames({ id: tabId }) : await chrome.scripting.executeScript({
          target: { tabId, allFrames: true }, world: 'ISOLATED', func: probeFrame
        });
        return rows.map(row => ({
          frameId: row.frameId, documentId: row.documentId,
          injected: !!row.result?.injected, status: row.result?.startupStatus || 'unknown',
          recovered: !!row.result?.recovered, version: row.result?.scriptVersion,
          videos: (row.result?.videos || []).map(video => ({
            paused: video.paused, ended: video.ended, rate: video.playbackRate,
            position: video.currentTime, duration: video.duration
          })),
          candidates: (row.result?.candidates || []).map(candidate => ({ text: String(candidate.text || '').slice(0, 80), score: candidate.score })),
          events: (row.result?.events || []).map(event => ({ time: event.timestamp, type: event.type })),
          missing: row.result?.missingModules || [], errors: row.result?.startupErrors || []
        }));
      }, { tabId: session.tabId, recover });
    },
    async manual(documentId) {
      return session.popup.evaluate(async ({ tabId, documentId }) => {
        const rows = await chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, world: 'ISOLATED', func: probeClickNext });
        const result = rows[0]?.result || {};
        return { status: result.status, clicked: result.clicked, reason: result.reason };
      }, { tabId: session.tabId, documentId });
    },
    async close() { await context.close(); }
  };
  if (!late) {
    try { await install(); } catch (error) { await context.close(); throw error; }
  }
  return session;
}

function collectConsole(context, { real = false } = {}) {
  const entries = [];
  function hook(page) {
    page.on('console', message => {
      // Real courses may log signed URLs or account data: record event categories only.
      if (real) {
        if (message.text().startsWith('[AutoNext]')) entries.push({ type: message.type(), source: 'extension' });
      } else entries.push({ type: message.type(), text: redact(message.text()) });
    });
    page.on('pageerror', error => entries.push(real ? { type: 'error', name: error.name } : { type: 'error', text: redact(error.message) }));
  }
  context.pages().forEach(hook);
  context.on('page', hook);
  return entries;
}

async function evidence(session, directory, detail, { real = false } = {}) {
  fs.mkdirSync(directory, { recursive: true });
  let rows = [];
  try { rows = await session.probe(); } catch (_) {}
  fs.writeFileSync(path.join(directory, 'events.json'), JSON.stringify(rows, null, 2));
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(detail, null, 2));
  if (session.page && (!real || (new URL(session.page.url()).hostname === 'mooc1.chaoxing.com'
    && new URL(session.page.url()).pathname.includes('/mycourse/studentstudy')
    && await session.page.locator('input[type=password]').count() === 0))) {
    await session.page.screenshot({ path: path.join(directory, 'page.png') }).catch(() => {});
  }
}
module.exports = { root, openSession, collectConsole, evidence, safeUrl, redact };
