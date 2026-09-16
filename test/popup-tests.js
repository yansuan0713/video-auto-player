/**
 * test/popup-tests.js —— popup（开关 + 诊断面板）的自测
 *
 * 用一个假 DOM 真实执行 popup.js，验证：
 *   1. 三个开关读写 chrome.storage.local 的 key 是否正确
 *   2. 诊断面板能渲染出“有播放器但没按钮”这类关键结论
 *   3. 面板不使用 innerHTML（MV3 的 CSP 下更安全）
 *   4. 检测失败时给出可读提示而不是白屏
 *
 * 运行： node test/popup-tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { FakeElement, FakeVideoElement } = require('./fake-dom');

const POPUP_JS = path.resolve(__dirname, '../popup.js');
const POPUP_HTML = path.resolve(__dirname, '../popup.html');

/** popup.js 里用 getElementById 取的那些元素 */
const ELEMENT_IDS = ['autoNext', 'autoRate2x', 'autoSkipNonVideo', 'verbose', 'state', 'dot', 'printStats', 'clickNext', 'diag'];

function createPopupSandbox({ tabUrl = 'https://mooc1.chaoxing.com/mycourse/studentstudy', frames = null, failScripting = null } = {}) {
  const root = new FakeElement('body');
  const byId = new Map();
  for (const id of ELEMENT_IDS) {
    const el = new FakeElement('div', { id });
    byId.set(id, root.append(el));
  }

  const storageData = { autoNext: false, autoRate2x: false, verbose: false };
  const storageSets = [];
  const sandboxLocation = { href: tabUrl };

  const document = {
    body: root,
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => {
      const node = new FakeElement('#text');
      node.textContent = text;
      return node;
    },
    // 注入的 probeFrame 会调用 document.querySelectorAll('video')，必须给真实可查的 DOM
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    querySelector: (selector) => root.querySelector(selector)
  };

  /**
   * 让 executeScript 真的把注入函数跑起来。
   * MV3 的做法是把函数 toString 后注入目标 frame，这里也照做——
   * 这样才能覆盖 probeFrame / probeClickNext 的真实逻辑，而不是绕过它们。
   */
  const executeScript = async ({ func }) => {
    if (failScripting) throw new Error(failScripting);
    if (typeof func !== 'function') throw new Error('executeScript 需要函数');
    const frameIds = frames && frames.length ? frames.map((f) => f.frameId) : [0];
    return frameIds.map((frameId) => ({
      frameId,
      result: vm.runInContext(`(${func.toString()})()`, context, { filename: `injected-frame-${frameId}` })
    }));
  };

  // popup 自身是顶层文档：window.top === window。
  // window 单独建一个对象，才能真实反映“注入进页面后读 window.__AUTO_NEXT__”的行为。
  const win = { document, location: sandboxLocation, console };
  win.self = win;
  win.top = win;
  win.parent = win;

  const sandbox = {
    document,
    console,
    location: sandboxLocation,
    window: win,
    setTimeout,
    clearTimeout,
    chrome: {
      storage: {
        local: {
          get: (defaults, cb) => cb({ ...defaults, ...storageData }),
          set: (patch, cb) => { storageSets.push(patch); Object.assign(storageData, patch); if (cb) cb(); }
        }
      },
      runtime: { getManifest: () => ({ version: '1.1.0' }) },
      tabs: { query: async () => [{ id: 1, url: tabUrl }] },
      // 真实浏览器里 getAllFrames 至少会返回主 frame，
      // 而 probeFrame 会在**每个** frame 里执行，所以这里不能返回 null
      webNavigation: {
        getAllFrames: async () => (frames && frames.length ? frames.map((f) => ({ frameId: f.frameId })) : [{ frameId: 0 }])
      },
      scripting: { executeScript }
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.self = win;
  // 上下文在这里就建好，probeFrame / probeClickNext 的“注入执行”需要它
  const context = vm.createContext(sandbox);
  sandbox.__context = context;
  return { sandbox, context, byId, storageData, storageSets, root, win };
}

function runPopup(sandbox) {
  vm.runInContext(fs.readFileSync(POPUP_JS, 'utf8'), sandbox.__context, { filename: 'popup.js' });
  return sandbox;
}

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: !!condition, detail });
  console.log(`${condition ? '  ✓' : '  ✗'} ${name}${condition ? '' : `  → ${detail}`}`);
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** 往假页面里挂一个真实的 <video> 节点，供注入的 probeFrame 读取 */
function installVideo(root, { duration = 600, currentTime = 0, paused = true, ended = false, rate = 1 } = {}) {
  const video = new FakeVideoElement({ duration });
  video.currentTime = currentTime;
  video.paused = paused;
  video.ended = ended;
  video._playbackRate = rate;
  video.currentSrc = 'https://cdn.example.com/lesson1.mp4';
  root.append(video);
  return video;
}

