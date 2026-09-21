/**
 * test/regression-autoplay-tests.js —— 核心链路回归测试 (v1.2.3)
 *
 * 专门针对用户反馈的真实使用回归场景：
 *   A. 跨 frame 完成导航后播放器重新扫描并自动播放
 *   B. 同一个 video 元素换 src 状态清理与连续换集
 *   C. 同页多任务点 Tab 连续两次自动连播 (视频1 -> Tab2视频2 -> Tab3视频3)
 *   D. 跨 frame 导航防重复点击 (一次视频结束最多点击一次)
 *   E. form 包裹的普通下一节按钮正常命中，submit 提交控件严格排除
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { FakeElement, FakeVideoElement, FakeEvent } = require('./fake-dom');
const { createSandbox, loadExtension, runTimers, tickIntervals, buildLessonPage } = require('./run-tests');

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: !!condition, detail });
  console.log(`${condition ? '  ✓' : '  ✗'} ${name}${condition ? '' : `  → ${detail}`}`);
}

/** 模拟真实浏览器多层 iframe 的 postMessage 双向分发与父子指针 */
function wireFrames(boxes) {
  for (let i = 1; i < boxes.length; i++) {
    boxes[i].frameWindow.parent = boxes[i - 1].frameWindow;
    boxes[i].frameWindow.top = boxes[0].frameWindow;
    boxes[i - 1].frameWindow.frames.push(boxes[i].frameWindow);
  }
  for (const box of boxes) {
    box.frameWindow.postMessage = (data) => {
      box.frameWindow.dispatchEvent(Object.assign(new FakeEvent('message'), { data }));
    };
  }
}

// ————————————————————————————————————————————————————————————————
// A. 跨 frame 完成导航后播放器重新扫描并自动播放
// 模拟：三层 iframe 嵌套 (Top -> Mid -> Leaf)
// Leaf 视频播完 -> 请求协助 -> Mid 中继 -> Top 点击下一任务点 -> Top 广播 NAVIGATED
// -> Mid 中继至 Leaf -> Leaf 换源/出新视频 -> 新视频被重新识别并自动播放
// ————————————————————————————————————————————————————————————————
async function testCrossFrameNavigationRecovery() {
  console.log('\n[Suite A] 跨 frame 完成导航后播放器重新扫描与自动播放');

  const topPage = buildLessonPage({ withNav: true });
  const midPage = buildLessonPage({ withNav: false });
  const leafPage = buildLessonPage({ withNav: false });

  const defaultStorage = { autoNext: true, autoRate: true, autoRate2x: true, playbackRate: 2.0 };
  const top = createSandbox({ page: topPage, storage: defaultStorage, isTop: true, logSink: [] });
  const mid = createSandbox({ page: midPage, storage: defaultStorage, isTop: false, logSink: [] });
  const leaf = createSandbox({ page: leafPage, storage: defaultStorage, isTop: false, logSink: [] });

  const topApi = loadExtension(top.sandbox);
  const midApi = loadExtension(mid.sandbox);
  const leafApi = loadExtension(leaf.sandbox);

  wireFrames([top, mid, leaf]);

  await runTimers(top.timers);
  await runTimers(mid.timers);
  await runTimers(leaf.timers);

  // 1. Leaf 视频 1 自然播放并结束
  leafPage.video.watch(30);
  leafPage.video.finish();

  // 推进定时器让 Leaf 发出协助 -> Mid 转发 -> Top 点击
  await runTimers(leaf.timers);
  await runTimers(mid.timers);
  await runTimers(top.timers);

  check('Top 成功代为点击了下一节', topPage.state.clicked.includes('next'));

  // 推进 NAVIGATED 下发与各层 afterNavigation 调度
  await runTimers(mid.timers);
  await runTimers(leaf.timers);

  // 2. 模拟页面在 Top 点击后，Leaf 中视频换源到下一节视频
  leafPage.video.src = 'https://example.com/media/lesson-2.mp4';
  leafPage.video.currentTime = 0;
  leafPage.video.ended = false;
  leafPage.video.paused = true;
  leafPage.video.readyState = 4;
  leafPage.video.duration = 450;
  leafPage.video.dispatchEvent(new FakeEvent('emptied'));

  // 推进 Leaf 定时器跑完渐进式恢复
  await runTimers(leaf.timers, { maxRounds: 10 });

  check('Leaf 换源后新视频被重新识别', leafApi.videoHandler.stats().active !== null);
  check('Leaf 换源后新视频自动开始播放', leafPage.video.paused === false, `paused=${leafPage.video.paused}`);
  check('Leaf 新视频被自动应用倍速', Math.abs(leafPage.video.playbackRate - 2.0) <= 0.01, `rate=${leafPage.video.playbackRate}`);
}

