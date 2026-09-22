/**
 * test/run-tests.js —— 开发自测用（**不属于插件运行时的一部分**，安装时可忽略 test 目录）
 *
 * 用一个极简的假 DOM 在 Node 里真实执行 content/ 下的模块，验证：
 *   1. 候选选择器 / 文本打分能挑中“下一节”，而不是“上一节”或目录里的干扰项
 *   2. 视频自然播放结束后，确实点击了正确的按钮
 *   3. 播放时长不足、loop、非自然结束等异常情况一律不触发
 *   4. iframe 子页面找不到按钮时，会向父页面请求协助（postMessage 协调）
 *   5. 跳转后自动播放：只在暂停时尝试，播放中不重复调用
 *
 * 运行： node test/run-tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { FakeElement, FakeVideoElement, FakeEvent } = require('./fake-dom');
const ROOT = path.resolve(__dirname, '..');
const MODULES = [
  'content/logger.js',
  'content/settings.js',
  'content/dom-utils.js',
  'content/button-finder.js',
  'content/frame-messenger.js',
  'content/skip-controller.js',
  'content/rate-controller.js',
  'content/video-handler.js',
  'content/ui.js',
  'content/content.js'
];

// ————————————————————————————————————————————————————————————————
/** 学习通风格的课程页面 */
function buildLessonPage({ withNav = true, style = 'chaoxing' } = {}) {
  const documentElement = new FakeElement('html');
  const body = documentElement.append(new FakeElement('body'));
  const video = body.append(new FakeVideoElement({ duration: 600 }));
  const state = { clicked: [] };

  if (withNav) {
    const catalog = body.append(new FakeElement('div', { class: 'posCatalog_select' }));
    if (style === 'chaoxing') {
      // 真实的超星目录：条目本身也可能带 next 类名，属于干扰项
      catalog.append(new FakeElement('div', { class: 'posCatalog_select_item', text: '1.1 课程导论' }));
      catalog.append(new FakeElement('div', { class: 'posCatalog_select_item current', text: '1.2 本章重点' }));
      catalog.append(new FakeElement('div', { class: 'posCatalog_select_item', text: '1.3 课后练习' }));
      const decoy = catalog.append(new FakeElement('div', {
        class: 'prev_next next',
        text: '下一章 章节测验',
        attrs: { onclick: 'getTeacherAjax(...)' }
      }));
      decoy.addEventListener('click', () => state.clicked.push('decoy-task-point'));

      const nav = body.append(new FakeElement('div', { class: 'prev_next' }));
      const prev = nav.append(new FakeElement('a', { class: 'prev_next prev', text: '上一节', id: 'prevNextFocusPrev' }));
      prev.addEventListener('click', () => state.clicked.push('prev'));
      const next = nav.append(new FakeElement('a', { class: 'prev_next next', text: '下一节', id: 'prevNextFocusNext' }));
      next.addEventListener('click', () => {
        state.clicked.push('next');
        if (state.simulateNavigation !== false) {
          const cur = documentElement.querySelector('.posCatalog_select_item.current, .posCatalog_active');
          if (cur) {
            cur.classList.remove('current');
            cur.classList.remove('posCatalog_active');
            const nextItem = cur.nextElementSibling;
            if (nextItem && nextItem.classList.contains('posCatalog_select_item')) {
              nextItem.classList.add('current');
            }
          }
        }
      });
    } else {
      // 改版后的页面：class 全变了，只剩文字
      const bar = body.append(new FakeElement('div', { class: 'v2-toolbar' }));
      const prev = bar.append(new FakeElement('button', { class: 'btn-plain', text: '上一节', id: 'goPrev' }));
      prev.addEventListener('click', () => state.clicked.push('prev'));
      const next = bar.append(new FakeElement('button', { class: 'btn-plain', text: '下一节', id: 'goNext' }));
      next.addEventListener('click', () => {
        state.clicked.push('next');
        if (state.simulateNavigation !== false) {
          state.navigated = true;
          if (video && video.src) {
            video.src = video.src + '?next=1';
          }
        }
      });
      const hidden = bar.append(new FakeElement('button', { class: 'btn-plain', text: '下一节', style: { display: 'none' } }));
      hidden.addEventListener('click', () => state.clicked.push('hidden-next'));
    }
  }

  return { documentElement, body, video, state };
}

// ————————————————————————————————————————————————————————————————
// 沙箱运行环境
// ————————————————————————————————————————————————————————————————