/**
 * 在 popup 沙箱里装一份 __AUTO_NEXT__ 桩，让 probeClickNext() / probeFrame() 真的能跑。
 * 返回调用记录，便于断言“确实点了”。
 */
function installAutoNextStub(sandbox, { foundScore = 0, foundText = '', candidates = [], autoNext = true, autoRate2x = false, rateSuspended = false, diag = null, scriptVersion = null } = {}) {
  const calls = { clickNext: 0, findNextButton: 0 };
  const button = foundScore > 0 ? { text: foundText, score: foundScore, el: { tagName: 'A', id: 'next', className: '' } } : null;
  // 必须挂在 window 上：注入的 probeFrame / probeClickNext 读的就是 window.__AUTO_NEXT__
  sandbox.window.__AUTO_NEXT__ = {
    version: scriptVersion || sandbox.chrome.runtime.getManifest().version,
    settings: { enabled: autoNext, autoRate2x },
    stats: () => ({
      frame: 'top',
      url: 'https://example.com',
      cycle: { running: false, attempts: 0, navigated: false },
      videos: [],
      rates: [{ rateSuspended }]
    }),
    videoHandler: { diagnostics: () => diag },
    candidates: () => candidates,
    clickNext: () => { calls.clickNext += 1; return button; }
  };
  sandbox.window.__AUTO_NEXT__.buttonFinder = {
    findNextButton: () => { calls.findNextButton += 1; return button; }
  };
  return calls;
}

/** 点一下“手动点下一节”并等结果渲染 */
async function runClickNext(byId) {
  byId.get('clickNext').dispatchEvent({ type: 'click' });
  await tick();
  await tick();
  await tick();
}

/** 把面板里所有文本抓出来，方便断言结论 */
function diagText(byId) {
  return byId.get('diag').textContent;
}

async function testSwitches() {
  console.log('\n[1] 开关读写');
  const { sandbox, byId, storageSets } = createPopupSandbox();
  runPopup(sandbox);
  await tick();

  check('初始状态显示已关闭', byId.get('state').textContent.includes('已关闭'), byId.get('state').textContent);

  byId.get('autoNext').checked = true;
  byId.get('autoNext').dispatchEvent({ type: 'change' });
  check('打开连播写入 autoNext', storageSets.some((p) => p.autoNext === true), JSON.stringify(storageSets));
  check('状态栏显示连播', byId.get('state').textContent.includes('连播'), byId.get('state').textContent);

  byId.get('autoRate2x').checked = true;
  byId.get('autoRate2x').dispatchEvent({ type: 'change' });
  check('打开二倍速写入 autoRate2x', storageSets.some((p) => p.autoRate2x === true), JSON.stringify(storageSets));
  check('状态栏同时显示 2x', byId.get('state').textContent.includes('2x'), byId.get('state').textContent);

  byId.get('autoSkipNonVideo').checked = true;
  byId.get('autoSkipNonVideo').dispatchEvent({ type: 'change' });
  check('打开跳过非视频写入 autoSkipNonVideo',
    storageSets.some((p) => p.autoSkipNonVideo === true), JSON.stringify(storageSets));
  check('状态栏显示跳非视频', byId.get('state').textContent.includes('跳非视频'), byId.get('state').textContent);

  byId.get('autoNext').checked = false;
  byId.get('autoNext').dispatchEvent({ type: 'change' });
  check('关闭后写入 autoNext=false', storageSets.some((p) => p.autoNext === false), JSON.stringify(storageSets));
  check('仍有二倍速时不算全部关闭', byId.get('state').textContent.includes('2x'), byId.get('state').textContent);
}

/** 点一下“检测当前标签页”并等面板渲染 */
async function runDetect(byId) {
  byId.get('printStats').dispatchEvent({ type: 'click' });
  await tick();
  await tick();
  await tick();
}

async function testDiagNoCandidate() {
  console.log('\n[2] 诊断面板：有播放器、没有“下一节”按钮');
  const { sandbox, byId, root } = createPopupSandbox({ frames: [{ frameId: 3 }] });
  runPopup(sandbox);
  installVideo(root, { duration: 1265, currentTime: 10, paused: false, rate: 2 });
  installAutoNextStub(sandbox, { autoNext: true, autoRate2x: true, candidates: [] });
  await runDetect(byId);

  const text = diagText(byId);
  check('面板不再是隐藏状态', byId.get('diag').hidden === false);
  check('列出了播放器信息', text.includes('21:05') && text.includes('2x'), text.slice(0, 260));
  check('给出“有播放器但没有按钮”的结论', text.includes('有播放器但所有 frame 都没有'), text.slice(0, 300));
  check('提示把候选按钮内容发出来', text.includes('发我'), text.slice(-220));
  check('显示了 frame 编号', text.includes('frame 3'), text.slice(0, 220));
}