// ————————————————————————————————————————————————————————————————
// B. 同一个 video 元素换 src 状态清理与连续换集
// 确保：video A 播完 -> video.src 从 A 改为 B -> 状态清理 -> B 自动播放 -> B 播完继续进入 C
// ————————————————————————————————————————————————————————————————
async function testSingleVideoElementSrcMutation() {
  console.log('\n[Suite B] 同一个 video 元素换 src 状态清理与连续换集');

  const page = buildLessonPage({ withNav: true });
  const { sandbox, timers, clock } = createSandbox({ page, storage: { autoNext: true }, isTop: true, logSink: [] });
  const api = loadExtension(sandbox);
  await runTimers(timers);

  // 1. 视频 A 播放完成
  page.video.src = 'https://example.com/media/video-A.mp4';
  page.video.watch(30);
  page.video.finish();
  await runTimers(timers);

  check('视频 A 播完触发了第一次跳转', page.state.clicked.length === 1);

  // 2. 视频 A 换源为视频 B
  page.video.src = 'https://example.com/media/video-B.mp4';
  page.video.currentTime = 0;
  page.video.ended = false;
  page.video.paused = true;
  page.video.readyState = 4;
  page.video.duration = 500;
  page.video.dispatchEvent(new FakeEvent('emptied'));

  await runTimers(timers, { maxRounds: 10 });

  const diagB = api.videoHandler.diagnostics();
  check('视频 B 自动播放成功', page.video.paused === false, `paused=${page.video.paused}`);
  check('视频 B 的 autoPlayAttempts 已被重置', diagB.autoPlayAttempts <= 1, `attempts=${diagB.autoPlayAttempts}`);
  check('视频 B 继承/重置了正确 sourceKey', diagB.currentSrc.includes('video-B'), diagB.currentSrc);

  // 3. 视频 B 播放了 40 秒后完成，时间流逝越过冷却期，必须能继续自动触发下一节 (进入 C)
  clock.advance(5000);
  page.video.watch(40);
  page.video.finish();
  await runTimers(timers);

  check('视频 B 播完顺利触发了第二次跳转 (进入 C)', page.state.clicked.length === 2, `clicked=${JSON.stringify(page.state.clicked)}`);
}