function createSandbox({ page, storage = {}, isTop = true, logSink = [], parentWindow = null } = {}) {
  const timers = [];
  /** 收集 setInterval 回调，测试里可手动"滴答"推进（结尾兜底轮询需要） */
  const intervals = [];
  /** 收集 MutationObserver，测试动态插入播放器与连续 DOM 变更的时序 */
  const mutationObservers = [];
  const document = {
    documentElement: page.documentElement,
    body: page.body,
    hidden: false,
    querySelectorAll: (sel) => page.documentElement.querySelectorAll(sel),
    querySelector: (sel) => page.documentElement.querySelector(sel),
    createElement: (tag) => new FakeElement(tag),
    addEventListener: (type, fn) => {
      if (!document._listeners) document._listeners = new Map();
      if (!document._listeners.has(type)) document._listeners.set(type, []);
      document._listeners.get(type).push(fn);
    },
    removeEventListener: (type, fn) => {
      if (!document._listeners || !document._listeners.has(type)) return;
      const list = document._listeners.get(type).filter((f) => f !== fn);
      document._listeners.set(type, list);
    },
    dispatchEvent: (event) => {
      ((document._listeners && document._listeners.get(event.type)) || []).forEach((fn) => fn(event));
      return true;
    }
  };
  page.documentElement.walk((node) => { node.ownerDocument = document; });

  const storageData = { autoNext: false, autoRate2x: false, verbose: false, ...storage };
  const storageListeners = [];

  // 虚拟时钟：同一沙箱内的 Date.now() 可以被测试拨动，便于验证限频逻辑
  let virtualNow = Date.now();
  const clock = {
    /** 暴露给沙箱的 Date：其它行为转发给真实 Date，只替换 now() */
    Date: Object.assign(Object.create(Date), { now: () => virtualNow }),
    advance(ms) { virtualNow += ms; return virtualNow; }
  };

  // hostWindow：测试台用来接线/断言的宿主对象
  const hostWindow = {
    location: { href: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1' },
    dispatchEvent: (event) => {
      ((hostWindow._listeners && hostWindow._listeners.get(event.type)) || []).forEach((fn) => fn(event));
      return true;
    },
    sentMessages: []
  };
  hostWindow.addEventListener = (type, fn) => {
    if (!hostWindow._listeners) hostWindow._listeners = new Map();
    if (!hostWindow._listeners.has(type)) hostWindow._listeners.set(type, []);
    hostWindow._listeners.get(type).push(fn);
  };
  hostWindow.removeEventListener = (type, fn) => {
    if (!hostWindow._listeners || !hostWindow._listeners.has(type)) return;
    const list = hostWindow._listeners.get(type).filter((f) => f !== fn);
    hostWindow._listeners.set(type, list);
  };

  // frameWindow：**在 vm realm 内部**的 window 对象，content script 实际操作的就是它。
  // 每个 frame 用独立沙箱加载模块，与浏览器里“每个 frame 各自注入一份”一致。
  const frameWindow = {
    document,
    location: hostWindow.location,
    MouseEvent: FakeEvent,
    PointerEvent: FakeEvent,
    innerWidth: 1280,
    innerHeight: 800,
    getComputedStyle: (el) => ({
      display: el.style.display || 'block',
      visibility: el.style.visibility || 'visible',
      opacity: el.style.opacity || '1'
    }),
    addEventListener: (type, fn) => {
      if (!frameWindow._listeners) frameWindow._listeners = new Map();
      if (!frameWindow._listeners.has(type)) frameWindow._listeners.set(type, []);
      frameWindow._listeners.get(type).push(fn);
    },
    removeEventListener: (type, fn) => {
      if (!frameWindow._listeners || !frameWindow._listeners.has(type)) return;
      const list = frameWindow._listeners.get(type).filter((f) => f !== fn);
      frameWindow._listeners.set(type, list);
    },
    dispatchEvent: (event) => {
      ((frameWindow._listeners && frameWindow._listeners.get(event.type)) || []).forEach((fn) => fn(event));
      return true;
    },
    setTimeout: (fn, ms) => { const id = timers.push({ fn, ms }); return id - 1; },
    clearTimeout: (id) => { if (timers[id]) timers[id].cancelled = true; },
    setInterval: (fn, ms) => { intervals.push({ fn, ms, cancelled: false }); return intervals.length - 1; },
    clearInterval: (id) => { if (intervals[id]) intervals[id].cancelled = true; },
    frames: [],
    postMessage: (message) => { hostWindow.sentMessages.push(message); }
  };
  frameWindow.self = frameWindow;
  /** 测试便利：从沙箱直接取到假页面 */
  frameWindow.__page = page;
  frameWindow.top = isTop ? frameWindow : null; // 子 frame 稍后由 wireFrames 指向父 frame 的 frameWindow
  frameWindow.parent = frameWindow.top;

  const chromeMock = {
    runtime: { id: 'test-extension' },
    storage: {
      local: {
        get: (defaults, cb) => cb({ ...defaults, ...storageData }),
        set: (patch, cb) => { Object.assign(storageData, patch); (cb || (() => {}))(); }
      },
      onChanged: { addListener: (fn) => storageListeners.push(fn) }
    }
  };

  const sandbox = {
    window: frameWindow,
    document,
    chrome: chromeMock,
    __logSink: logSink,
    // 虚拟时钟：倍速的防互抢限频依赖 Date.now()，测试里需要能"拨动"时间
    Date: clock.Date,
    setTimeout: frameWindow.setTimeout,
    clearTimeout: frameWindow.clearTimeout,
    setInterval: frameWindow.setInterval,
    clearInterval: frameWindow.clearInterval,
    HTMLVideoElement: FakeVideoElement,
    HTMLInputElement: FakeElement,
    URL: typeof URL !== 'undefined' ? URL : globalThis.URL,
    location: hostWindow.location,
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        this.active = false;
        mutationObservers.push(this);
      }
      observe() { this.active = true; }
      disconnect() { this.active = false; }
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.self = frameWindow;
  return {
    sandbox, timers, intervals, mutationObservers,
    storageData, storageListeners, clock, windowMock: hostWindow, frameWindow
  };
}

/** 真实执行 content/ 下的模块（顺序与 manifest 一致） */
function loadExtension(sandbox) {
  const context = vm.createContext(sandbox);
  // 注意：console 必须在**上下文内部**创建。
  // 直接把宿主对象塞进 sandbox，经 vm 代理后在模块顶层作用域捕获会丢失目标，
  // 表现为 console.log 静默不执行，测试就变成假阴性了。
  vm.runInContext(
    `globalThis.console = {
       log: (...a) => globalThis.__logSink.push(['log', a.map(String).join(' ')]),
       info: (...a) => globalThis.__logSink.push(['info', a.map(String).join(' ')]),
       warn: (...a) => globalThis.__logSink.push(['warn', a.map(String).join(' ')]),
       error: (...a) => globalThis.__logSink.push(['error', a.map(String).join(' ')]),
       group: () => {}, groupEnd: () => {}
     };`,
    context,
    { filename: 'harness-console' }
  );
  for (const rel of MODULES) {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(code, context, { filename: rel });
  }
  return sandbox.window.AutoNext;
}

/**
 * 推进被 setTimeout 排队的任务（按到期时间顺序），同时拨动虚拟时钟。
 *
 * content script 的 init() 是 async 的（要先 await 读取 storage），
 * 所以每轮之间必须让出事件循环，否则断言会跑在初始化微任务之前。
 *
 * @param {Array} timers 沙箱里的定时器队列
 * @param {{maxRounds?: number, skipDelay?: number, clock?: object}} [opts]
 *        skipDelay：只拨动虚拟时钟、不执行任何定时器（用来越过防互抢的限频窗口）
 */
async function runTimers(timers, { maxRounds = 30, skipDelay = 0, clock = null } = {}) {
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  if (skipDelay > 0) {
    if (clock) clock.advance(skipDelay);
    // 顺带把已经到期的定时器跑掉，模拟真实时间的流逝
    for (const t of timers) {
      if (!t.done && !t.cancelled && t.ms <= skipDelay) {
        t.done = true;
        try { t.fn(); } catch (err) { console.log('  ! 定时任务抛错：', err && err.message); }
        await tick();
      }
    }
    return;
  }

  for (let round = 0; round < maxRounds; round += 1) {
    await tick();
    const pending = timers.filter((t) => !t.done && !t.cancelled);
    if (!pending.length) return;
    pending.sort((a, b) => a.ms - b.ms);
    for (const t of pending) {
      t.done = true;
      if (clock) clock.advance(Math.max(t.ms, 0));
      try {
        t.fn();
      } catch (err) {
        results.push({ name: '定时任务异常', ok: false, detail: String(err && err.message) });
        console.log(`  ✗ 定时任务抛错：${err && err.stack}`);
      }
      await tick();
    }
  }
}

/**
 * 在指定 window 上安装“监听器”，记录收到的所有消息。
 * 用监听器而不是替换 postMessage，是为了绕开 node:vm 跨 realm 取属性时
 * 每次返回不同包装函数、导致身份比较失败的问题。
 */
function captureMessages(win) {
  const box = { received: [] };
  win.addEventListener('message', (event) => box.received.push(event.data));
  return box;
}

/**
 * 建立 frame 树（父子指针 + frames 列表），并给出接线函数。
 * 接线是双向设置的：leaf 发消息走 mid 的 postMessage，
 * 而 mid 转发时走它自己的 postMessage，两条边要分别接对。
 * @param {Array} frames 从顶层到最里层依次排列的沙箱数组
 */
function linkFrames(frames) {
  const caps = frames.map((box) => captureMessages(box.frameWindow));
  for (let i = 1; i < frames.length; i += 1) {
    frames[i].frameWindow.parent = frames[i - 1].frameWindow;
    frames[i].frameWindow.top = frames[0].frameWindow;
    frames[i - 1].frameWindow.frames.push(frames[i].frameWindow);
  }
  const route = (fromIndex, toIndex) => {
    const to = frames[toIndex];
    frames[fromIndex].frameWindow.postMessage = (msg) => {
      caps[toIndex].received.push(msg);
      to.frameWindow.dispatchEvent(Object.assign(new FakeEvent('message'), { data: msg }));
    };
  };
  return {
    caps,
    /** 单向接通：from 发出的消息投递给 to */
    connect(fromIndex, toIndex) {
      route(fromIndex, toIndex);
    },
    /** 双向接通 */
    connectBoth(aIndex, bIndex) {
      route(aIndex, bIndex);
      route(bIndex, aIndex);
    },
    /** 链式接通：0↔1↔2↔…（相邻两层双向） */
    connectChain() {
      for (let i = 1; i < frames.length; i += 1) {
        route(i, i - 1);
        route(i - 1, i);
      }
    }
  };
}

// ————————————————————————————————————————————————————————————————
// 测试用例
// ————————————————————————————————————————————————————————————————

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: !!condition, detail });
  console.log(`${condition ? '  ✓' : '  ✗'} ${name}${condition ? '' : `  → ${detail}`}`);
}

/** 手动"滴答"所有 interval（结尾兜底轮询需要） */
function tickIntervals(intervals, times = 1) {
  for (let i = 0; i < times; i += 1) {
    for (const item of intervals) {
      if (item.cancelled) continue;
      try {
        item.fn();
      } catch (err) {
        console.log('  ! interval 抛错：', err && err.message);
      }
    }
  }
}

function logHas(logSink, needle) {
  return logSink.some(([, line]) => line.includes(needle));
}

async function testChaoxingHappyPath() {
  console.log('\n[1] 超星页面：视频自然结束 → 点击“下一节”');
  const page = buildLessonPage({ style: 'chaoxing' });
  const logSink = [];
  const { sandbox, timers } = createSandbox({ page, storage: { autoNext: true }, logSink });
  const api = loadExtension(sandbox);
  await runTimers(timers);

  check('开关读取为已启用', api.settings.enabled === true, String(api.settings.enabled));
  check('输出 [AutoNext] video detected', logHas(logSink, 'video detected'), JSON.stringify(logSink.slice(0, 3)));

  const candidates = api.buttonFinder.findCandidates();
  check('首选候选是真正的“下一节”按钮', candidates[0] && candidates[0].el.id === 'prevNextFocusNext',
    candidates[0] ? `${candidates[0].el.id || candidates[0].el.className} / score=${candidates[0].score}` : '无候选');
  check('“上一节”被反向词排除', !candidates.some((c) => c.text.includes('上一节')));

  page.video.watch(30);
  page.video.finish();
  check('输出 [AutoNext] video ended', logHas(logSink, 'video ended'));

  await runTimers(timers); // 跳转流程带 800ms 重试延迟，必须先推进定时器
  check('输出 [AutoNext] next lesson found', logHas(logSink, 'next lesson found'), JSON.stringify(logSink.slice(-3)));
  check('输出 [AutoNext] navigating to next lesson', logHas(logSink, 'navigating to next lesson'), JSON.stringify(logSink.slice(-3)));
  check('点击了“下一节”按钮', page.state.clicked.includes('next'), JSON.stringify(page.state.clicked));
  check('没有点到目录里的干扰项', !page.state.clicked.includes('decoy-task-point'), JSON.stringify(page.state.clicked));
  check('没有点到“上一节”', !page.state.clicked.includes('prev'));
  check('没有异常日志', !logHas(logSink, '[AutoNext] undefined'), JSON.stringify(logSink.filter(([, l]) => l.includes('undefined'))));
  if (!page.state.clicked.includes('next')) {
    console.log('    完整日志：');
    logSink.forEach(([level, line]) => console.log(`      [${level}] ${line}`));
    console.log('    未执行的任务：', timers.filter((t) => !t.done).map((t) => `${t.ms}ms${t.cancelled ? '(取消)' : ''}`));
    console.log('    候选：', api.buttonFinder.findCandidates().map((c) => `${c.el.id || c.el.className}=${c.score}`));
  }
}

