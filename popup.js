/**
 * popup.js —— 开关界面 + 页内诊断面板
 *
 * 两个功能开关彼此独立，各自一个 key：
 *   autoNext   : 自动进入下一节
 *   autoRate2x : 自动二倍速
 *
 * 「检测当前标签页」会把每个 frame 的实际情况**直接显示在弹窗里**，
 * 不需要打开 DevTools（F12 被系统占用时也能用）。
 */
'use strict';

const DEFAULTS = { autoNext: false, autoRate2x: false, autoSkipNonVideo: false, verbose: false };
const $ = (id) => document.getElementById(id);

const ui = {
  autoNext: $('autoNext'),
  autoRate2x: $('autoRate2x'),
  autoSkipNonVideo: $('autoSkipNonVideo'),
  verbose: $('verbose'),
  state: $('state'),
  dot: $('dot'),
  printStats: $('printStats'),
  clickNext: $('clickNext'),
  diag: $('diag')
};

function render() {
  const anyOn = ui.autoNext.checked || ui.autoRate2x.checked;
  const parts = [];
  if (ui.autoNext.checked) parts.push('连播');
  if (ui.autoRate2x.checked) parts.push('2x');
  if (ui.autoSkipNonVideo.checked) parts.push('跳非视频');
  ui.state.textContent = anyOn ? `运行中 · ${parts.join(' + ')}` : '已关闭';
  ui.state.classList.toggle('on', anyOn);
  ui.dot.classList.toggle('on', anyOn);
}

function load() {
  chrome.storage.local.get(DEFAULTS, (values) => {
    ui.autoNext.checked = values.autoNext === true;
    ui.autoRate2x.checked = values.autoRate2x === true;
    ui.autoSkipNonVideo.checked = values.autoSkipNonVideo === true;
    ui.verbose.checked = values.verbose === true;
    render();
  });
}

function save(patch) {
  chrome.storage.local.set(patch, render);
}

ui.autoNext.addEventListener('change', () => save({ autoNext: ui.autoNext.checked }));
ui.autoRate2x.addEventListener('change', () => save({ autoRate2x: ui.autoRate2x.checked }));
ui.autoSkipNonVideo.addEventListener('change', () => save({ autoSkipNonVideo: ui.autoSkipNonVideo.checked }));
ui.verbose.addEventListener('change', () => save({ verbose: ui.verbose.checked }));

// ————————————————————————————————————————————————————————————————
// 诊断面板（纯 DOM 构建，不用 innerHTML）
// ————————————————————————————————————————————————————————————————

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function section(title) {
  const sec = el('div', 'sec');
  sec.appendChild(el('h2', null, title));
  return sec;
}

function kv(parent, key, value) {
  const row = el('div', 'kv');
  row.appendChild(el('span', null, key));
  row.appendChild(el('span', null, value === undefined || value === null || value === '' ? '—' : String(value)));
  parent.appendChild(row);
  return row;
}

/** 一条 ✓ / ✗ 结论 */
function verdict(parent, ok, text) {
  const row = el('div', `verdict ${ok ? 'ok' : 'bad'}`);
  row.appendChild(el('span', 'mark', ok ? '✓' : '✗'));
  row.appendChild(el('span', null, text));
  parent.appendChild(row);
}