// ————————————————————————————————————————————————————————————————
// C. 同页多任务点 Tab 连续两次自动连播
// 视频 1 -> Tab 视频 2 -> Tab 视频 3
// 验证：视频 2 被重新检测并自动播放，且视频 2 结束后还能继续进入视频 3
// ————————————————————————————————————————————————————————————————
async function testMultiTaskPointTabsChained() {
  console.log('\n[Suite C] 同页多任务点 Tab 连续两次自动连播');

  const doc = new FakeElement('html');
  const body = doc.append(new FakeElement('body'));
  const clicked = [];

  // 构建超星同章节 Tab 容器
  const tabContainer = body.append(new FakeElement('div', { class: 'tabtags' }));
  const tab1 = tabContainer.append(new FakeElement('span', { id: 'dct1', class: 'currents', text: '任务1' }));
  const tab2 = tabContainer.append(new FakeElement('span', { id: 'dct2', text: '任务2' }));
  const tab3 = tabContainer.append(new FakeElement('span', { id: 'dct3', text: '任务3' }));

  const videoContainer = body.append(new FakeElement('div', { class: 'video-container' }));
  let currentVideo = videoContainer.append(new FakeVideoElement({ duration: 300, id: 'v1' }));
  currentVideo.src = 'https://example.com/task1.mp4';

  tab2.addEventListener('click', () => {
    clicked.push('tab2');
    tab1.classList.remove('currents');
    tab2.classList.add('currents');
    // 切换到任务 2 视频
    currentVideo.remove();
    currentVideo = videoContainer.append(new FakeVideoElement({ duration: 350, id: 'v2' }));
    currentVideo.src = 'https://example.com/task2.mp4';
    currentVideo.ownerDocument = doc.ownerDocument;
    currentVideo.readyState = 4;
  });

  tab3.addEventListener('click', () => {
    clicked.push('tab3');
    tab2.classList.remove('currents');
    tab3.classList.add('currents');
    // 切换到任务 3 视频
    currentVideo.remove();
    currentVideo = videoContainer.append(new FakeVideoElement({ duration: 400, id: 'v3' }));
    currentVideo.src = 'https://example.com/task3.mp4';
    currentVideo.ownerDocument = doc.ownerDocument;
    currentVideo.readyState = 4;
  });

  const { sandbox, timers, clock } = createSandbox({
    page: { documentElement: doc, body, video: currentVideo, state: { clicked } },
    storage: { autoNext: true }
  });
  const api = loadExtension(sandbox);
  await runTimers(timers);

  // 1. 任务点 1 视频播放并结束
  currentVideo.watch(30);
  currentVideo.finish();
  await runTimers(timers, { maxRounds: 10 });

  check('任务点 1 结束后点击了 Tab 2', clicked.includes('tab2'), JSON.stringify(clicked));
  check('任务点 2 视频被检测并自动开始播放', currentVideo.paused === false && currentVideo.id === 'v2',
    `id=${currentVideo.id} paused=${currentVideo.paused}`);

  // 2. 模拟时间推进越过导航冷却期，任务点 2 视频正常播放并结束
  clock.advance(5000);
  currentVideo.watch(30);
  currentVideo.finish();
  await runTimers(timers, { maxRounds: 10 });

  check('任务点 2 结束后顺利点击了 Tab 3', clicked.includes('tab3'), JSON.stringify(clicked));
  check('任务点 3 视频被检测并自动开始播放', currentVideo.paused === false && currentVideo.id === 'v3',
    `id=${currentVideo.id} paused=${currentVideo.paused}`);
}

// ————————————————————————————————————————————————————————————————
// D. 跨 frame 不重复导航
// 确保：一次视频结束，多层 frame 之间无论经过几次恢复轮询，最多只执行一次点击
// ————————————————————————————————————————————————————————————————
async function testNoDuplicateNavigationAcrossFrames() {
  console.log('\n[Suite D] 跨 frame 导航不重复点击');

  const topPage = buildLessonPage({ withNav: true });
  const leafPage = buildLessonPage({ withNav: false });

  const top = createSandbox({ page: topPage, storage: { autoNext: true }, isTop: true, logSink: [] });
  const leaf = createSandbox({ page: leafPage, storage: { autoNext: true }, isTop: false, logSink: [] });

  loadExtension(top.sandbox);
  loadExtension(leaf.sandbox);

  wireFrames([top, leaf]);

  await runTimers(top.timers);
  await runTimers(leaf.timers);

  // Leaf 视频播完
  leafPage.video.watch(30);
  leafPage.video.finish();

  // 充分推进所有定时器（包含 300ms, 1200ms, 2500ms 所有恢复阶段）
  for (let i = 0; i < 5; i++) {
    await runTimers(leaf.timers, { maxRounds: 6 });
    await runTimers(top.timers, { maxRounds: 6 });
  }

  const nextClicks = topPage.state.clicked.filter((action) => action === 'next');
  check('整个导航过程 next 按钮恰好被点击 1 次（杜绝重复点击）', nextClicks.length === 1,
    `clicks=${nextClicks.length} all=${JSON.stringify(topPage.state.clicked)}`);
  check('Leaf 页面自身未执行任何错误点击', leafPage.state.clicked.length === 0);
}