async function testRedesignedPageTextMatch() {
  console.log('\n[2] 改版页面：class 全变，仅靠文字定位');
  const page = buildLessonPage({ style: 'redesigned' });
  const { sandbox, timers } = createSandbox({ page, storage: { autoNext: true } });
  loadExtension(sandbox);
  await runTimers(timers);
  page.video.watch(30);
  page.video.finish();
  await runTimers(timers);
  check('文字匹配命中可见的“下一节”', page.state.clicked.includes('next'), JSON.stringify(page.state.clicked));
  check('未点击 display:none 的同名按钮', !page.state.clicked.includes('hidden-next'), JSON.stringify(page.state.clicked));
  check('未点击“上一节”', !page.state.clicked.includes('prev'), JSON.stringify(page.state.clicked));
}

async function testGuards() {
  console.log('\n[3] 安全判定：不该触发的情况一律不触发');

  // 3.1 开关关闭
  {
    const page = buildLessonPage({});
    const { sandbox, timers } = createSandbox({ page, storage: { autoNext: false } });
    loadExtension(sandbox);
    await runTimers(timers);
    page.video.watch(30);
    page.video.finish();
    await runTimers(timers);
    check('开关关闭时不做任何跳转', page.state.clicked.length === 0, JSON.stringify(page.state.clicked));
  }

  // 3.2 有效播放时长为 0（用户直接把进度条拖到结尾）
  {
    const page = buildLessonPage({});
    const logSink = [];
    const { sandbox, timers } = createSandbox({ page, storage: { autoNext: true }, logSink });
    loadExtension(sandbox);
    await runTimers(timers);
    page.video.dispatchEvent(new FakeEvent('play'));
    page.video.currentTime = page.video.duration;
    page.video.ended = true;
    page.video.dispatchEvent(new FakeEvent('ended'));
    await runTimers(timers);
    check('拖到结尾（有效播放 0s）不跳转', page.state.clicked.length === 0, JSON.stringify(page.state.clicked));
    check('给出了跳过原因', logHas(logSink, '有效播放时长'), JSON.stringify(logSink.slice(-2)));
  }

  // 3.3 loop 视频
  {
    const page = buildLessonPage({});
    const logSink = [];
    const { sandbox, timers } = createSandbox({ page, storage: { autoNext: true }, logSink });
    loadExtension(sandbox);
    await runTimers(timers);
    page.video.loop = true;
    page.video.watch(30);
    page.video.finish();
    await runTimers(timers);
    check('loop 视频不跳转', page.state.clicked.length === 0, JSON.stringify(page.state.clicked));
    check('提示了 loop 原因', logHas(logSink, 'loop'), JSON.stringify(logSink.slice(-2)));
  }

  // 3.4 页面里根本没有下一节按钮
  {
    const page = buildLessonPage({ withNav: false });
    const logSink = [];
    const { sandbox, timers } = createSandbox({ page, storage: { autoNext: true }, logSink });
    loadExtension(sandbox);
    await runTimers(timers);
    page.video.watch(30);
    page.video.finish();
    await runTimers(timers, { maxRounds: 60 });
    check('找不到下一节时不执行任何点击', page.state.clicked.length === 0);
    check('输出 next lesson not found 提示', logHas(logSink, 'next lesson not found'), JSON.stringify(logSink.slice(-3)));
  }

  // 3.5 时长过短的元素（广告 / 预览）直接忽略
  {
    const page = buildLessonPage({});
    page.video.duration = 8;
    const { sandbox, timers } = createSandbox({ page, storage: { autoNext: true } });
    loadExtension(sandbox);
    await runTimers(timers);
    page.video.watch(8);
    page.video.finish();
    await runTimers(timers);
    check('时长不足 15s 的视频被忽略', page.state.clicked.length === 0, JSON.stringify(page.state.clicked));
  }

  // 3.6 视频确实自然结束了，但只播了 1 秒左右（有效播放不足阈值）
  {
    const page = buildLessonPage({});
    const logSink = [];
    const { sandbox, timers } = createSandbox({ page, storage: { autoNext: true }, logSink });
    loadExtension(sandbox);
    await runTimers(timers);
    page.video.watch(1.5);
    page.video.finish();
    await runTimers(timers);
    check('自然结束但有效播放不足 3s 时不跳转', page.state.clicked.length === 0, JSON.stringify(page.state.clicked));
    check('给出了有效播放不足的原因', logHas(logSink, '有效播放时长'), JSON.stringify(logSink.slice(-2)));
  }

  // 3.7 先正常播放过，再拖到结尾：属于用户主动 seek，不应触发
  {
    const page = buildLessonPage({});
    const logSink = [];
    const { sandbox, timers } = createSandbox({ page, storage: { autoNext: true }, logSink });
    loadExtension(sandbox);
    await runTimers(timers);
    page.video.dispatchEvent(new FakeEvent('play'));
    page.video.currentTime = 100;
    page.video.dispatchEvent(new FakeEvent('timeupdate'));
    page.video.dispatchEvent(new FakeEvent('seeking'));
    page.video.currentTime = page.video.duration;
    page.video.ended = true;
    page.video.dispatchEvent(new FakeEvent('ended'));
    await runTimers(timers);
    check('播放后拖到结尾不跳转（有效播放被重置）', page.state.clicked.length === 0, JSON.stringify(page.state.clicked));
  }
}

/**
 * [4] iframe 场景：播放器在 <iframe> 里，而“下一节”按钮在父页面。
 *
 * 这里刻意不模拟跨 realm 的 postMessage **投递**（node:vm 的多 realm 行为与浏览器有差异，
 * 容易产生假阴性），而是分别验证两件真正重要的事：
 *   a) 子页面自己找不到按钮时，确实按约定向父级发出了协助请求；
 *   b) 父页面收到该请求后，能在自己的 DOM 里找到并点击“下一节”。
 *      —— 这正是浏览器里同一条链路的两个环节。
 */
