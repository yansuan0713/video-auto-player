'use strict';
const assert = require('node:assert/strict');
const { createSandbox, loadExtension, runTimers, buildLessonPage } = require('./run-tests');
const { FakeEvent, FakeElement } = require('./fake-dom');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function setup(storage = {}) {
  const page = buildLessonPage({ withNav: true });
  page.video.paused = false;
  const box = createSandbox({ page, storage: { autoNext: true, ...storage } });
  const api = loadExtension(box.sandbox);
  await tick();
  return { ...box, page, api };
}
function pending(box) { return box.timers.filter(t => !t.cancelled && !t.done); }

test('移除并重新插入同一播放器后重新绑定并能处理 pause', async () => {
  const b = await setup();
  b.page.video.remove();
  b.api.videoHandler.scan();
  b.page.body.append(b.page.video);
  b.page.video.isConnected = true;
  b.api.videoHandler.scan();
  b.page.video.watch(10);
  b.page.video.paused = true;
  b.page.video.dispatchEvent(new FakeEvent('pause'));
  assert.equal(b.api.videoHandler.diagnostics().endedBound, true);
});
test('destroy 释放媒体监听，重新 scan 只绑定一次', async () => {
  const b = await setup();
  b.api.videoHandler.destroy();
  assert.equal((b.page.video.listeners.get('ended') || []).length, 0);
  b.api.videoHandler.scan();
  assert.equal((b.page.video.listeners.get('ended') || []).length, 1);
});
test('关闭连播后迟到的 NotAllowedError 不再静音或重播', async () => {
  const b = await setup();
  let rejectPlay;
  let calls = 0;
  b.page.video.paused = true;
  b.page.video.play = () => { calls++; return new Promise((_, reject) => { rejectPlay = reject; }); };
  b.api.videoHandler.tryAutoPlay(b.page.video);
  b.storageListeners.forEach(fn => fn({ autoNext: { newValue: false } }, 'local'));
  rejectPlay(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
  await tick();
  assert.equal(calls, 1);
  assert.equal(b.page.video.muted, false);
});
test('同一源 play Promise 挂起时不会重复调用 play', async () => {
  const b = await setup();
  let calls = 0;
  b.page.video.paused = true;
  b.page.video.play = () => { calls++; return new Promise(() => {}); };
  b.api.videoHandler.tryAutoPlay(b.page.video);
  b.api.videoHandler.tryAutoPlay(b.page.video);
  assert.equal(calls, 1);
});
test('取消导航后旧 poll 不能确认新导航', async () => {
  const b = await setup();
  const button = b.page.body.append(new FakeElement('button', { text: '下一节' }));
  let oldConfirmed = 0;
  let newConfirmed = 0;
  b.api.videoHandler.startNavigationConfirmation(button, 'old', { onConfirm: () => oldConfirmed++ });
  b.api.videoHandler.resetCycle();
  b.api.videoHandler.startNavigationConfirmation(button, 'new', { onConfirm: () => newConfirmed++ });
  b.windowMock.location.href += '&new=1';
  await runTimers(b.timers, { clock: b.clock });
  assert.equal(oldConfirmed, 0);
  assert.equal(newConfirmed, 1);
});
test('pagehide 停止全部周期任务，pageshow 恢复单个观察器与 URL 轮询', async () => {
  const b = await setup();
  b.frameWindow.dispatchEvent(new FakeEvent('pagehide'));
  assert.equal(b.intervals.filter(t => !t.cancelled).length, 0);
  assert.equal(pending(b).length, 0);
  b.frameWindow.dispatchEvent(Object.assign(new FakeEvent('pageshow'), { persisted: true }));
  assert.equal(b.intervals.filter(t => !t.cancelled && t.ms === 5000).length, 1);
  assert.equal(b.mutationObservers.filter(o => o.active).length, 1);
});
test('不同 frame 的首条消息 ID 不冲突', async () => {
  const a = await setup();
  const b = await setup();
  a.frameWindow.frames = [{ postMessage: data => a.windowMock.sentMessages.push(data) }];
  b.frameWindow.frames = [{ postMessage: data => b.windowMock.sentMessages.push(data) }];
  a.api.messenger.reportNavigated();
  b.api.messenger.reportNavigated();
  assert.notEqual(a.windowMock.sentMessages[0].id, b.windowMock.sentMessages[0].id);
});
test('媒体解码错误不继续尝试播放，也不跳过视频', async () => {
  const b = await setup();
  b.page.video.error = { code: 3, message: 'decode failed' };
  b.page.video.paused = true;
  let calls = 0;
  b.page.video.play = () => { calls++; return Promise.resolve(); };
  b.api.videoHandler.tryAutoPlay(b.page.video);
  assert.equal(calls, 0);
  assert.equal(b.page.state.clicked.length, 0);
});
test('换源后旧 play 拒绝不静音新源', async () => {
  const b = await setup();
  let rejectPlay;
  b.page.video.paused = true;
  b.page.video.play = () => new Promise((_, reject) => { rejectPlay = reject; });
  b.api.videoHandler.tryAutoPlay(b.page.video);
  const rejectOld = rejectPlay;
  b.page.video.src = 'https://example.com/new.mp4';
  b.page.video.paused = false;
  b.page.video.dispatchEvent(new FakeEvent('emptied'));
  rejectOld(Object.assign(new Error('old'), { name: 'NotAllowedError' }));
  await tick();
  assert.equal(b.page.video.muted, false);
});
test('静音兜底后销毁释放用户手势监听，保留用户设置的音量', async () => {
  const b = await setup();
  b.page.video.paused = true;
  b.page.video.failPlayTimes = 1;
  b.api.videoHandler.tryAutoPlay(b.page.video);
  await tick();
  assert.equal(b.page.video.muted, true);
  b.page.video.volume = 0.3;
  b.api.videoHandler.destroy();
  assert.equal(b.page.video.muted, false);
  assert.equal(b.page.video.volume, 0.3);
  assert.equal((b.frameWindow._listeners.click || []).length, 0);
  assert.equal((b.frameWindow._listeners.keydown || []).length, 0);
});
test('仅倍速模式也会在移除播放器时释放监听和恢复定时器', async () => {
  const b = await setup({ autoNext: false, autoRate: true, autoRate2x: true });
  b.page.video.resetRateBySite(1);
  b.page.video.remove();
  b.mutationObservers.filter(o => o.active).forEach(o => o.callback([{
    type: 'childList', removedNodes: [b.page.video], addedNodes: []
  }]));
  await runTimers(b.timers, { clock: b.clock });
  assert.equal((b.page.video.listeners.get('ratechange') || []).length, 0);
  assert.equal(b.page.video.playbackRate, 1);
});
test('结尾缓冲超过延迟恢复时点，数据恢复后仍补播最后几秒', async () => {
  const b = await setup();
  b.page.video.watch(30);
  b.page.video.currentTime = b.page.video.duration - 2;
  b.page.video.readyState = 1;
  b.page.video.paused = true;
  b.page.video.dispatchEvent(new FakeEvent('pause'));
  await runTimers(b.timers, { clock: b.clock });
  b.page.video.readyState = 4;
  b.page.video.dispatchEvent(new FakeEvent('canplay'));
  await tick();
  assert.equal(b.page.video.paused, false);
  assert.equal(b.page.state.clicked.length, 0);
});
test('自动连播提示实际调用 UI，而不是初始化时捕获的空实现', async () => {
  const b = await setup();
  b.page.video.watch(30);
  b.page.video.finish();
  await runTimers(b.timers, { clock: b.clock });
  assert.ok(b.page.documentElement.querySelector('#__auto_next_toast__'));
});
(async () => {
  let failures = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log('PASS ' + name); }
    catch (error) { failures++; console.error('FAIL ' + name + '\n' + error.stack); }
  }
  console.log(tests.length + ' cases, ' + failures + ' failed');
  process.exitCode = failures ? 1 : 0;
})();
