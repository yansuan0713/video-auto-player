'use strict';
// Read-only native media observation; never calls play(), seeks, or changes progress.
function installObserver() {
  if (window.__VAP_OBSERVER__) return;
  const records = new Map();
  const documentKey = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  let sequence = 0;
  const notify = payload => { if (window.__vapRecord) window.__vapRecord(payload).catch(() => {}); };
  const attach = video => {
    if (records.has(video)) return;
    const record = { id: ++sequence, epoch: 0, seeks: 0, endedAt: 0 };
    records.set(video, record);
    video.addEventListener('loadstart', () => { record.epoch++; record.seeks = 0; record.endedAt = 0; });
    video.addEventListener('seeking', () => { record.seeks++; });
    video.addEventListener('ended', event => {
      record.endedAt = Date.now();
      notify({ kind: 'ended', doc: documentKey, id: record.id, epoch: record.epoch, seeks: record.seeks,
        trusted: event.isTrusted, position: video.currentTime, duration: video.duration });
    });
  };
  const scan = () => document.querySelectorAll('video').forEach(attach);
  new MutationObserver(scan).observe(document, { childList: true, subtree: true });
  document.addEventListener('loadedmetadata', scan, true);
  scan();
  window.__VAP_OBSERVER__ = () => Array.from(records).filter(([video]) => video.isConnected).map(([video, record]) => ({
    ...record, doc: documentKey, position: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : null,
    paused: video.paused, ended: video.ended, rate: video.playbackRate, readyState: video.readyState
  }));
}
async function observe(context) {
  const events = [];
  await context.exposeBinding('__vapRecord', ({ frame }, event) => {
    const { safeUrl } = require('./session');
    events.push({ at: Date.now(), frame: safeUrl(frame.url()), ...event });
  });
  await context.addInitScript(installObserver);
  return events;
}
async function mediaState(page) {
  const rows = [];
  for (const [index, frame] of page.frames().entries()) {
    try {
      const media = await frame.evaluate(() => window.__VAP_OBSERVER__?.() || []);
      for (const video of media) rows.push({ frame: index, ...video });
    } catch (_) {}
  }
  return rows;
}
module.exports = { observe, mediaState, installObserver };