async function testIframeCoordination() {
  console.log('\n[4] iframe 场景：播放器在子页面，按钮在父页面');

  // a) 子页面（无导航按钮）→ 应发出协助请求
  const childPage = buildLessonPage({ withNav: false });
  const childSink = [];
  const child = createSandbox({ page: childPage, storage: { autoNext: true }, isTop: false, logSink: childSink });
  const childApi = loadExtension(child.sandbox);
  await runTimers(child.timers);

  const sent = [];
  child.frameWindow.postMessage = (message) => sent.push(message);
  child.frameWindow.parent = child.frameWindow.top = { postMessage: child.frameWindow.postMessage };

  check('子页面被识别为 iframe', childApi.messenger.isTop === false);

  childPage.video.watch(30);
  childPage.video.finish();
  await runTimers(child.timers);

  check('子页面发出了协助请求', sent.length > 0, JSON.stringify(sent));
  check('请求消息格式正确',
    sent.length > 0 && sent[0].source === 'auto-next-extension' && sent[0].type === 'AUTO_NEXT_VIDEO_ENDED',
    JSON.stringify(sent[0]));
  check('子页面自身没有乱点', childPage.state.clicked.length === 0, JSON.stringify(childPage.state.clicked));

  // b) 父页面（有视频也有按钮）→ 收到请求后应点击“下一节”
  const parentPage = buildLessonPage({});
  const parentSink = [];
  const parent = createSandbox({ page: parentPage, storage: { autoNext: true }, isTop: true, logSink: parentSink });
  const parentApi = loadExtension(parent.sandbox);
  await runTimers(parent.timers);

  check('父页面被识别为 top', parentApi.messenger.isTop === true);

  parent.frameWindow.dispatchEvent(Object.assign(new FakeEvent('message'), {
    data: { source: 'auto-next-extension', type: 'AUTO_NEXT_VIDEO_ENDED' }
  }));

  check('父页面收到请求后点击了“下一节”', parentPage.state.clicked.includes('next'), JSON.stringify(parentPage.state.clicked));
  check('父页面记录了跳转日志', logHas(parentSink, 'navigating to next lesson'), JSON.stringify(parentSink.slice(-3)));

  // c) 播放器 iframe 与"有按钮的顶层"之间隔着一层：mid 是顶层和 leaf 的共同父级。
  //    postMessage 只能发给直接父/子级，所以必须靠 mid 中继才能爬到顶层。
  {
    const topPage = buildLessonPage({});                  // 顶层：有按钮
    const midPage = buildLessonPage({ withNav: false });  // 中间层：没按钮也没视频
    const leafPage = buildLessonPage({ withNav: false }); // 最里层：有播放器

    const topSink = [];
    const top = createSandbox({ page: topPage, storage: { autoNext: true }, isTop: true, logSink: topSink });
    const mid = createSandbox({ page: midPage, storage: { autoNext: true }, isTop: false, logSink: [] });
    const leaf = createSandbox({ page: leafPage, storage: { autoNext: true }, isTop: false, logSink: [] });
    loadExtension(top.sandbox);
    loadExtension(mid.sandbox);
    loadExtension(leaf.sandbox);

    // 星型：top 是 mid 和 leaf 的直接父级；mid 与 leaf 之间没有直连
    leaf.frameWindow.parent = mid.frameWindow;
    leaf.frameWindow.top = top.frameWindow;
    mid.frameWindow.parent = top.frameWindow;
    mid.frameWindow.top = top.frameWindow;
    top.frameWindow.frames.push(mid.frameWindow, leaf.frameWindow);

    const link = linkFrames([top, mid, leaf]);
    link.connectBoth(0, 1); // top ↔ mid
    link.connectBoth(0, 2); // top ↔ leaf

    await runTimers(top.timers);
    await runTimers(mid.timers);
    await runTimers(leaf.timers);

    check('最里层被识别为非顶层', leaf.sandbox.window.AutoNext.messenger.isTop === false);

    leafPage.video.watch(30);
    leafPage.video.finish();
    await runTimers(leaf.timers);
    await runTimers(mid.timers);
    await runTimers(top.timers);

    const topGotHelp = link.caps[0].received.some((m) => m && m.type === 'AUTO_NEXT_VIDEO_ENDED');
    check('跨层时顶层收到了协助请求', topGotHelp, JSON.stringify(link.caps[0].received.map((m) => m && m.type)));
    check('跨层时顶层按钮被点击', topPage.state.clicked.includes('next'), JSON.stringify(topPage.state.clicked));
    check('跨层时中间层没有乱点', midPage.state.clicked.length === 0, JSON.stringify(midPage.state.clicked));
    check('跨层时最里层没有乱点', leafPage.state.clicked.length === 0, JSON.stringify(leafPage.state.clicked));
  }

  // d) 手工接线的三层链路（top ← mid ← leaf）：
  //    leaf 的直接父级 mid 没有按钮，靠 mid 主动向上中继把请求送到 top。
  //    说明：本测试台用 node:vm 的多个 realm 模拟 iframe，替换 postMessage 时
  //    会受到跨 realm 属性包装的影响，链式拓扑下的自动接线不可靠；
  //    因此这里显式接线，只验证产品代码的中继逻辑本身。
  {
    const boxes = [
      createSandbox({ page: buildLessonPage({}), storage: { autoNext: true }, isTop: true, logSink: [] }),
      createSandbox({ page: buildLessonPage({ withNav: false }), storage: { autoNext: true }, isTop: false, logSink: [] }),
      createSandbox({ page: buildLessonPage({ withNav: false }), storage: { autoNext: true }, isTop: false, logSink: [] })
    ];
    const [top, mid, leaf] = boxes;
    boxes.forEach((box) => loadExtension(box.sandbox));

    mid.frameWindow.parent = top.frameWindow;
    mid.frameWindow.top = top.frameWindow;
    leaf.frameWindow.parent = mid.frameWindow;
    leaf.frameWindow.top = top.frameWindow;

    leaf.frameWindow.postMessage = (msg) => {
      mid.frameWindow.dispatchEvent(Object.assign(new FakeEvent('message'), { data: msg }));
    };
    mid.frameWindow.postMessage = (msg) => {
      top.frameWindow.dispatchEvent(Object.assign(new FakeEvent('message'), { data: msg }));
    };
    top.frameWindow.postMessage = () => { /* 顶层不需要向下发 */ };

    for (const box of boxes) await runTimers(box.timers);

    leaf.frameWindow.__page.video.watch(30);
    leaf.frameWindow.__page.video.finish();
    for (const box of boxes) await runTimers(box.timers);

    check('链式三层：中间层向上中继，顶层完成点击', top.frameWindow.__page.state.clicked.includes('next'),
      JSON.stringify(boxes.map((box) => box.frameWindow.__page.state.clicked)));
    check('链式三层：中间层没有乱点', mid.frameWindow.__page.state.clicked.length === 0,
      JSON.stringify(mid.frameWindow.__page.state.clicked));
    check('链式三层：最里层没有乱点', leaf.frameWindow.__page.state.clicked.length === 0,
      JSON.stringify(leaf.frameWindow.__page.state.clicked));
  }
}

async function testAutoPlayAfterNavigation() {
  console.log('\n[5] 跳转后自动播放：只在暂停时尝试，播放中不重复调用');
  const page = buildLessonPage({});
  const { sandbox, timers } = createSandbox({ page, storage: { autoNext: true } });
  const api = loadExtension(sandbox);
  await runTimers(timers);
  page.video.paused = true;
  const before = page.video.playCalls;

  api.videoHandler.tryAutoPlay(page.video);
  api.videoHandler.tryAutoPlay(page.video);
  check('暂停中的视频被自动播放一次', page.video.playCalls === before + 1, `calls=${page.video.playCalls - before}`);

  page.video.paused = false;
  api.videoHandler.tryAutoPlay(page.video);
  check('正在播放的视频不会被重复 play()', page.video.playCalls === before + 1, `calls=${page.video.playCalls - before}`);
}