// ————————————————————————————————————————————————————————————————
// E. form 包裹的普通下一节按钮正常命中，submit 提交控件严格排除
// 确保：
// <form><button type="button">下一节</button></form> 可以被识别点击
// 但 <button type="submit">提交测验</button> 必须被严格排除
// ————————————————————————————————————————————————————————————————
async function testFormWrappedNextButton() {
  console.log('\n[Suite E] form 包裹的普通下一节按钮与提交控件安全隔离');

  const doc = new FakeElement('html');
  const body = doc.append(new FakeElement('body'));
  const video = body.append(new FakeVideoElement({ duration: 600 }));
  const clicked = [];

  // 表单 1：真实教学平台中常见的用 form 包裹的工具栏
  const toolbarForm = body.append(new FakeElement('form', { id: 'nav-toolbar-form' }));
  const nextBtn = toolbarForm.append(new FakeElement('button', {
    id: 'next-in-form',
    text: '下一节',
    attrs: { type: 'button' }
  }));
  nextBtn.addEventListener('click', () => clicked.push('form-type-button-next'));

  // 表单 2：测验/答题提交表单（必须绝对排除）
  const examForm = body.append(new FakeElement('form', { id: 'exam-form' }));
  const examSubmitBtn = examForm.append(new FakeElement('button', {
    id: 'quiz-submit',
    text: '提交测验',
    attrs: { type: 'submit' }
  }));
  examSubmitBtn.addEventListener('click', () => clicked.push('quiz-submit-danger'));

  const submitOnlyBtn = body.append(new FakeElement('button', {
    id: 'raw-submit-btn',
    text: '下一节',
    attrs: { type: 'submit' }
  }));
  submitOnlyBtn.addEventListener('click', () => clicked.push('raw-submit-danger'));

  const { sandbox, timers } = createSandbox({
    page: { documentElement: doc, body, video, state: { clicked } },
    storage: { autoNext: true }
  });
  const api = loadExtension(sandbox);
  await runTimers(timers);

  // 1. 测试 buttonFinder 候选识别
  const candidates = api.buttonFinder.findCandidates();
  const candidateIds = candidates.map((c) => c.el.id);
  check('form 内的普通 <button type="button">下一节</button> 被成功识别为候选',
    candidateIds.includes('next-in-form'));
  check('type="submit" 的提交测验控件被严格排除在候选之外',
    !candidateIds.includes('quiz-submit'));
  check('type="submit" 的普通伪下一节控件也被排除在候选之外',
    !candidateIds.includes('raw-submit-btn'));

  // 2. 视频结束实际跳转点击
  video.watch(30);
  video.finish();
  await runTimers(timers);

  check('成功点击了 form 包裹的真实下一节按钮', clicked.includes('form-type-button-next'));
  check('绝未误点击测验提交按钮', !clicked.includes('quiz-submit-danger'));
  check('绝未误点击 type="submit" 控件', !clicked.includes('raw-submit-danger'));
}