/** 注入到页面里执行的探测函数（必须自包含，不能引用外部变量） */
function probeFrame() {
  const formatTime = (seconds) => {
    if (!Number.isFinite(seconds)) return '未知';
    const total = Math.round(seconds);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  };

  const videos = Array.from(document.querySelectorAll('video')).map((v) => ({
    readyState: v.readyState,
    duration: Number.isFinite(v.duration) ? Math.round(v.duration) : null,
    durationText: formatTime(v.duration),
    currentTime: Number.isFinite(v.currentTime) ? Math.round(v.currentTime) : null,
    positionText: formatTime(v.currentTime),
    paused: v.paused,
    ended: v.ended,
    playbackRate: v.playbackRate,
    src: (v.currentSrc || v.src || '').slice(0, 90)
  }));

  const api = window.__AUTO_NEXT__;
  if (!api) {
    return {
      frame: window.top === window ? '顶层页面' : 'iframe',
      url: location.href,
      injected: false,
      videos
    };
  }

  // 播放器所在 frame 才有诊断信息（还原“跳转那一刻”的现场）
  let diag = null;
  try {
    diag = api.videoHandler && api.videoHandler.diagnostics ? api.videoHandler.diagnostics() : null;
  } catch (_) { /* 忽略 */ }

  let skipDiag = null;
  try {
    skipDiag = api.skipController && api.skipController.diagnostics ? api.skipController.diagnostics() : null;
  } catch (_) { /* 忽略 */ }

  return {
    frame: window.top === window ? '顶层页面' : 'iframe',
    url: location.href,
    injected: true,
    // 用来判断这个 frame 里的 content script 是不是最新版本
    scriptVersion: api.version || '0.0.0-旧版',
    autoNext: api.settings.enabled === true,
    autoRate2x: api.settings.autoRate2x === true,
    autoSkipNonVideo: api.settings.autoSkipNonVideo === true,
    videos,
    diag,
    skipDiag,
    candidates: api.candidates().slice(0, 5).map((c) => ({
      text: c.text,
      tag: c.el.tagName,
      id: c.el.id || '',
      cls: String(c.el.className || '').slice(0, 40),
      score: c.score,
      reason: c.reason
    })),
    stats: api.stats()
  };
}

/**
 * 还原“跳转那一刻”的现场：这是定位“为什么不跳”最有用的一段。
 * @returns {Array<[boolean, string]>}
 */
function buildTimeline(result) {
  const d = result.diag;
  if (!d || !d.hasVideo) return [];

  const out = [];
  const agoText = d.lastEndedAgoMs === null || d.lastEndedAgoMs === undefined
    ? '从未'
    : `${Math.round(d.lastEndedAgoMs / 1000)} 秒前`;

  out.push([d.endedBound, d.endedBound
    ? '已挂上 ended 监听（视频播完能被感知）'
    : '✗ 尚未挂上 ended 监听 —— 视频还没开始播放过']);

  // 暂停取证：区分"平台/反作弊暂停"和"本插件误伤"（放在最前面，任何分支都要能看到）
  const lp = d.lastPause;
  if (lp) {
    const secsAgo = Math.round((Date.now() - lp.at) / 1000);
    out.push([false,
      `视频在 ${lp.currentTime}s / ${lp.duration}s 处被暂停过（${secsAgo} 秒前）；`
      + `当时页面可见=${!lp.pageHidden}(${lp.visibilityState})、倍速=${lp.playbackRate}x、`
      + `readyState=${lp.readyState}、我方流程运行中=${lp.cycleRunning}`]);
    if (lp.pageHidden) {
      out.push([false, '暂停时页面处于后台/不可见 → 页面或浏览器可能在切走标签页时暂停视频，属于当前环境行为']);
    } else if (!lp.cycleRunning && !lp.nearEnd) {
      out.push([false, '暂停时本插件没有在跑任何流程，且位置远未到结尾 → 不是本插件触发的']);
    }
  }

  if (!d.endedEverFired) {
    const atEnd = d.duration && d.currentTime >= d.duration - 3;
    if (d.paused && atEnd) {
      out.push([true, '视频已经停在结尾，但原生 ended 事件没有触发（平台常见做法）']);
      out.push([true, '→ 已启用「结尾兜底检测」，最多 1 秒内会自动跳转']);
    } else {
      out.push([false, `本次会话里 ended 事件从未触发过 → 视频还没播到结尾（当前 ${d.currentTime}s / ${d.duration}s）`]);
      if (d.paused && !d.ended) out.push([false, '而且视频当前是暂停的，先把视频播起来']);
    }
    return out;
  }

  out.push([true, `ended 事件已触发（${agoText}）`]);
  out.push([true, `结束时的有效播放：${d.lastEndedPlayed}s`]);
  if (d.finishedByWatchdog) {
    out.push([true, '是「结尾兜底检测」认出播完的（原生 ended 没触发）']);
  }

  if (d.lastSkipReason) {
    out.push([false, `但被安全判定拦下了：${d.lastSkipReason}`]);
    return out;
  }
  if (d.triggered) {
    out.push([true, '已进入跳转流程（attempted=true）']);
  }

  const c = d.cycle || {};
  if (c.navigated) out.push([true, '本轮已经点过“下一节”']);
  else if (c.running) out.push([true, '跳转流程正在执行中']);
  else out.push([false, '跳转流程当前不在运行 —— 若刚播完却没反应，多半是没找到按钮']);

  // 跨 frame 交接情况：播放器和“下一节”按钮不在同一个 frame 时最关键
  if (c.handoffCount > 0) {
    const delivered = c.handoffDelivered || 0;
    out.push([delivered > 0,
      `已向其他 frame 发出 ${c.handoffCount} 次“帮忙找下一节”请求，投递到 ${delivered} 个相邻 frame`]);
    if (delivered === 0) {
      out.push([false, '请求没能发给任何 frame → 跨 frame 协调不可用，这一节的按钮只能手动点']);
    }
  }
  const ms = d.messengerStats;
  if (ms && (ms.received > 0 || ms.relays > 0)) {
    out.push([true, `本 frame 收到过 ${ms.received} 次求助，向上中继 ${ms.relays} 次`]);
  }

  return out;
}