async function testAutoRate2x() {
  console.log('\n[6] 自动二倍速');

  // 6.1 检测到视频即设为 2.0
  {
    const page = buildLessonPage({});
    const logSink = [];
    const { sandbox, timers } = createSandbox({ page, storage: { autoRate2x: true }, logSink });
    const api = loadExtension(sandbox);
    await runTimers(timers);
    check('检测到视频后 playbackRate = 2.0', page.video.playbackRate === 2, String(page.video.playbackRate));
    check('输出 playback rate -> 2x 日志', logHas(logSink, 'playback rate -> 2x'), JSON.stringify(logSink.slice(-2)));
    check('stats 里能看到倍速', api.videoHandler.stats().rates[0].rate === 2);
  }

  // 6.2 开关关闭时绝不改动倍速
  {
    const page = buildLessonPage({});
    const { sandbox, timers } = createSandbox({ page, storage: { autoNext: true } });
    loadExtension(sandbox);
    await runTimers(timers);
    page.video.watch(10);
    check('开关关闭时保持 1.0x', page.video.playbackRate === 1, String(page.video.playbackRate));
  }

  // 6.3 页面把倍速改回 1.0 → 应恢复为 2.0
  {
    const page = buildLessonPage({});
    const { sandbox, timers, clock } = createSandbox({ page, storage: { autoRate2x: true } });
    loadExtension(sandbox);
    await runTimers(timers);
    // 让过防互抢的限频窗口（真实页面重置倍速都在加载/播放时，通常已经过了这个窗口）
    await runTimers(timers, { skipDelay: 400, clock });
    page.video.resetRateBySite(1);
    check('页面改回 1.0 后自动恢复 2.0', page.video.playbackRate === 2, String(page.video.playbackRate));

    await runTimers(timers, { skipDelay: 400, clock });
    page.video.resetRateBySite(1.5);
    check('页面改成 1.5 也恢复为 2.0', page.video.playbackRate === 2, String(page.video.playbackRate));
  }

  // 6.3b 页面在插件刚设完就立刻改回（紧贴限频窗口）→ 排重试后仍要恢复
  {
    const page = buildLessonPage({});
    const { sandbox, timers, clock } = createSandbox({ page, storage: { autoRate2x: true } });
    loadExtension(sandbox);
    await runTimers(timers);
    page.video.resetRateBySite(1); // 与刚设完 2.0 几乎同一时刻
    check('紧贴限频窗口时暂不硬抢（先让一步）', page.video.playbackRate === 1, String(page.video.playbackRate));
    await runTimers(timers); // 推进被推迟的恢复任务
    check('限频窗口结束后仍然恢复为 2.0', page.video.playbackRate === 2, String(page.video.playbackRate));
    check('恢复动作没有死循环', page.video.rateChangeCount <= 6, `rateChangeCount=${page.video.rateChangeCount}`);
  }

  // 6.4 loadedmetadata / play 时重新检查
  {
    const page = buildLessonPage({});
    const { sandbox, timers, clock } = createSandbox({ page, storage: { autoRate2x: true } });
    loadExtension(sandbox);
    await runTimers(timers);
    // 模拟播放器在加载新源时静默重置（不触发 ratechange 的情况）
    page.video._playbackRate = 1;
    page.video.dispatchEvent(new FakeEvent('loadedmetadata'));
    check('loadedmetadata 时重新设为 2.0', page.video.playbackRate === 2, String(page.video.playbackRate));

    page.video._playbackRate = 1;
    page.video.dispatchEvent(new FakeEvent('play'));
    check('play 时重新设为 2.0', page.video.playbackRate === 2, String(page.video.playbackRate));
  }

  // 6.5 不能死循环：ratechange 次数应有限
  {
    const page = buildLessonPage({});
    const { sandbox, timers, clock } = createSandbox({ page, storage: { autoRate2x: true } });
    loadExtension(sandbox);
    await runTimers(timers);
    page.video.watch(20);
    // 插件自己设一次 2.0 → 1 次 ratechange；页面改回 1.0 → 再 1 次，之后恢复 2.0 → 再 1 次
    check('ratechange 未被无限触发', page.video.rateChangeCount <= 6,
      `rateChangeCount=${page.video.rateChangeCount}`);

    const before = page.video.rateChangeCount;
    page.video.playbackRate = 2; // 已经是 2.0，再设一次不该产生事件
    check('已经是 2.0 时重复赋值不产生 ratechange', page.video.rateChangeCount === before,
      `before=${before} after=${page.video.rateChangeCount}`);
  }

  // 6.6 页面反复改回 1.0：有限频保护，不会与页面互抢
  {
    const page = buildLessonPage({});
    const { sandbox, timers, clock } = createSandbox({ page, storage: { autoRate2x: true } });
    loadExtension(sandbox);
    await runTimers(timers);
    for (let i = 0; i < 20; i += 1) page.video.resetRateBySite(1);
    await runTimers(timers); // 推进被推迟的恢复任务
    check('连续被改回时最终仍恢复到 2.0', page.video.playbackRate === 2, String(page.video.playbackRate));
    check('连续被改回时触发次数受限', page.video.rateChangeCount < 60, `rateChangeCount=${page.video.rateChangeCount}`);
  }

  // 6.7 跳转下一节后（换源）依然生效
  {
    const page = buildLessonPage({});
    const { sandbox, timers } = createSandbox({ page, storage: { autoNext: true, autoRate2x: true } });
    loadExtension(sandbox);
    await runTimers(timers);
    page.video.watch(30);
    page.video.finish();
    await runTimers(timers);

    // 模拟 SPA 换到下一节：同一个 <video> 换源并重置倍速
    page.video.currentSrc = 'https://example.com/media/lesson2.mp4';
    page.video._playbackRate = 1;
    page.video.dispatchEvent(new FakeEvent('emptied'));
    check('换源（下一节）后恢复 2.0', page.video.playbackRate === 2, String(page.video.playbackRate));
  }

  // 6.7b 页面重新创建播放器（动态插入新的 <video>）
  {
    const page = buildLessonPage({});
    const second = page.body.append(new FakeVideoElement({ duration: 500, src: 'https://example.com/media/lesson3.mp4' }));
    const { sandbox, timers, clock } = createSandbox({ page, storage: { autoRate2x: true } });
    loadExtension(sandbox);
    await runTimers(timers);
    check('页面内多个播放器都被设为 2.0',
      page.video.playbackRate === 2 && second.playbackRate === 2,
      `${page.video.playbackRate} / ${second.playbackRate}`);
  }

  // 6.8 弹窗开关运行中切换（storage.onChanged）应立即生效
  {
    const page = buildLessonPage({});
    const { sandbox, timers, storageListeners } = createSandbox({ page, storage: { autoRate2x: false } });
    loadExtension(sandbox);
    await runTimers(timers);
    check('初始关闭时为 1.0x', page.video.playbackRate === 1, String(page.video.playbackRate));

    // 模拟 popup 打开开关
    sandbox.chrome.storage.local.set({ autoRate2x: true });
    storageListeners.forEach((fn) => fn({ autoRate2x: { newValue: true } }, 'local'));
    check('开关打开后立即变为 2.0', page.video.playbackRate === 2, String(page.video.playbackRate));

    // 模拟 popup 关闭开关
    storageListeners.forEach((fn) => fn({ autoRate2x: { newValue: false } }, 'local'));
    check('开关关闭后恢复为 1.0', page.video.playbackRate === 1, String(page.video.playbackRate));
  }

  // 6.9 iframe：播放器在子 frame 时，二倍速也在该 frame 内生效
  {
    const childPage = buildLessonPage({ withNav: false });
    const { sandbox, timers } = createSandbox({ page: childPage, storage: { autoRate2x: true }, isTop: false });
    const api = loadExtension(sandbox);
    await runTimers(timers);
    check('iframe 内的播放器也被设为 2.0', childPage.video.playbackRate === 2, String(childPage.video.playbackRate));
    check('iframe 内 stats 报告倍速与开关',
      api.videoHandler.stats().rates[0].rate === 2 && api.videoHandler.stats().autoRate2x === true,
      JSON.stringify(api.videoHandler.stats().rates));
  }
}

async function testWatchdogFinish() {
  console.log('\n[7] 结尾兜底：平台在结尾自行暂停、不触发 ended 的事件');

  /**
   * 复现真实场景：学习通播放器在视频末尾自己 pause()，
   * 原生 ended 事件**不触发**，只监听 ended 的插件会永远等下去。
   */
  const scaffold = async (page) => {
    const logSink = [];
    const box = createSandbox({ page, storage: { autoNext: true }, logSink });
    const api = loadExtension(box.sandbox);
    await runTimers(box.timers);
    return { ...box, api, logSink };
  };

  // 7.1 播到结尾但没触发 ended → 兜底检测应触发跳转
  {
    const page = buildLessonPage({});
    const { timers, intervals, logSink, api } = await scaffold(page);

    page.video.watch(30); // 真的看了一会儿（有效播放 > 3s）
    // 关键：模拟平台行为 —— 直接暂停在结尾，不派发 ended
    page.video.currentTime = page.video.duration;
    page.video.ended = false;
    page.video.paused = true;
    page.video.readyState = 4;

    tickIntervals(intervals);
    check('单次疑似播完不立即跳转（防缓冲误判）',
      !logHas(logSink, '未触发 ended 事件'), JSON.stringify(logSink.slice(-2)));
    tickIntervals(intervals);
    check('连续确认后才触发兜底跳转', logHas(logSink, '未触发 ended 事件'), JSON.stringify(logSink.slice(-3)));

    await runTimers(timers);
    tickIntervals(intervals);
    await runTimers(timers);
    check('兜底检测成功点击“下一节”', page.state.clicked.includes('next'), JSON.stringify(page.state.clicked));
    check('诊断标记为兜底完成', api.videoHandler.diagnostics().finishedByWatchdog === true,
      JSON.stringify(api.videoHandler.diagnostics()));
  }

  // 7.1b 距离结尾仍有数秒时先恢复播放，绝不能提前跳转
  {
    const page = buildLessonPage({});
    const { timers, intervals } = await scaffold(page);

    page.video.watch(30);
    page.video.currentTime = page.video.duration - 2.5;
    page.video.paused = true;
    page.video.ended = false;
    page.video.readyState = 4;
    page.video.dispatchEvent(new FakeEvent('pause'));

    tickIntervals(intervals, 4);
    await runTimers(timers);

    check('距离结尾仍有 2.5 秒且 ended 未触发时绝不提前点击下一节',
      page.state.clicked.length === 0,
      JSON.stringify(page.state.clicked));
    check('结尾前的异常暂停会恢复播放以完成最后几秒',
      page.video.paused === false,
      `paused=${page.video.paused}`);
  }

  // 7.2 正常播放中绝不能被兜底误触发
  {
    const page = buildLessonPage({});
    const { intervals, logSink } = await scaffold(page);

    page.video.watch(30); // 播放中，进度远未到结尾
    tickIntervals(intervals, 5);
    check('播放中不会被兜底误触发', page.state.clicked.length === 0, JSON.stringify(page.state.clicked));
    check('播放中没有兜底日志', !logHas(logSink, '未触发 ended 事件'), JSON.stringify(logSink.slice(-2)));
  }

  // 7.3 拖到结尾（有效播放不足）时，兜底也必须被安全判定拦住
  {
    const page = buildLessonPage({});
    const { intervals, logSink, api } = await scaffold(page);

    // 先让视频开始播放（满足 曾播放过），再立刻拖到结尾 —— played 仍然是 0
    page.video.readyState = 4;
    page.video.dispatchEvent(new FakeEvent('play'));
    page.video.currentTime = page.video.duration;
    page.video.paused = true;
    tickIntervals(intervals, 5);
    check('拖到结尾不会被兜底当成看完', page.state.clicked.length === 0, JSON.stringify(page.state.clicked));
    check('兜底被有效播放时长拦下', logHas(logSink, '有效播放时长'), JSON.stringify(logSink.slice(-2)));
  }

  // 7.6 缓冲卡顿：暂停 + 接近结尾 + 数据未就绪 → 绝不能被当成播完
  //    这正是"视频播几秒就暂停"那类误判的防线
  {
    const page = buildLessonPage({});
    const { intervals, logSink } = await scaffold(page);

    page.video.watch(30); // 正常播放了一段
    page.video.currentTime = page.video.duration - 1; // 接近结尾
    page.video.paused = true; // 缓冲卡顿
    page.video.readyState = 1; // 数据没准备好
    tickIntervals(intervals, 8);
    check('缓冲卡顿时不判定为播完', page.state.clicked.length === 0, JSON.stringify(page.state.clicked));
    check('缓冲卡顿时没有跳转日志', !logHas(logSink, '未触发 ended 事件'), JSON.stringify(logSink.slice(-2)));

    // 数据恢复、继续播放 → 依然不能跳
    page.video.readyState = 4;
    page.video.paused = false;
    page.video.dispatchEvent(new FakeEvent('timeupdate'));
    tickIntervals(intervals, 8);
    check('恢复播放后仍不跳', page.state.clicked.length === 0, JSON.stringify(page.state.clicked));
  }

  // 7.7 页面刚加载、从没播放过 → 兜底不能认账
  {
    const page = buildLessonPage({});
    const { intervals, logSink } = await scaffold(page);

    page.video.readyState = 4;
    page.video.currentTime = page.video.duration;
    page.video.paused = true;
    tickIntervals(intervals, 8);
    check('从未播放过时不判定为播完', page.state.clicked.length === 0, JSON.stringify(page.state.clicked));
    check('从未播放过时没有跳转日志', !logHas(logSink, '未触发 ended 事件'), JSON.stringify(logSink.slice(-2)));
  }

  // 7.4 正常 ended 仍然优先，兜底不能造成第二次跳转
  {
    const page = buildLessonPage({});
    const { timers, intervals } = await scaffold(page);

    page.video.watch(30);
    page.video.finish(); // 原生 ended 正常触发
    await runTimers(timers);
    const firstCount = page.state.clicked.filter((x) => x === 'next').length;
    tickIntervals(intervals, 10); // 兜底再跑很多轮
    check('原生 ended 后兜底不会重复跳转', page.state.clicked.filter((x) => x === 'next').length === firstCount,
      JSON.stringify(page.state.clicked));
  }

  // 7.5 开关关闭时兜底不工作
  {
    const page = buildLessonPage({});
    const logSink = [];
    const box = createSandbox({ page, storage: { autoNext: false }, logSink });
    loadExtension(box.sandbox);
    await runTimers(box.timers);
    page.video.watch(30);
    page.video.currentTime = page.video.duration;
    page.video.paused = true;
    tickIntervals(box.intervals, 5);
    check('开关关闭时兜底不跳转', page.state.clicked.length === 0, JSON.stringify(page.state.clicked));
  }
}