// ————————————————————————————————————————————————————————————————
// F. 旧视频 A 结束并 afterNavigation 后，watchdog 绝不二次触发跳转
// 测试场景：video A ended -> afterNavigation() -> 新视频 B 尚未出现 -> watchdog tick 多次
// 断言：A 绝对不能再次触发 triggerNextLesson，next 按钮点击次数严格保持为 1
// ————————————————————————————————————————————————————————————————
async function testWatchdogDoesNotRetriggerOnOldVideo() {
  console.log('\n[Suite F] 旧视频 A 结束并 afterNavigation 后，watchdog 绝不二次触发跳转');

  const page = buildLessonPage({ withNav: true });

  const { sandbox, timers, intervals } = createSandbox({
    page,
    storage: { autoNext: true, autoRate: true, autoRate2x: true },
    isTop: true
  });
  const api = loadExtension(sandbox);
  await runTimers(timers);

  // 视频 A 正常播完并触发跳转
  page.video.watch(30);
  page.video.finish(); // 触发 ended
  await runTimers(timers);

  check('视频 A 播完后触发了第一次跳转', page.state.clicked.filter((c) => c === 'next').length === 1);

  // 此时新视频尚未出现，视频 A 仍处于 ended 状态
  // 让 watchdog tick 10 次，模拟较长空窗期
  tickIntervals(intervals, 10);
  await runTimers(timers);

  check('空窗期内 watchdog 多次 tick 绝未对旧视频 A 再次触发跳转', page.state.clicked.filter((c) => c === 'next').length === 1);
  check('旧视频 A 未再次进入跳转循环', !api.videoHandler.stats().cycle.running);
}

// ————————————————————————————————————————————————————————————————
// G. 导航后旧 A 再次触发 playing 不允许提前解除导航锁，必须由新视频/新源解锁
// 测试场景：A ended -> 点击下一项 (cycle.navigated=true, cycle.navigatedSource=srcA)
// -> 导航过程中旧 A 触发 playing (lock 仍保持) -> 新视频 B 挂载并 playing (lock 成功解除)
// ————————————————————————————————————————————————————————————————
async function testOldVideoPlayingDoesNotPrematurelyUnlock() {
  console.log('\n[Suite G] 旧视频 A 再次 playing 不提前解除导航锁，仅由新视频 B 解锁');

  const page = buildLessonPage({ withNav: true });

  const { sandbox, timers } = createSandbox({
    page,
    storage: { autoNext: true, autoRate: true, autoRate2x: true },
    isTop: true
  });
  const api = loadExtension(sandbox);
  await runTimers(timers);

  page.video.src = 'https://mooc.chaoxing.com/media/videoA.mp4';
  api.videoHandler.scan();
  page.video.watch(30);
  page.video.finish();
  await runTimers(timers);

  check('视频 A 完成导航，导航锁已置位', api.videoHandler.stats().cycle.navigated === true);

  // 模拟平台行为：页面跳转过程中旧 videoA 再次派发 playing
  page.video.dispatchEvent(new FakeEvent('playing'));

  check('旧视频 A 派发 playing 后，导航锁依然保持锁定（杜绝提前解锁）',
    api.videoHandler.stats().cycle.navigated === true);

  // 模拟新视频 B (换新 source) 挂载并真正开始播放
  page.video.src = 'https://mooc.chaoxing.com/media/videoB.mp4';
  page.video.currentTime = 0;
  page.video.ended = false;
  page.video.paused = false;
  page.video.dispatchEvent(new FakeEvent('emptied'));
  page.video.dispatchEvent(new FakeEvent('playing'));

  check('新视频 B 成功开始播放后，导航锁被正确解除',
    api.videoHandler.stats().cycle.navigated === false);
}

async function runAll() {
  console.log('============================================================');
  console.log('video-auto-player 核心链路回归测试套件 (v1.2.3)');
  console.log('============================================================');

  await testCrossFrameNavigationRecovery();
  await testSingleVideoElementSrcMutation();
  await testMultiTaskPointTabsChained();
  await testNoDuplicateNavigationAcrossFrames();
  await testFormWrappedNextButton();
  await testWatchdogDoesNotRetriggerOnOldVideo();
  await testOldVideoPlayingDoesNotPrematurelyUnlock();

  console.log('============================================================');
  const failed = results.filter((r) => !r.ok);
  console.log(`回归测试统计：共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);

  if (failed.length > 0) {
    console.error('\n以下断言失败：');
    failed.forEach((f) => console.error(`  ✗ ${f.name} → ${f.detail}`));
    process.exit(1);
  }
}

runAll().catch((err) => {
  console.error('测试异常崩溃：', err);
  process.exit(1);
});