/** 根据探测结果生成结论：直接告诉用户问题出在哪一步 */
function buildVerdicts(result) {
  const out = [];

  if (!result.injected) {
    out.push([false, '这个 frame 里没有注入 content script']);
    return out;
  }
  if (result.autoNext !== true) {
    out.push([false, '「自动进入下一节」在这个 frame 里是关闭的 → 打开开关后刷新页面']);
  } else {
    out.push([true, '「自动进入下一节」已开启']);
  }

  const stats = result.stats || {};
  const frameVideos = result.videos || [];
  if (frameVideos.length === 0) {
    out.push([false, '这个 frame 里没有 <video>（播放器可能在别的 frame）']);
  } else {
    const v = frameVideos[0];
    const rateOk = Math.abs(v.playbackRate - 2) <= 0.01;
    const rateState = (stats.rates || [])[0] || null;
    out.push([true, `检测到播放器：总长 ${v.durationText}，当前 ${v.positionText}，${v.paused ? '已暂停' : '播放中'}，倍速 ${v.playbackRate}x`]);
    if (result.autoRate2x === true && rateState && rateState.rateSuspended === true) {
      out.push([true, '当前视频触发了平台倍速限制，插件已自动回退到 1.0x 以保持播放；换到下一视频后会重新判断']);
    } else if (result.autoRate2x === true && !rateOk) {
      out.push([false, '开了二倍速但当前不是 2.0x，可能被站点反复重置']);
    }
  }

  const cands = result.candidates || [];
  if (cands.length === 0) {
    out.push([false, '没找到任何“下一节”候选按钮 → 这是不跳转的原因，需要把该页面的按钮选择器加进 button-finder.js']);
  } else {
    const top = cands[0];
    const ok = top.score >= 40;
    out.push([ok,
      `最佳候选：「${top.text || top.tag}」score=${top.score}${ok ? '' : '（低于阈值 40，会被判定为“找不到”）'}`]);
    if (ok && top.text && /上一|返回|prev|back/i.test(top.text)) {
      out.push([false, '最佳候选看起来是“上一节/返回”，判定可能有误']);
    }
  }

  const cycle = stats.cycle || {};
  if (cycle.running) out.push([true, '当前正在执行跳转流程']);
  if (cycle.navigated) out.push([true, '本轮已经点过“下一节”']);

  return out;
}