async function testSkipNonVideo() {
  console.log('\n[8] 自动跳过非视频页面');

  /** 造一个“没有视频”的页面（只有下一节按钮），模拟测验/讨论章节 */
  const buildNoVideoPage = () => {
    const documentElement = new FakeElement('html');
    const body = documentElement.append(new FakeElement('body'));
    const state = { clicked: [] };
    const nav = body.append(new FakeElement('div', { class: 'prev_next' }));
    const next = nav.append(new FakeElement('a', { class: 'prev_next next', text: '下一节', id: 'prevNextFocusNext' }));
    next.addEventListener('click', () => state.clicked.push('next'));
    return { documentElement, body, state, video: null };
  };

  // 8.1 开关关闭时绝不动作（这是默认行为）
  {
    const page = buildNoVideoPage();
    const { sandbox, timers } = createSandbox({ page, storage: { autoNext: true } });
    const api = loadExtension(sandbox);
    await runTimers(timers);
    check('开关关闭时不跳过', page.state.clicked.length === 0, JSON.stringify(page.state.clicked));
    check('跳过控制器报告未启用', api.skipController.isEnabled() === false);
  }

  // 8.2 开关打开：没有视频的页面应自动点“下一节”
  {
    const page = buildNoVideoPage();
    const logSink = [];
    const { sandbox, timers } = createSandbox({ page, storage: { autoNext: true, autoSkipNonVideo: true }, logSink });
    const api = loadExtension(sandbox);
    await runTimers(timers);
    check('非视频页面被自动跳过', page.state.clicked.includes('next'), JSON.stringify(page.state.clicked));
    check('输出跳过日志', logHas(logSink, '非视频页面，继续下一节'), JSON.stringify(logSink.slice(-3)));
    check('跳过计数为 1', api.skipController.diagnostics().consecutiveSkips === 1,
      JSON.stringify(api.skipController.diagnostics()));
  }

  // 8.3 有视频的页面不该被跳过
  {
    const page = buildLessonPage({});
    const { sandbox, timers } = createSandbox({ page, storage: { autoNext: true, autoSkipNonVideo: true } });
    loadExtension(sandbox);
    await runTimers(timers);
    check('有视频的页面不跳过', page.state.clicked.length === 0, JSON.stringify(page.state.clicked));
  }

  // 8.4 连续跳过达到上限必须停止（防止把整门课一路点过去）
  {
    const page = buildNoVideoPage();
    const { sandbox, timers, clock } = createSandbox({ page, storage: { autoNext: true, autoSkipNonVideo: true } });
    const api = loadExtension(sandbox);
    api.skipController.configure({ maxConsecutiveSkips: 3, waitAfterClickMs: 10, settleMs: 10 });
    await runTimers(timers);

    // 页面地址始终不变：模拟“点了没反应”，应被上限或死循环保护拦住
    for (let i = 0; i < 8; i += 1) {
      await runTimers(timers);
      clock.advance(2000);
    }
    const diag = api.skipController.diagnostics();
    check('跳过次数不超过上限', diag.consecutiveSkips <= 3, JSON.stringify(diag));
    check('点击次数不超过上限', page.state.clicked.length <= 3, String(page.state.clicked.length));
    check('给出了停止原因', !!diag.lastStopReason, JSON.stringify(diag));
  }

  // 8.5 有视频时 attemptSkip 直接返回，不计数
  {
    const page = buildLessonPage({});
    const { sandbox, timers } = createSandbox({ page, storage: { autoNext: true, autoSkipNonVideo: true } });
    const api = loadExtension(sandbox);
    await runTimers(timers);
    api.skipController.attemptSkip('测试');
    check('有视频时不计入跳过', api.skipController.diagnostics().consecutiveSkips === 0,
      JSON.stringify(api.skipController.diagnostics()));
  }

  // 8.6 找不到“下一节”时不乱点
  {
    const documentElement = new FakeElement('html');
    const body = documentElement.append(new FakeElement('body'));
    const page = { documentElement, body, state: { clicked: [] }, video: null };
    const { sandbox, timers } = createSandbox({ page, storage: { autoNext: true, autoSkipNonVideo: true } });
    loadExtension(sandbox);
    await runTimers(timers);
    check('没有下一节按钮时不做任何操作', page.state.clicked.length === 0, JSON.stringify(page.state.clicked));
  }
}