async function testDiagFoundCandidate() {
  console.log('\n[3] 诊断面板：找到候选按钮');
  const { sandbox, byId } = createPopupSandbox({ frames: [{ frameId: 0 }] });
  runPopup(sandbox);
  installAutoNextStub(sandbox, {
    autoNext: true,
    candidates: [{ text: '下一节', el: { tagName: 'A', id: 'prevNextFocusNext', className: 'prev_next next' }, score: 188, reason: 'selector+100 text+74' }]
  });
  await runDetect(byId);

  const text = diagText(byId);
  check('列出了候选按钮与得分', text.includes('下一节') && text.includes('188'), text.slice(0, 320));
  check('显示候选的 DOM 线索', text.includes('prevNextFocusNext'), text.slice(0, 420));
  check('候选充足时不报“没有按钮”', !text.includes('没有“下一节”按钮'), text.slice(0, 320));
}

async function testDiagPausedVideo() {
  console.log('\n[4] 诊断面板：视频暂停时的提示');
  const { sandbox, byId, root } = createPopupSandbox({ frames: [{ frameId: 0 }] });
  runPopup(sandbox);
  installVideo(root, { duration: 600, currentTime: 0, paused: true, rate: 1 });
  installAutoNextStub(sandbox, {
    autoNext: true,
    candidates: [{ text: '下一节', el: { tagName: 'A', id: 'next', className: '' }, score: 88, reason: 'selector' }]
  });
  await runDetect(byId);

  const text = diagText(byId);
  check('暂停时提示先播放视频', text.includes('请先播放视频'), text.slice(-420));
}

async function testDiagRateFallback() {
  console.log('\n[4b] 诊断面板：课程禁止倍速时显示自适应回退');
  const { sandbox, byId, root } = createPopupSandbox({ frames: [{ frameId: 0 }] });
  runPopup(sandbox);
  installVideo(root, { duration: 229, currentTime: 4, paused: false, rate: 1 });
  installAutoNextStub(sandbox, {
    autoNext: true,
    autoRate2x: true,
    rateSuspended: true,
    candidates: [{ text: '下一节', el: { tagName: 'A', id: 'next', className: '' }, score: 88, reason: 'selector' }]
  });
  await runDetect(byId);

  const text = diagText(byId);
  check('倍速受限时说明已自动回退到 1.0x', text.includes('平台倍速限制') && text.includes('1.0x'), text.slice(0, 420));
  check('自适应回退不会误报成站点反复重置', !text.includes('可能被站点反复重置'), text.slice(0, 420));
}

async function testDiagScriptingFailure() {
  console.log('\n[5] 诊断面板：注入失败时的提示');
  const { sandbox, byId } = createPopupSandbox({ failScripting: 'Cannot access contents of the page' });
  runPopup(sandbox);
  byId.get('printStats').dispatchEvent({ type: 'click' });
  await tick();
  await tick();
  const text = diagText(byId);
  check('提示受限页面', text.includes('不允许注入'), text);
}

async function testManualClickNext() {
  console.log('\n[6] 手动点“下一节”（executeScript 里真的执行 probeClickNext）');

  // 6.1 找到并点击：直接驱动 renderClickResult（popup 内部渲染逻辑）
  {
    const { sandbox, context, byId } = createPopupSandbox({ frames: [{ frameId: 0 }] });
    runPopup(sandbox);
    const calls = installAutoNextStub(sandbox, { foundScore: 188, foundText: '下一节' });

    // 注入函数真的跑一遍
    const injected = vm.runInContext('(' + vm.runInContext('probeClickNext.toString()', context) + ')()', context);
    check('调用了 buttonFinder.findNextButton', calls.findNextButton >= 1, String(calls.findNextButton));
    check('调用了 clickNext 真正点击', calls.clickNext >= 1, String(calls.clickNext));
    check('注入函数报告 clicked=true', injected.clicked === true, JSON.stringify(injected));

    // 渲染函数真的跑一遍
    vm.runInContext('renderClickResult(' + JSON.stringify([{ frameId: 0, result: injected }]) + ')', context);
    const text = diagText(byId);
    check('面板报告已点击并带分数', text.includes('已点击') && text.includes('188'), text.slice(0, 260));
    check('面板解释“查找正常，问题在结束判定”', text.includes('结束判定'), text.slice(0, 400));
  }

  // 6.2 找不到按钮
  {
    const { sandbox, byId } = createPopupSandbox({ frames: [{ frameId: 0 }] });
    runPopup(sandbox);
    const calls = installAutoNextStub(sandbox, { foundScore: 0 });
    await runClickNext(byId);

    const text = diagText(byId);
    check('没找到时不调用 clickNext', calls.clickNext === 0, String(calls.clickNext));
    check('面板报告找不到按钮', text.includes('所有 frame 都没有找到可点击'), text.slice(0, 300));
    check('面板指出这就是失效原因', text.includes('自动跳转失效的原因'), text.slice(0, 400));
  }

  // 6.3 content script 没注入
  {
    const { sandbox, byId } = createPopupSandbox({ frames: [{ frameId: 0 }] });
    runPopup(sandbox); // 不装桩
    await runClickNext(byId);
    const text = diagText(byId);
    check('未注入时提示没有 content script', text.includes('没有注入 content script'), text.slice(0, 300));
  }
}