function renderDiag(results, tabUrl, popupVersion) {
  ui.diag.hidden = false;
  ui.diag.textContent = '';

  if (!results.length) {
    const sec = section('检测结果');
    sec.appendChild(el('div', 'empty', '没有拿到任何 frame 的结果。'));
    ui.diag.appendChild(sec);
    return;
  }

  // 汇总：先扫一遍，把“该看哪个 frame”挑出来
  const withVideo = results.filter((r) => r.result && r.result.videos && r.result.videos.length);
  const withCandidates = results.filter((r) => r.result && r.result.candidates && r.result.candidates.length);
  const head = section('总览');
  kv(head, '扩展版本', popupVersion || '未知');
  kv(head, '页面', tabUrl || '—');
  kv(head, 'frame 数', results.length);
  kv(head, '有播放器', `${withVideo.length} 个`);
  kv(head, '有下一节按钮', `${withCandidates.length} 个`);
  const skipTotal = results.reduce((n, r) => n + ((r.result && r.result.skipDiag && r.result.skipDiag.totalSkips) || 0), 0);
  if (skipTotal) kv(head, '已跳过非视频页', `${skipTotal} 个`);

  // ★ 最关键的一致性检查：content script 是不是最新版本。
  //   在 chrome://extensions 点“刷新”后，**已经打开的页面不会自动重新注入**，
  //   页面里跑的还是旧代码，必须刷新页面（F5）才会更新。这个检查就是用来暴露它的。
  const injected = results.filter((r) => r.result && r.result.injected);
  const stale = injected.filter((r) => r.result.scriptVersion !== popupVersion);
  if (injected.length && stale.length) {
    const shown = stale.slice(0, 3).map((r) => `frame ${r.frameId}=${r.result.scriptVersion}`).join('、');
    verdict(head, false,
      `页面里运行的还是旧代码（${shown}，当前扩展是 v${popupVersion}）→ 请刷新课程页面（F5）后重新检测`);
  } else if (injected.length) {
    verdict(head, true, `页面内代码已是最新（v${popupVersion}）`);
  }

  if (withVideo.length && !withCandidates.length) {
    verdict(head, false, '有播放器但所有 frame 都没有“下一节”按钮 → 这就是不跳转的原因');
  } else if (withVideo.length && withCandidates.length) {
    const hasVideo = withVideo.some((r) => r.result.autoNext === true);
    verdict(head, hasVideo, hasVideo
      ? '播放器与按钮都齐了；若仍不跳转，请看下面“为什么还没跳”一节'
      : '播放器所在 frame 的连播开关是关的 → 打开开关后刷新页面');
  }
  ui.diag.appendChild(head);

  // 每个 frame 的明细
  results.forEach(({ frameId, result }) => {
    const title = `frame ${frameId}${result && result.frame ? ` · ${result.frame}` : ''}`;
    const sec = section(title);
    if (!result) {
      sec.appendChild(el('div', 'empty', '该 frame 无法读取'));
      ui.diag.appendChild(sec);
      return;
    }

    kv(sec, '地址', result.url);
    if (result.injected) {
      kv(sec, '代码版本', result.scriptVersion || '旧版（无版本号）');
      kv(sec, '连播', result.autoNext ? '开' : '关');
      kv(sec, '二倍速', result.autoRate2x ? '开' : '关');
      kv(sec, '跳非视频', result.autoSkipNonVideo ? '开' : '关');
    }
    (result.videos || []).forEach((v, i) => {
      kv(sec, `视频${i + 1}`, `${v.durationText} / 进度 ${v.positionText} / ${v.paused ? '暂停' : '播放中'} / ${v.playbackRate}x`);
      kv(sec, '', v.src || '(无 src)');
    });

    if (result.candidates && result.candidates.length) {
      const box = el('div', 'cand');
      box.appendChild(el('div', null, '候选按钮：'));
      result.candidates.forEach((c) => {
        const line = el('div');
        line.appendChild(el('b', null, `[${c.score}] `));
        line.appendChild(document.createTextNode(
          `${c.text || '(无文字)'} ${c.tag}${c.id ? '#' + c.id : ''}${c.cls ? '.' + c.cls.split(/\s+/).join('.') : ''}`
        ));
        box.appendChild(line);
      });
      sec.appendChild(box);
    }

    // 播放器所在 frame 才有的“现场还原”
    const timeline = buildTimeline(result);
    if (timeline.length) {
      const box = el('div', 'sec');
      box.appendChild(el('h2', null, '这个 frame 的现场还原'));
      timeline.forEach(([ok, text]) => verdict(box, ok, text));
      ui.diag.appendChild(box);
    }

    // 自动跳过非视频页面的状态
    const sd = result.skipDiag;
    if (sd && (sd.enabled || sd.totalSkips > 0)) {
      const box = el('div', 'sec');
      box.appendChild(el('h2', null, '自动跳过非视频页面'));
      verdict(box, true, `本轮已连续跳过 ${sd.consecutiveSkips}/${sd.max} 个，累计 ${sd.totalSkips} 个`);
      if (sd.lastStopReason) verdict(box, false, `最近一次停止原因：${sd.lastStopReason}`);
      if (!sd.enabled) verdict(box, false, '开关当前是关闭的');
      ui.diag.appendChild(box);
    }

    buildVerdicts(result).forEach(([ok, text]) => verdict(sec, ok, text));
    ui.diag.appendChild(sec);
  });

  // 位置线索
  if (withVideo.length) {
    const v = withVideo[0].result.videos[0];
    const d = withVideo[0].result.diag || {};
    const atEnd = v.duration !== null && v.currentTime !== null && v.currentTime >= v.duration - 3;
    const sec = section('为什么还没跳（位置线索）');
    if (d.finishedByWatchdog) {
      verdict(sec, true, '这一节的结尾已由「结尾兜底检测」识别，跳转流程已启动');
    } else if (v.paused && atEnd) {
      verdict(sec, true, '视频停在结尾且没有触发 ended —— 已启用兜底检测，最多 1 秒内会自动跳转');
    } else if (v.paused && !v.ended) {
      verdict(sec, false, `视频当前是暂停状态（进度 ${v.positionText} / ${v.durationText}）→ 请先播放视频`);
    } else {
      verdict(sec, true, `视频正在播放（进度 ${v.positionText} / ${v.durationText}），播完才会触发跳转`);
    }
    verdict(sec, true, '拖动进度条到结尾不算“看完”，不会触发跳转（避免把拖完当成看完）');
    verdict(sec, true, '若已经播完却没反应：把上面各 frame 的「现场还原」内容发我');
    ui.diag.appendChild(sec);
  }
}