async function testAutoPlayRetry() {
  console.log('\n[9] 跳转后自动播放：被拦截要重试，不能只试一次');

  // 9.1 前两次被浏览器拒绝 → 后续重试必须成功，视频不能永久停住
  {
    const page = buildLessonPage({});
    page.video.failPlayTimes = 2; // 前 2 次 play() 被拒绝
    const { sandbox, timers, intervals } = createSandbox({ page, storage: { autoNext: true } });
    const api = loadExtension(sandbox);
    await runTimers(timers);

    api.videoHandler.startPlayGrace('测试');
    for (let i = 0; i < 6; i += 1) {
      tickIntervals(intervals, 1);
      await runTimers(timers, { maxRounds: 4 });
    }
    check('被拒绝后最终播放成功', page.video.paused === false,
      `paused=${page.video.paused} calls=${page.video.playCalls} rejections=${page.video.playRejections}`);
    check('确实经历了多次尝试', page.video.playCalls >= 3, String(page.video.playCalls));
    check('尝试次数不超过上限', api.videoHandler.diagnostics().autoPlayAttempts <= 4,
      String(api.videoHandler.diagnostics().autoPlayAttempts));
  }

  // 9.2 视频已经播起来了 → 重试必须立即停手，绝不抢控制权
  {
    const page = buildLessonPage({});
    const { sandbox, timers, intervals } = createSandbox({ page, storage: { autoNext: true } });
    const api = loadExtension(sandbox);
    await runTimers(timers);

    page.video.paused = false; // 已经在播放
    const before = page.video.playCalls;
    api.videoHandler.startPlayGrace('测试');
    tickIntervals(intervals, 6);
    check('已在播放时不再调用 play()', page.video.playCalls === before, `${before} → ${page.video.playCalls}`);
  }

  // 9.3 尝试次数用尽后必须停手（不能无限重试）
  {
    const page = buildLessonPage({});
    page.video.failPlayTimes = 99; // 永远被拒绝
    const { sandbox, timers, intervals } = createSandbox({ page, storage: { autoNext: true } });
    const api = loadExtension(sandbox);
    await runTimers(timers);

    api.videoHandler.startPlayGrace('测试');
    for (let i = 0; i < 10; i += 1) {
      tickIntervals(intervals, 1);
      await runTimers(timers, { maxRounds: 4 });
    }
    const attempts = api.videoHandler.diagnostics().autoPlayAttempts;
    check('一直失败也不会无限重试', attempts <= 4, String(attempts));
  }

  // 9.4 首次播放成功后，平台可能稍后又把视频暂停；宽限期内应继续守护
  {
    const page = buildLessonPage({});
    const { sandbox, timers, intervals } = createSandbox({ page, storage: { autoNext: true } });
    const api = loadExtension(sandbox);
    await runTimers(timers);

    api.videoHandler.startPlayGrace('测试');
    check('首次自动播放成功', page.video.paused === false, `paused=${page.video.paused}`);

    // 先经过一次轮询，让旧逻辑因“已经播放”提前撤掉守护；随后模拟平台延迟暂停。
    tickIntervals(intervals, 1);
    page.video.currentTime = 30;
    page.video.paused = true;
    page.video.dispatchEvent(new FakeEvent('pause'));
    const before = page.video.playCalls;

    tickIntervals(intervals, 2);
    await runTimers(timers, { maxRounds: 4 });
    check('自动播放后又被暂停时会在宽限期内恢复',
      page.video.paused === false && page.video.playCalls === before + 1,
      `paused=${page.video.paused} calls=${before}→${page.video.playCalls}`);
  }

  // 9.5 宽限期结束后尊重用户/平台状态，不再持续抢播放控制权
  {
    const page = buildLessonPage({});
    const { sandbox, timers, intervals, clock } = createSandbox({ page, storage: { autoNext: true } });
    const api = loadExtension(sandbox);
    await runTimers(timers);

    api.videoHandler.configure({ playGraceMs: 3000, playGraceIntervalMs: 500 });
    api.videoHandler.startPlayGrace('测试');
    clock.advance(3000);
    tickIntervals(intervals, 1); // 到期并撤销守护

    page.video.currentTime = 30;
    page.video.paused = true;
    const before = page.video.playCalls;
    tickIntervals(intervals, 3);
    check('自动播放宽限期结束后不再强制恢复',
      page.video.paused === true && page.video.playCalls === before,
      `paused=${page.video.paused} calls=${before}→${page.video.playCalls}`);
  }

  // 9.6 后台暂停是平台的可见性规则，不能强行恢复
  {
    const page = buildLessonPage({});
    const { sandbox, timers, intervals } = createSandbox({ page, storage: { autoNext: true } });
    const api = loadExtension(sandbox);
    await runTimers(timers);

    api.videoHandler.startPlayGrace('测试');
    sandbox.document.hidden = true;
    page.video.currentTime = 30;
    page.video.paused = true;
    const before = page.video.playCalls;
    tickIntervals(intervals, 2);
    check('页面在后台时不强制恢复播放',
      page.video.paused === true && page.video.playCalls === before,
      `paused=${page.video.paused} calls=${before}→${page.video.playCalls}`);
  }

  // 9.7 SPA 换页期间仍残留的旧播放器已经结束，不能被误播
  {
    const page = buildLessonPage({});
    const { sandbox, timers } = createSandbox({ page, storage: { autoNext: true } });
    const api = loadExtension(sandbox);
    await runTimers(timers);

    page.video.currentTime = page.video.duration;
    page.video.ended = true;
    page.video.paused = true;
    const before = page.video.playCalls;
    const attempted = api.videoHandler.tryAutoPlay(page.video, '测试旧播放器');
    check('已经结束的旧播放器不会被重新播放',
      attempted === false && page.video.playCalls === before,
      `attempted=${attempted} calls=${before}→${page.video.playCalls}`);
  }

  // 9.8 学习通“任务点完成前不可倍速”：2x 会被平台立刻暂停，应退回 1x 后继续播放
  {
    const page = buildLessonPage({});
    const { sandbox, timers, intervals } = createSandbox({
      page,
      storage: { autoNext: true, autoRate2x: true }
    });
    const api = loadExtension(sandbox);
    await runTimers(timers);

    // 模拟真实播放器：play() 本身成功，但平台发现未完成任务点使用 2x 后立即 pause()。
    const restrictedSrc = page.video.currentSrc;
    page.video.addEventListener('play', () => {
      if (page.video.currentSrc !== restrictedSrc) return;
      if (page.video.playbackRate <= 1.01) return;
      page.video.currentTime = 3.7;
      page.video.paused = true;
      page.video.dispatchEvent(new FakeEvent('pause'));
    });
    page.video.play = function playWithCoursePolicy() {
      this.playCalls += 1;
      this.paused = false;
      this.dispatchEvent(new FakeEvent('play'));
      if (!this.paused) this.dispatchEvent(new FakeEvent('playing'));
      return Promise.resolve();
    };

    page.video.paused = true;
    api.videoHandler.startPlayGrace('测试禁倍速课程');
    tickIntervals(intervals, 2);
    await runTimers(timers, { maxRounds: 6 });

    check('禁倍速课程会自动回退到 1.0x',
      Math.abs(page.video.playbackRate - 1) <= 0.01,
      `rate=${page.video.playbackRate}`);
    check('回退到 1.0x 后新视频能自动开始且不再被暂停',
      page.video.paused === false && page.video.playCalls >= 2,
      `paused=${page.video.paused} calls=${page.video.playCalls}`);

    // 之后即使再次收到 play 事件，也不能把这个受限视频重新强制到 2x。
    page.video.dispatchEvent(new FakeEvent('play'));
    check('手动播放受限视频时不会再次强制 2x 导致暂停',
      page.video.paused === false && Math.abs(page.video.playbackRate - 1) <= 0.01,
      `paused=${page.video.paused} rate=${page.video.playbackRate}`);

    // 换源后重新判断：不能因为这一节受限，就永久关闭后续视频的二倍速。
    page.video.currentSrc = 'https://example.com/media/lesson-after-restricted.mp4';
    page.video.src = page.video.currentSrc;
    page.video.currentTime = 0;
    page.video.ended = false;
    page.video.paused = true;
    page.video._playbackRate = 1;
    page.video.dispatchEvent(new FakeEvent('emptied'));
    api.rateController.apply(page.video, '换源测试');
    check('换到下一视频后会重新尝试二倍速',
      Math.abs(page.video.playbackRate - 2) <= 0.01,
      `rate=${page.video.playbackRate}`);
  }

  // 9.9 已播放几十秒后被平台中途暂停：不应受“跳转后 6 秒”限制
  {
    const page = buildLessonPage({});
    const { sandbox, timers, intervals, clock } = createSandbox({ page, storage: { autoNext: true } });
    loadExtension(sandbox);
    await runTimers(timers);

    page.video.watch(43);
    clock.advance(10000); // 明确越过跳转后的自动播放宽限期
    const before = page.video.playCalls;
    page.video.paused = true;
    page.video.readyState = 4;
    page.video.dispatchEvent(new FakeEvent('pause'));
    await runTimers(timers, { maxRounds: 6, clock });
    tickIntervals(intervals, 2);

    check('播放几十秒后意外暂停会自动恢复',
      page.video.paused === false && page.video.playCalls === before + 1,
      `paused=${page.video.paused} calls=${before}→${page.video.playCalls}`);
  }

  // 9.10 缓冲时先不强播；数据恢复后应继续播放
  {
    const page = buildLessonPage({});
    const { sandbox, timers, intervals, clock } = createSandbox({ page, storage: { autoNext: true } });
    loadExtension(sandbox);
    await runTimers(timers);

    page.video.watch(116);
    clock.advance(10000);
    const before = page.video.playCalls;
    page.video.paused = true;
    page.video.readyState = 1;
    page.video.dispatchEvent(new FakeEvent('pause'));
    await runTimers(timers, { maxRounds: 4, clock });
    check('缓冲数据不足时不会立刻强播',
      page.video.paused === true && page.video.playCalls === before,
      `paused=${page.video.paused} calls=${before}→${page.video.playCalls}`);

    page.video.readyState = 4;
    tickIntervals(intervals, 2);
    await runTimers(timers, { maxRounds: 4, clock });
    check('缓冲数据恢复后自动继续播放',
      page.video.paused === false && page.video.playCalls === before + 1,
      `paused=${page.video.paused} calls=${before}→${page.video.playCalls}`);
  }

  // 9.11 下一节重建 iframe 后，元数据可能早于脚本注入；首次扫描就应启动播放
  {
    const page = buildLessonPage({});
    page.video.paused = true;
    page.video.readyState = 4;
    const { sandbox, timers } = createSandbox({ page, storage: { autoNext: true } });
    loadExtension(sandbox);
    await runTimers(timers);

    check('新 iframe 首次扫描到已就绪视频时会自动播放',
      page.video.paused === false && page.video.playCalls >= 1,
      `paused=${page.video.paused} calls=${page.video.playCalls}`);
  }

  // 9.12 学习通先插入 video、随后连续更新普通控件时，不能让后一批变更吞掉播放器信号
  {
    const page = buildLessonPage({});
    page.body.children = page.body.children.filter((node) => node !== page.video);
    page.video.isConnected = false;
    const { sandbox, timers, mutationObservers } = createSandbox({ page, storage: { autoNext: true } });
    loadExtension(sandbox);
    await runTimers(timers);

    const delayedVideo = page.body.append(new FakeVideoElement({ duration: 156 }));
    delayedVideo.readyState = 4;
    delayedVideo.ownerDocument = sandbox.document;
    const ordinaryControl = page.body.append(new FakeElement('div', { class: 'player-control' }));
    ordinaryControl.ownerDocument = sandbox.document;

    const observer = mutationObservers.find((item) => item.active);
    observer.callback([{ addedNodes: [delayedVideo] }]);
    observer.callback([{ addedNodes: [ordinaryControl] }]);
    await runTimers(timers);

    check('连续普通 DOM 更新不会吞掉延迟出现的视频',
      delayedVideo.dataset.autoNextBound === '1' && delayedVideo.paused === false,
      `bound=${delayedVideo.dataset.autoNextBound || '0'} paused=${delayedVideo.paused}`);
  }

  // 9.13 preload=none 的新播放器只有调用 play() 才会开始加载元数据，不能因 duration=NaN 永久等待
  {
    const page = buildLessonPage({});
    page.body.children = page.body.children.filter((node) => node !== page.video);
    page.video.isConnected = false;
    const { sandbox, timers, mutationObservers } = createSandbox({ page, storage: { autoNext: true } });
    loadExtension(sandbox);
    await runTimers(timers);

    const unloadedVideo = page.body.append(new FakeVideoElement({ duration: NaN }));
    unloadedVideo.readyState = 0;
    unloadedVideo.ownerDocument = sandbox.document;
    const observer = mutationObservers.find((item) => item.active);
    observer.callback([{ addedNodes: [unloadedVideo] }]);
    await runTimers(timers);

    check('未加载元数据的新视频也会触发首次 play() 以启动加载',
      unloadedVideo.dataset.autoNextBound === '1' && unloadedVideo.playCalls >= 1,
      `bound=${unloadedVideo.dataset.autoNextBound || '0'} calls=${unloadedVideo.playCalls}`);
  }
}