async function testTimelineDiagnostics() {
  console.log('\n[7] 现场还原：解释“为什么不跳”');

  /** 造一个“播放器在 iframe、按钮在顶层”的场景，和你遇到的情况一致 */
  const scene = async (diag) => {
    const { sandbox, byId, root } = createPopupSandbox({ frames: [{ frameId: 0 }, { frameId: 63 }] });
    runPopup(sandbox);
    installVideo(root, { duration: 143, currentTime: 8, paused: false, rate: 2 });
    installAutoNextStub(sandbox, { candidates: [], diag });
    await runDetect(byId);
    return diagText(byId);
  };

  // 7.1 ended 从未触发（就是快照里 0:08 那一刻的状态）
  {
    const text = await scene({
      hasVideo: true, endedBound: true, endedEverFired: false, lastEndedAgoMs: null,
      playedSeconds: 8, lastEndedPlayed: 0, triggered: false, lastSkipReason: '',
      currentTime: 8, duration: 143, paused: false, ended: false,
      cycle: { running: false, attempts: 0, navigated: false }
    });
    check('未播完时提示 ended 从未触发', text.includes('ended 事件从未触发过'), text.slice(-500));
    check('给出当前进度与总长', text.includes('8s / 143s'), text.slice(-500));

    // 7.1b 已经停在结尾但没触发 ended → 应提示兜底检测会接手
    const text2 = await scene({
      hasVideo: true, endedBound: true, endedEverFired: false, lastEndedAgoMs: null,
      playedSeconds: 143, lastEndedPlayed: 0, triggered: false, lastSkipReason: '',
      currentTime: 143, duration: 143, paused: true, ended: false,
      cycle: { running: false, attempts: 0, navigated: false }
    });
    check('停在结尾未触发 ended 时提示兜底检测', text2.includes('结尾兜底检测'), text2.slice(-560));
  }

  // 7.2 被安全判定拦下
  {
    const text = await scene({
      hasVideo: true, endedBound: true, endedEverFired: true, lastEndedAgoMs: 1200,
      playedSeconds: 0, lastEndedPlayed: 0, triggered: false,
      lastSkipReason: '有效播放时长仅 0.0s，不足 3s',
      currentTime: 143, duration: 143, paused: true, ended: true,
      cycle: { running: false, attempts: 0, navigated: false }
    });
    check('显示 ended 已触发', text.includes('ended 事件已触发'), text.slice(-500));
    check('显示被安全判定拦下的具体原因', text.includes('有效播放时长仅 0.0s'), text.slice(-500));
  }

  // 7.3 已触发但没在跑（按钮找不到的典型症状）
  {
    const text = await scene({
      hasVideo: true, endedBound: true, endedEverFired: true, lastEndedAgoMs: 5000,
      playedSeconds: 143, lastEndedPlayed: 143, triggered: true, lastSkipReason: '',
      currentTime: 143, duration: 143, paused: true, ended: true,
      cycle: { running: false, attempts: 5, navigated: false }
    });
    check('提示流程不在运行、多半没找到按钮', text.includes('多半是没找到按钮'), text.slice(-500));
  }

  // 7.5 跨 frame 交接信息
  {
    const text = await scene({
      hasVideo: true, endedBound: true, endedEverFired: true, lastEndedAgoMs: 5000,
      finishedByWatchdog: true, playedSeconds: 143, lastEndedPlayed: 143, triggered: false,
      lastSkipReason: '', currentTime: 143, duration: 143, paused: true, ended: false,
      messengerStats: { requested: 1, received: 0, relays: 0, errors: 0 },
      cycle: { running: false, attempts: 0, navigated: false, handoffCount: 1, handoffDelivered: 2 }
    });
    check('显示交接投递情况', text.includes('投递到 2 个相邻 frame'), text.slice(-620));
  }

  // 7.5b 交接失败（一个 frame 都没发出去）
  {
    const text = await scene({
      hasVideo: true, endedBound: true, endedEverFired: true, lastEndedAgoMs: 5000,
      finishedByWatchdog: true, playedSeconds: 143, lastEndedPlayed: 143, triggered: false,
      lastSkipReason: '', currentTime: 143, duration: 143, paused: true, ended: false,
      messengerStats: { requested: 1, received: 0, relays: 0, errors: 0 },
      cycle: { running: false, attempts: 0, navigated: false, handoffCount: 1, handoffDelivered: 0 }
    });
    check('交接投递失败时明确报警', text.includes('跨 frame 协调不可用'), text.slice(-620));
  }

  // 7.4 尚未绑定 ended（视频还没播放过）
  {
    const text = await scene({
      hasVideo: true, endedBound: false, endedEverFired: false, lastEndedAgoMs: null,
      playedSeconds: 0, lastEndedPlayed: 0, triggered: false, lastSkipReason: '',
      currentTime: 0, duration: 143, paused: true, ended: false,
      cycle: { running: false, attempts: 0, navigated: false }
    });
    check('提示尚未挂上 ended 监听', text.includes('尚未挂上 ended 监听'), text.slice(-500));
    check('暂停时提示先播视频', text.includes('先把视频播起来'), text.slice(-500));
  }
}