ui.printStats.addEventListener('click', async () => {
  ui.printStats.classList.add('busy');
  const original = ui.printStats.textContent;
  ui.printStats.textContent = '检测中…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error('找不到当前标签页');

    // 列出所有 frame；取不到时降级为只检测主 frame
    let target = { tabId: tab.id };
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
      if (frames && frames.length) target = { tabId: tab.id, frameIds: frames.map((f) => f.frameId) };
    } catch (_) {
      /* 忽略：降级为主 frame */
    }

    const results = await chrome.scripting.executeScript({ target, func: probeFrame });
    const rows = results
      .slice()
      .sort((a, b) => a.frameId - b.frameId)
      .map(({ frameId, result }) => ({ frameId, result: result || null }));

    renderDiag(rows, tab.url, chrome.runtime.getManifest().version);
    ui.printStats.textContent = '✓ 已检测';
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    ui.diag.hidden = false;
    ui.diag.textContent = '';
    const sec = section('检测失败');
    sec.appendChild(el('div', 'empty', /cannot be scripted|Cannot access/i.test(message)
      ? '该页面不允许注入（设置页 / 扩展商店等受限页面）'
      : message));
    ui.diag.appendChild(sec);
    ui.printStats.textContent = '检测失败';
  } finally {
    setTimeout(() => {
      ui.printStats.textContent = original;
      ui.printStats.classList.remove('busy');
    }, 1500);
  }
});