async function testPauseForensics() {
  console.log('\n[10] 暂停取证：区分平台暂停与本插件误伤');

  // 10.1 中途被暂停（不是我们自己触发的）→ 必须留下现场记录
  {
    const page = buildLessonPage({});
    const { sandbox, timers } = createSandbox({ page, storage: { autoNext: true } });
    const api = loadExtension(sandbox);
    await runTimers(timers);

    page.video.watch(30); // 正常播放
    page.video.currentTime = page.video.duration / 2; // 播到一半
    page.video.paused = true;
    page.video.dispatchEvent(new FakeEvent('pause'));

    const d = api.videoHandler.diagnostics();
    check('中途暂停留下取证记录', !!d.lastPause, JSON.stringify(d.lastPause));
    check('取证里记录了位置与总长', d.lastPause && d.lastPause.currentTime > 0 && d.lastPause.duration > 0,
      JSON.stringify(d.lastPause));
    check('取证里标注了不是本插件触发', d.lastPause && d.lastPause.cycleRunning === false,
      JSON.stringify(d.lastPause && d.lastPause.cycleRunning));
    check('中途暂停不被误判为接近结尾', d.lastPause && d.lastPause.nearEnd === false,
      JSON.stringify(d.lastPause && d.lastPause.nearEnd));
  }

  // 10.2 正常播放到结尾的暂停不算异常（不记为中途暂停）
  {
    const page = buildLessonPage({});
    const { sandbox, timers } = createSandbox({ page, storage: { autoNext: true } });
    const api = loadExtension(sandbox);
    await runTimers(timers);

    page.video.watch(30);
    page.video.currentTime = page.video.duration;
    page.video.paused = true;
    page.video.dispatchEvent(new FakeEvent('pause'));

    const d = api.videoHandler.diagnostics();
    check('结尾处暂停被标记为 nearEnd', d.lastPause && d.lastPause.nearEnd === true,
      JSON.stringify(d.lastPause));
  }

  // 10.3 暂停回调先完成取证，恢复动作必须延迟执行
  {
    const page = buildLessonPage({});
    const { sandbox, timers } = createSandbox({ page, storage: { autoNext: true, autoRate2x: true } });
    const api = loadExtension(sandbox);
    await runTimers(timers);

    page.video.watch(20);
    const before = page.video.playCalls;
    page.video.paused = true;
    page.video.dispatchEvent(new FakeEvent('pause'));
    check('暂停回调不会同步调用 play()', page.video.playCalls === before,
      `${before} → ${page.video.playCalls}`);
    check('取证不会改动倍速', page.video.playbackRate === 2, String(page.video.playbackRate));
  }
}

async function testIncompleteTaskDialogRecovery() {
  console.log('\n[11] 未完成任务点弹窗：返回学习并撤销错误跳转');

  const page = buildLessonPage({ withNav: true });
  page.state.simulateNavigation = false;
  const box = createSandbox({ page, storage: { autoNext: true } });
  const api = loadExtension(box.sandbox);
  await runTimers(box.timers);

  page.video.watch(30);
  page.video.finish();
  await runTimers(box.timers, { maxRounds: 1, clock: box.clock });

  const dialog = page.body.append(new FakeElement('div', {
    class: 'task-point-dialog',
    attrs: { role: 'dialog' }
  }));
  dialog.append(new FakeElement('div', { text: '当前章节还有任务点未完成，是否去完成？' }));
  const goStudy = dialog.append(new FakeElement('button', { text: '去学习', attrs: { type: 'button' } }));
  const nextLesson = dialog.append(new FakeElement('button', { text: '下一节', attrs: { type: 'button' } }));
  let goStudyClicks = 0;
  let nextLessonClicks = 0;
  goStudy.addEventListener('click', () => { goStudyClicks += 1; });
  nextLesson.addEventListener('click', () => { nextLessonClicks += 1; });

  box.mutationObservers.forEach((observer) => observer.callback([{
    type: 'childList',
    addedNodes: [dialog],
    target: page.body
  }]));
  await runTimers(box.timers, { clock: box.clock });

  const diag = api.videoHandler.diagnostics();
  check('识别提示后只点击“去学习”一次', goStudyClicks === 1, `goStudy=${goStudyClicks}`);
  check('绝不点击弹窗里的“下一节”', nextLessonClicks === 0, `next=${nextLessonClicks}`);
  check('返回学习后撤销本轮导航锁与已触发标记',
    diag.cycle.running === false && diag.cycle.navigated === false && diag.triggered === false,
    JSON.stringify(diag.cycle));
}

async function runAllTests() {
  console.log('AutoNext content script 行为测试');
  console.log('='.repeat(60));
  await testChaoxingHappyPath();
  await testRedesignedPageTextMatch();
  await testGuards();
  await testIframeCoordination();
  await testAutoPlayAfterNavigation();
  await testAutoRate2x();
  await testWatchdogFinish();
  await testSkipNonVideo();
  await testAutoPlayRetry();
  await testPauseForensics();
  await testIncompleteTaskDialogRecovery();

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(60));
  console.log(`共 ${results.length} 项断言，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  return failed.length;
}

if (require.main === module) {
  runAllTests().then((failedCount) => {
    process.exit(failedCount ? 1 : 0);
  });
}

module.exports = { createSandbox, loadExtension, runTimers, tickIntervals, buildLessonPage, linkFrames, captureMessages, check, results, runAllTests };