async function testStaleCodeDetection() {
  console.log('\n[8] 旧代码检测：页面里跑的还是上一版 content script');

  // 8.1 版本一致 → 报告最新
  {
    const { sandbox, byId } = createPopupSandbox({ frames: [{ frameId: 0 }] });
    runPopup(sandbox);
    installAutoNextStub(sandbox, { candidates: [] }); // 默认与扩展版本一致
    await runDetect(byId);
    const text = diagText(byId);
    check('版本一致时报告最新', text.includes('页面内代码已是最新'), text.slice(0, 260));
    check('总览显示扩展版本', text.includes('1.1.0'), text.slice(0, 200));
  }

  // 8.2 版本不一致（改了扩展但没刷新页面）→ 必须明确报错
  {
    const { sandbox, byId } = createPopupSandbox({ frames: [{ frameId: 0 }, { frameId: 106 }] });
    runPopup(sandbox);
    installAutoNextStub(sandbox, { candidates: [], scriptVersion: '0.0.0-旧版' });
    await runDetect(byId);
    const text = diagText(byId);
    check('版本不一致时报警', text.includes('页面里运行的还是旧代码'), text.slice(0, 320));
    check('报警里带刷新指引', text.includes('刷新课程页面（F5）'), text.slice(0, 360));
    check('明细里显示代码版本', text.includes('代码版本'), text.slice(0, 400));
  }
}

function testNoInnerHtml() {
  console.log('\n[9] 安全性：面板不使用 innerHTML 注入');
  const code = fs.readFileSync(POPUP_JS, 'utf8');
  // 只针对真正的赋值/调用，注释里提到这个词不算
  check('popup.js 没有 innerHTML 赋值', !/\.innerHTML\s*=/.test(code), (/\.innerHTML\s*=/.exec(code) || [''])[0]);
  check('popup.js 没有 outerHTML/insertAdjacentHTML', !/\.(outerHTML\s*=|insertAdjacentHTML\()/.test(code));
  check('popup.js 没有 eval / new Function', !/\beval\s*\(|new Function\s*\(/.test(code));
  const html = fs.readFileSync(POPUP_HTML, 'utf8');
  check('popup.html 引入 popup.js', html.includes('src="popup.js"'));
  check('popup.html 含诊断面板容器', html.includes('id="diag"'));
}

// 被 require 时只导出工具，方便单独调试；直接 node 运行时才执行测试
module.exports = { createPopupSandbox, runPopup, installAutoNextStub };

(async () => {
  if (require.main !== module) return;
  console.log('AutoNext popup 自测');
  console.log('='.repeat(60));
  await testSwitches();
  await testDiagNoCandidate();
  await testDiagFoundCandidate();
  await testDiagPausedVideo();
  await testDiagRateFallback();
  await testDiagScriptingFailure();
  await testManualClickNext();
  await testTimelineDiagnostics();
  await testStaleCodeDetection();
  testNoInnerHtml();

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(60));
  console.log(`共 ${results.length} 项断言，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
})();