/** 手动触发一次“查找并点击下一节”（每个 frame 各试一次，谁命中就谁点） */
function probeClickNext() {
  const api = window.__AUTO_NEXT__;
  if (!api) return { injected: false, frame: window.top === window ? '顶层页面' : 'iframe', url: location.href, candidates: [] };

  const safeCandidates = () => {
    try {
      return api.candidates().slice(0, 3).map((c) => ({ text: c.text, tag: c.el.tagName, score: c.score }));
    } catch (_) {
      return [];
    }
  };

  let found = null;
  try {
    found = api.buttonFinder.findNextButton();
  } catch (err) {
    console.warn('[AutoNext] findNextButton 抛错：', err);
  }

  const result = {
    injected: true,
    frame: window.top === window ? '顶层页面' : 'iframe',
    url: location.href,
    clicked: false,
    text: '',
    score: 0,
    candidates: safeCandidates()
  };
  if (!found) return result;

  result.text = found.text || '(无文字)';
  result.score = found.score;
  api.clickNext(); // 走与自动流程完全相同的查找与点击逻辑
  result.clicked = true;
  return result;
}

function renderClickResult(rows) {
  ui.diag.hidden = false;
  ui.diag.textContent = '';

  const sec = section('手动点击“下一节”');
  const hit = rows.find((r) => r.result && r.result.clicked);
  if (hit) {
    verdict(sec, true, `已点击「${hit.result.text}」（score=${hit.result.score}，${hit.result.frame}）`);
    verdict(sec, true, '如果页面确实翻到了下一节，说明查找与点击都正常；自动流程没触发，问题就出在“视频结束判定”上');
  } else {
    verdict(sec, false, '所有 frame 都没有找到可点击的“下一节”按钮');
    verdict(sec, false, '→ 这就是自动跳转失效的原因：该页面的按钮不在候选列表里，需要补充选择器');
  }
  ui.diag.appendChild(sec);
  rows.forEach(({ frameId, result }) => {
    if (!result) return;
    const cands0 = result.candidates || [];
    const box = el('div', 'sec');
    box.appendChild(el('h2', null, `frame ${frameId} · ${result.frame || ''}`));
    kv(box, '地址', result.url);
    if (!result.injected) {
      box.appendChild(el('div', 'empty', '这个 frame 没有注入 content script'));
    } else if (cands0.length === 0) {
      box.appendChild(el('div', 'empty', '没有任何候选按钮'));
    } else {
      const cands = el('div', 'cand');
      cands.appendChild(el('div', null, '该 frame 的候选：'));
      cands0.forEach((c) => {
        const line = el('div');
        line.appendChild(el('b', null, `[${c.score}] `));
        line.appendChild(document.createTextNode(c.text || `(${c.tag})`));
        cands.appendChild(line);
      });
      box.appendChild(cands);
    }
    ui.diag.appendChild(box);
  });
}

ui.clickNext.addEventListener('click', async () => {
  ui.clickNext.classList.add('busy');
  const original = ui.clickNext.textContent;
  ui.clickNext.textContent = '执行中…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error('找不到当前标签页');

    let target = { tabId: tab.id };
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
      if (frames && frames.length) target = { tabId: tab.id, frameIds: frames.map((f) => f.frameId) };
    } catch (_) { /* 降级为主 frame */ }

    const results = await chrome.scripting.executeScript({ target, func: probeClickNext });
    const rows = results
      .slice()
      .sort((a, b) => a.frameId - b.frameId)
      .map(({ frameId, result }) => ({ frameId, result: result || null }));
    renderClickResult(rows);
    ui.clickNext.textContent = '✓ 已执行';
  } catch (err) {
    console.warn('[AutoNext] 手动点击失败：', err);
    ui.diag.hidden = false;
    ui.diag.textContent = '';
    const sec = section('手动点击失败');
    sec.appendChild(el('div', 'empty', err && err.message ? err.message : String(err)));
    ui.diag.appendChild(sec);
    ui.clickNext.textContent = '执行失败';
  } finally {
    setTimeout(() => {
      ui.clickNext.textContent = original;
      ui.clickNext.classList.remove('busy');
    }, 1500);
  }
});

load();
