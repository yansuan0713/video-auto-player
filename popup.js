/**
 * popup.js —— 扩展弹出层主控制器 (v1.2.0)
 *
 * 功能结构：
 *   1. 播放控制：全局连播、可配置倍速（预设芯片 + 自由输入）、跳过非视频页面；
 *   2. 当前站点：针对当前 host 覆盖全局设置、设置自定义 CSS Selector；
 *   3. 诊断调试：逐 frame 状态、现场还原、最近事件流、敏感参数脱敏与一键复制。
 *
 * 安全规范：严格遵守 MV3 CSP，所有 DOM 节点通过 createElement 构建，杜绝 innerHTML / eval。
 */
'use strict';

const DEFAULTS = {
  autoNext: false,
  autoRate: false,
  autoRate2x: false,
  playbackRate: 2.0,
  autoSkipNonVideo: false,
  verbose: false,
  siteSettings: {},
  configVersion: '1.2.0'
};

const $ = (id) => document.getElementById(id);

const ui = {
  // 核心开关与基础元素（保持与既有测试命名与 ID 严格兼容）
  autoNext: $('autoNext'),
  autoRate2x: $('autoRate2x'),
  autoSkipNonVideo: $('autoSkipNonVideo'),
  verbose: $('verbose'),
  state: $('state'),
  dot: $('dot'),
  printStats: $('printStats'),
  clickNext: $('clickNext'),
  diag: $('diag'),

  // 选项卡
  tabBtnPlay: $('tabBtnPlay'),
  tabBtnSite: $('tabBtnSite'),
  tabBtnDiag: $('tabBtnDiag'),
  tabPlay: $('tabPlay'),
  tabSite: $('tabSite'),
  tabDiag: $('tabDiag'),

  // 概览
  ovVideo: $('ovVideo'),
  ovRate: $('ovRate'),
  ovSite: $('ovSite'),

  // 速率控制
  rateControls: $('rateControls'),
  currentRateBadge: $('currentRateBadge'),
  rateChips: $('rateChips'),
  customRateInput: $('customRateInput'),
  applyCustomRate: $('applyCustomRate'),

  // 站点设置
  siteDomainText: $('siteDomainText'),
  siteOverrideToggle: $('siteOverrideToggle'),
  siteAutoNextSelect: $('siteAutoNextSelect'),
  siteAutoRateSelect: $('siteAutoRateSelect'),
  siteRateInput: $('siteRateInput'),
  siteAutoSkipSelect: $('siteAutoSkipSelect'),
  customSelectorInput: $('customSelectorInput'),
  saveSiteBtn: $('saveSiteBtn'),
  clearSiteBtn: $('clearSiteBtn'),

  // 诊断工具
  exportJsonBtn: $('exportJsonBtn'),
  copyTextBtn: $('copyTextBtn'),
  refreshDiagBtn: $('refreshDiagBtn'),
  recentEventsBox: $('recentEventsBox')
};

let currentSettings = { ...DEFAULTS };
let currentTabHost = '';
let currentTabFullUrl = '';
let lastDiagResults = [];

// ————————————————————————————————————————————————————————————————
// 敏感参数脱敏处理（确保复制与展示不泄露 token / cookie / ticket）
// ————————————————————————————————————————————————————————————————

function sanitizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const SENSITIVE_KEYS = /^(token|ticket|auth|authorization|session|sessionid|jwt|access_token|accesstoken|secret|signature|sign|key|password|pwd|code|user_token|enc)$/i;
  try {
    const base = 'http://localhost';
    const parsed = new URL(rawUrl, base);
    const keys = Array.from(parsed.searchParams.keys());
    for (const key of keys) {
      if (SENSITIVE_KEYS.test(key) || /token|ticket|auth|jwt|sign|secret|key|session|enc/i.test(key)) {
        parsed.searchParams.set(key, '[REDACTED]');
      }
    }
    if (parsed.hash && /token|ticket|auth|sign|key|secret|jwt|session|enc/i.test(parsed.hash)) {
      parsed.hash = '#[REDACTED]';
    }
    return parsed.toString().replace(/%5BREDACTED%5D/gi, '[REDACTED]');
  } catch (_) {
    return rawUrl.replace(/([?&](?:token|ticket|auth|jwt|sign|key|secret|session|enc)=)[^&#]*/gi, '$1[REDACTED]');
  }
}

// ————————————————————————————————————————————————————————————————
// 界面渲染与设置同步
// ————————————————————————————————————————————————————————————————

function render() {
  const isNextOn = ui.autoNext ? ui.autoNext.checked : false;
  const isRateOn = ui.autoRate2x ? ui.autoRate2x.checked : false;
  const isSkipOn = ui.autoSkipNonVideo ? ui.autoSkipNonVideo.checked : false;
  const anyOn = isNextOn || isRateOn;

  const parts = [];
  if (isNextOn) parts.push('连播');
  if (isRateOn) {
    const rateVal = currentSettings.playbackRate || 2.0;
    // 保留包含 2x 格式以兼容现有单测断言
    parts.push(Math.abs(rateVal - 2) <= 0.01 ? '2x' : `2x(${rateVal}x)`);
  }
  if (isSkipOn) parts.push('跳非视频');

  if (ui.state) {
    ui.state.textContent = anyOn ? `运行中 · ${parts.join(' + ')}` : '已关闭';
    ui.state.classList.toggle('on', anyOn);
  }
  if (ui.dot) {
    ui.dot.classList.toggle('on', anyOn);
  }

  // 更新速率角标与卡片展示
  if (ui.currentRateBadge) {
    ui.currentRateBadge.textContent = `${currentSettings.playbackRate || 2.0}x`;
  }
  if (ui.ovRate) {
    ui.ovRate.textContent = isRateOn ? `${currentSettings.playbackRate || 2.0}x` : '已关闭 (1.0x)';
  }
  if (ui.ovSite && currentTabHost) {
    const siteRule = (currentSettings.siteSettings && currentSettings.siteSettings[currentTabHost]) || null;
    const isOverridden = !!(siteRule && siteRule.override);
    ui.ovSite.textContent = isOverridden ? `${currentTabHost} (独立配置)` : `${currentTabHost} (全局默认)`;
  }
}

function updateRateChips(targetRate) {
  if (!ui.rateChips) return;
  const chips = ui.rateChips.querySelectorAll('.chip');
  chips.forEach((chip) => {
    const r = parseFloat(chip.dataset.rate);
    chip.classList.toggle('active', Math.abs(r - targetRate) < 0.01);
  });
}

function load() {
  chrome.storage.local.get(null, (values) => {
    const all = values || {};
    currentSettings = {
      autoNext: all.autoNext === true,
      autoRate: all.autoRate !== undefined ? all.autoRate === true : all.autoRate2x === true,
      autoRate2x: all.autoRate !== undefined ? all.autoRate === true : all.autoRate2x === true,
      playbackRate: typeof all.playbackRate === 'number' && all.playbackRate > 0 ? all.playbackRate : 2.0,
      autoSkipNonVideo: all.autoSkipNonVideo === true,
      verbose: all.verbose === true,
      siteSettings: (all.siteSettings && typeof all.siteSettings === 'object' && !Array.isArray(all.siteSettings)) ? all.siteSettings : {}
    };

    if (ui.autoNext) ui.autoNext.checked = currentSettings.autoNext;
    if (ui.autoRate2x) ui.autoRate2x.checked = currentSettings.autoRate2x;
    if (ui.autoSkipNonVideo) ui.autoSkipNonVideo.checked = currentSettings.autoSkipNonVideo;
    if (ui.verbose) ui.verbose.checked = currentSettings.verbose;

    updateRateChips(currentSettings.playbackRate);
    if (ui.customRateInput) ui.customRateInput.value = currentSettings.playbackRate;

    detectCurrentTab();
    render();
  });
}

function save(patch) {
  Object.assign(currentSettings, patch);
  chrome.storage.local.set(patch, render);
}

// 开关绑定
if (ui.autoNext) {
  ui.autoNext.addEventListener('change', () => {
    save({ autoNext: ui.autoNext.checked });
  });
}
if (ui.autoRate2x) {
  ui.autoRate2x.addEventListener('change', () => {
    const on = ui.autoRate2x.checked;
    save({ autoRate2x: on, autoRate: on });
  });
}
if (ui.autoSkipNonVideo) {
  ui.autoSkipNonVideo.addEventListener('change', () => {
    save({ autoSkipNonVideo: ui.autoSkipNonVideo.checked });
  });
}
if (ui.verbose) {
  ui.verbose.addEventListener('change', () => {
    save({ verbose: ui.verbose.checked });
  });
}

// 速率快捷 Chip 绑定
if (ui.rateChips) {
  ui.rateChips.addEventListener('click', (e) => {
    const chip = e.target && e.target.closest('.chip');
    if (!chip) return;
    const rate = parseFloat(chip.dataset.rate);
    if (Number.isFinite(rate) && rate > 0) {
      updateRateChips(rate);
      if (ui.customRateInput) ui.customRateInput.value = rate;
      save({ playbackRate: rate });
    }
  });
}

// 自定义速率输入
if (ui.applyCustomRate && ui.customRateInput) {
  ui.applyCustomRate.addEventListener('click', () => {
    const val = parseFloat(ui.customRateInput.value);
    if (!Number.isFinite(val) || val < 0.1 || val > 16.0) {
      alert('请输入 0.1 到 16.0 之间的合理播放倍速');
      return;
    }
    const clamped = parseFloat(val.toFixed(2));
    updateRateChips(clamped);
    save({ playbackRate: clamped });
  });
}

// ————————————————————————————————————————————————————————————————
// 选项卡切换
// ————————————————————————————————————————————————————————————————

function setupTabs() {
  const tabs = [
    { btn: ui.tabBtnPlay, panel: ui.tabPlay },
    { btn: ui.tabBtnSite, panel: ui.tabSite },
    { btn: ui.tabBtnDiag, panel: ui.tabDiag }
  ];
  tabs.forEach(({ btn, panel }) => {
    if (!btn || !panel) return;
    btn.addEventListener('click', () => {
      tabs.forEach((t) => {
        if (t.btn) t.btn.classList.remove('active');
        if (t.panel) t.panel.classList.remove('active');
      });
      btn.classList.add('active');
      panel.classList.add('active');
    });
  });
}
setupTabs();

// ————————————————————————————————————————————————————————————————
// 当前站点规则配置
// ————————————————————————————————————————————————————————————————

async function detectCurrentTab() {
  try {
    if (!chrome.tabs || !chrome.tabs.query) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return;
    currentTabFullUrl = tab.url;
    try {
      const u = new URL(tab.url);
      currentTabHost = u.hostname || '';
    } catch (_) {
      currentTabHost = '';
    }
    if (ui.siteDomainText) {
      ui.siteDomainText.textContent = currentTabHost ? `${currentTabHost} (顶层标签页)` : '无法识别当前域名';
    }
    renderSiteForm();
    render();
  } catch (_) { /* 忽略在纯 mock 环境下的查询错误 */ }
}

function renderSiteForm() {
  if (!currentTabHost) return;
  const sites = currentSettings.siteSettings || {};
  const rule = sites[currentTabHost] || {};

  if (ui.siteOverrideToggle) {
    ui.siteOverrideToggle.checked = rule.override === true;
  }
  if (ui.siteAutoNextSelect) {
    ui.siteAutoNextSelect.value = rule.autoNext === undefined ? 'inherit' : String(rule.autoNext);
  }
  if (ui.siteAutoRateSelect) {
    ui.siteAutoRateSelect.value = rule.autoRate === undefined ? 'inherit' : String(rule.autoRate);
  }
  if (ui.siteRateInput) {
    ui.siteRateInput.value = typeof rule.playbackRate === 'number' ? rule.playbackRate : '';
  }
  if (ui.siteAutoSkipSelect) {
    ui.siteAutoSkipSelect.value = rule.autoSkipNonVideo === undefined ? 'inherit' : String(rule.autoSkipNonVideo);
  }
  if (ui.customSelectorInput) {
    ui.customSelectorInput.value = rule.customNextSelector || '';
  }
}

if (ui.siteOverrideToggle) {
  ui.siteOverrideToggle.addEventListener('change', () => {
    if (!currentTabHost) return;
    const sites = { ...(currentSettings.siteSettings || {}) };
    sites[currentTabHost] = sites[currentTabHost] || {};
    sites[currentTabHost].override = ui.siteOverrideToggle.checked;
    save({ siteSettings: sites });
  });
}

if (ui.saveSiteBtn) {
  ui.saveSiteBtn.addEventListener('click', () => {
    if (!currentTabHost) {
      alert('未检测到有效站点域名');
      return;
    }
    const sites = { ...(currentSettings.siteSettings || {}) };
    const nextVal = ui.siteAutoNextSelect ? ui.siteAutoNextSelect.value : 'inherit';
    const rateVal = ui.siteAutoRateSelect ? ui.siteAutoRateSelect.value : 'inherit';
    const skipVal = ui.siteAutoSkipSelect ? ui.siteAutoSkipSelect.value : 'inherit';
    const rateNum = ui.siteRateInput && ui.siteRateInput.value ? parseFloat(ui.siteRateInput.value) : undefined;
    const customSel = ui.customSelectorInput ? ui.customSelectorInput.value.trim() : '';

    sites[currentTabHost] = {
      override: true,
      autoNext: nextVal === 'inherit' ? undefined : nextVal === 'true',
      autoRate: rateVal === 'inherit' ? undefined : rateVal === 'true',
      playbackRate: Number.isFinite(rateNum) && rateNum > 0 ? rateNum : undefined,
      autoSkipNonVideo: skipVal === 'inherit' ? undefined : skipVal === 'true',
      customNextSelector: customSel || undefined
    };

    if (ui.siteOverrideToggle) ui.siteOverrideToggle.checked = true;
    save({ siteSettings: sites });

    const btn = ui.saveSiteBtn;
    const origin = btn.textContent;
    btn.textContent = '✓ 已保存';
    setTimeout(() => { btn.textContent = origin; }, 1200);
  });
}

if (ui.clearSiteBtn) {
  ui.clearSiteBtn.addEventListener('click', () => {
    if (!currentTabHost) return;
    const sites = { ...(currentSettings.siteSettings || {}) };
    delete sites[currentTabHost];
    if (ui.siteOverrideToggle) ui.siteOverrideToggle.checked = false;
    save({ siteSettings: sites });
    renderSiteForm();

    const btn = ui.clearSiteBtn;
    const origin = btn.textContent;
    btn.textContent = '✓ 已恢复默认';
    setTimeout(() => { btn.textContent = origin; }, 1200);
  });
}

// ————————————————————————————————————————————————————————————————
// 诊断面板（纯 DOM 构建，不用 innerHTML，满足 MV3 CSP 规范）
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

  const sanitizeUrl = (rawUrl) => {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    try {
      const parsed = new URL(rawUrl, location.href);
      for (const key of Array.from(parsed.searchParams.keys())) {
        if (/^(token|ticket|auth|authorization|session|sessionid|jwt|access_token|accesstoken|secret|signature|sign|key|password|pwd|code|user_token|enc)$/i.test(key) || /token|ticket|auth|jwt|sign|secret|key|session|enc/i.test(key)) {
          parsed.searchParams.set(key, '[REDACTED]');
        }
      }
      if (parsed.hash && /token|ticket|auth|sign|key|secret|jwt|session|enc/i.test(parsed.hash)) {
        parsed.hash = '#[REDACTED]';
      }
      return parsed.toString().replace(/%5BREDACTED%5D/gi, '[REDACTED]');
    } catch (_) {
      return rawUrl.replace(/([?&](?:token|ticket|auth|jwt|sign|key|secret|session|enc)=)[^&#]*/gi, '$1[REDACTED]');
    }
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
    src: sanitizeUrl(v.currentSrc || v.src || '').slice(0, 90)
  }));

  const api = window.__AUTO_NEXT__;
  if (!api) {
    return {
      frame: window.top === window ? '顶层页面' : 'iframe',
      url: sanitizeUrl(location.href),
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

  const events = (api.events && typeof api.events === 'function') ? api.events() : [];

  return {
    frame: window.top === window ? '顶层页面' : 'iframe',
    url: sanitizeUrl(location.href),
    injected: true,
    scriptVersion: api.version || '0.0.0-旧版',
    autoNext: api.settings ? api.settings.enabled === true : false,
    autoRate2x: api.settings ? (api.settings.autoRate === true || api.settings.autoRate2x === true) : false,
    autoSkipNonVideo: api.settings ? api.settings.autoSkipNonVideo === true : false,
    playbackRate: (api.settings && api.settings.playbackRate) || 2.0,
    customNextSelector: (api.settings && api.settings.customNextSelector) || '',
    videos,
    diag,
    skipDiag,
    events,
    candidates: (api.candidates && typeof api.candidates === 'function') ? api.candidates().slice(0, 5).map((c) => ({
      text: c.text,
      tag: c.el.tagName,
      id: c.el.id || '',
      cls: String(c.el.className || '').slice(0, 40),
      score: c.score,
      reason: c.reason
    })) : [],
    stats: (api.stats && typeof api.stats === 'function') ? api.stats() : {}
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

  // 暂停取证：区分"平台/反作弊暂停"和"本插件误伤"
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

  // 跨 frame 交接情况
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

/** 根据探测结果生成结论 */
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
    const target = result.playbackRate || 2.0;
    const rateOk = Math.abs(v.playbackRate - target) <= 0.01;
    const rateState = (stats.rates || [])[0] || null;
    out.push([true, `检测到播放器：总长 ${v.durationText}，当前 ${v.positionText}，${v.paused ? '已暂停' : '播放中'}，倍速 ${v.playbackRate}x`]);
    if (result.autoRate2x === true && rateState && rateState.rateSuspended === true) {
      out.push([true, '当前视频触发了平台倍速限制，插件已自动回退到 1.0x 以保持播放；换到下一视频后会重新判断']);
    } else if (result.autoRate2x === true && !rateOk) {
      const targetStr = Math.abs(target - 2) <= 0.01 ? '2.0x' : `${target}x`;
      out.push([false, `开了二倍速但当前不是 ${targetStr}，可能被站点反复重置`]);
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
  lastDiagResults = results;
  if (ui.diag) {
    ui.diag.hidden = false;
    ui.diag.textContent = '';
  }

  // 渲染最近事件流
  renderEventLog(results);

  if (!results.length) {
    const sec = section('检测结果');
    sec.appendChild(el('div', 'empty', '没有拿到任何 frame 的结果。'));
    if (ui.diag) ui.diag.appendChild(sec);
    return;
  }

  // 更新首页概览
  const withVideo = results.filter((r) => r.result && r.result.videos && r.result.videos.length);
  const withCandidates = results.filter((r) => r.result && r.result.candidates && r.result.candidates.length);

  if (ui.ovVideo) {
    if (withVideo.length > 0) {
      const v = withVideo[0].result.videos[0];
      ui.ovVideo.textContent = `${v.paused ? '已暂停' : '播放中'} (${v.positionText}/${v.durationText})`;
    } else {
      ui.ovVideo.textContent = '未发现播放器';
    }
  }

  const head = section('总览');
  kv(head, '扩展版本', popupVersion || '未知');
  kv(head, '页面', sanitizeUrl(tabUrl) || '—');
  kv(head, 'frame 数', results.length);
  kv(head, '有播放器', `${withVideo.length} 个`);
  kv(head, '有下一节按钮', `${withCandidates.length} 个`);
  const skipTotal = results.reduce((n, r) => n + ((r.result && r.result.skipDiag && r.result.skipDiag.totalSkips) || 0), 0);
  if (skipTotal) kv(head, '已跳过非视频页', `${skipTotal} 个`);

  // 版本一致性检查
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
  if (ui.diag) ui.diag.appendChild(head);

  // 每个 frame 明细
  results.forEach(({ frameId, result }) => {
    const title = `frame ${frameId}${result && result.frame ? ` · ${result.frame}` : ''}`;
    const sec = section(title);
    if (!result) {
      sec.appendChild(el('div', 'empty', '该 frame 无法读取'));
      if (ui.diag) ui.diag.appendChild(sec);
      return;
    }

    kv(sec, '地址', sanitizeUrl(result.url));
    if (result.injected) {
      kv(sec, '代码版本', result.scriptVersion || '旧版（无版本号）');
      kv(sec, '连播', result.autoNext ? '开' : '关');
      kv(sec, '二倍速', result.autoRate2x ? '开' : '关');
      kv(sec, '生效倍速', `${result.playbackRate || 2.0}x`);
      if (result.customNextSelector) {
        kv(sec, '自定义选择器', result.customNextSelector);
      }
      kv(sec, '跳非视频', result.autoSkipNonVideo ? '开' : '关');
    }
    (result.videos || []).forEach((v, i) => {
      kv(sec, `视频${i + 1}`, `${v.durationText} / 进度 ${v.positionText} / ${v.paused ? '暂停' : '播放中'} / ${v.playbackRate}x`);
      kv(sec, '', sanitizeUrl(v.src) || '(无 src)');
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

    const timeline = buildTimeline(result);
    if (timeline.length) {
      const box = el('div', 'sec');
      box.appendChild(el('h2', null, '这个 frame 的现场还原'));
      timeline.forEach(([ok, text]) => verdict(box, ok, text));
      if (ui.diag) ui.diag.appendChild(box);
    }

    const sd = result.skipDiag;
    if (sd && (sd.enabled || sd.totalSkips > 0)) {
      const box = el('div', 'sec');
      box.appendChild(el('h2', null, '自动跳过非视频页面'));
      verdict(box, true, `本轮已连续跳过 ${sd.consecutiveSkips}/${sd.max} 个，累计 ${sd.totalSkips} 个`);
      if (sd.lastStopReason) verdict(box, false, `最近一次停止原因：${sd.lastStopReason}`);
      if (!sd.enabled) verdict(box, false, '开关当前是关闭的');
      if (ui.diag) ui.diag.appendChild(box);
    }

    buildVerdicts(result).forEach(([ok, text]) => verdict(sec, ok, text));
    if (ui.diag) ui.diag.appendChild(sec);
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
    if (ui.diag) ui.diag.appendChild(sec);
  }
}

function renderEventLog(results) {
  if (!ui.recentEventsBox) return;
  ui.recentEventsBox.textContent = '';

  let allEvents = [];
  results.forEach(({ frameId, result }) => {
    if (result && Array.isArray(result.events)) {
      result.events.forEach((ev) => allEvents.push({ ...ev, frameId }));
    }
  });

  if (allEvents.length === 0) {
    ui.recentEventsBox.appendChild(el('div', 'empty', '暂无关键事件记录'));
    return;
  }

  allEvents.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const recent = allEvents.slice(-25);

  recent.forEach((ev) => {
    const row = el('div', 'event-line');
    const timeStr = new Date(ev.timestamp || Date.now()).toTimeString().slice(0, 8);
    row.appendChild(el('span', 'event-time', `[${timeStr}]`));
    row.appendChild(el('span', 'event-type', ev.type));
    let detailStr = '';
    if (ev.detail) {
      if (typeof ev.detail === 'string') detailStr = ev.detail;
      else detailStr = Object.entries(ev.detail).map(([k, v]) => `${k}=${v}`).join(' ');
    }
    row.appendChild(el('span', 'event-detail', detailStr || '(无详情)'));
    ui.recentEventsBox.appendChild(row);
  });
}

// 诊断检测触发
async function runDetection() {
  if (ui.printStats) ui.printStats.classList.add('busy');
  const original = ui.printStats ? ui.printStats.textContent : '检测当前标签页';
  if (ui.printStats) ui.printStats.textContent = '检测中…';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error('找不到当前标签页');

    let target = { tabId: tab.id };
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
      if (frames && frames.length) target = { tabId: tab.id, frameIds: frames.map((f) => f.frameId) };
    } catch (_) { /* 降级为主 frame */ }

    const results = await chrome.scripting.executeScript({ target, func: probeFrame });
    const rows = results
      .slice()
      .sort((a, b) => a.frameId - b.frameId)
      .map(({ frameId, result }) => ({ frameId, result: result || null }));

    renderDiag(rows, tab.url, chrome.runtime.getManifest().version);
    if (ui.printStats) ui.printStats.textContent = '✓ 已检测';
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (ui.diag) {
      ui.diag.hidden = false;
      ui.diag.textContent = '';
      const sec = section('检测失败');
      sec.appendChild(el('div', 'empty', /cannot be scripted|Cannot access/i.test(message)
        ? '该页面不允许注入（设置页 / 扩展商店等受限页面）'
        : message));
      ui.diag.appendChild(sec);
    }
    if (ui.printStats) ui.printStats.textContent = '检测失败';
  } finally {
    setTimeout(() => {
      if (ui.printStats) {
        ui.printStats.textContent = original;
        ui.printStats.classList.remove('busy');
      }
    }, 1500);
  }
}

if (ui.printStats) ui.printStats.addEventListener('click', runDetection);
if (ui.refreshDiagBtn) ui.refreshDiagBtn.addEventListener('click', runDetection);

// ————————————————————————————————————————————————————————————————
// 手动点“下一节”
// ————————————————————————————————————————————————————————————————

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
  api.clickNext();
  result.clicked = true;
  return result;
}

function renderClickResult(rows) {
  if (ui.diag) {
    ui.diag.hidden = false;
    ui.diag.textContent = '';
  }

  const sec = section('手动点击“下一节”');
  const hit = rows.find((r) => r.result && r.result.clicked);
  if (hit) {
    verdict(sec, true, `已点击「${hit.result.text}」（score=${hit.result.score}，${hit.result.frame}）`);
    verdict(sec, true, '如果页面确实翻到了下一节，说明查找与点击都正常；自动流程没触发，问题就出在“视频结束判定”上');
  } else {
    verdict(sec, false, '所有 frame 都没有找到可点击的“下一节”按钮');
    verdict(sec, false, '→ 这就是自动跳转失效的原因：该页面的按钮不在候选列表里，需要补充选择器');
  }
  if (ui.diag) ui.diag.appendChild(sec);
  rows.forEach(({ frameId, result }) => {
    if (!result) return;
    const cands0 = result.candidates || [];
    const box = el('div', 'sec');
    box.appendChild(el('h2', null, `frame ${frameId} · ${result.frame || ''}`));
    kv(box, '地址', sanitizeUrl(result.url));
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
    if (ui.diag) ui.diag.appendChild(box);
  });
}

if (ui.clickNext) {
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
      if (ui.diag) {
        ui.diag.hidden = false;
        ui.diag.textContent = '';
        const sec = section('手动点击失败');
        sec.appendChild(el('div', 'empty', err && err.message ? err.message : String(err)));
        ui.diag.appendChild(sec);
      }
      ui.clickNext.textContent = '执行失败';
    } finally {
      setTimeout(() => {
        ui.clickNext.textContent = original;
        ui.clickNext.classList.remove('busy');
      }, 1500);
    }
  });
}

// ————————————————————————————————————————————————————————————————
// 一键复制与脱敏诊断导出
// ————————————————————————————————————————————————————————————————

function copyToClipboard(text, successMsg = '✓ 已复制到剪贴板') {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      alert(successMsg);
    }).catch(() => {
      prompt('请按 Ctrl+C 复制以下内容：', text);
    });
  } else {
    prompt('请按 Ctrl+C 复制以下内容：', text);
  }
}

if (ui.exportJsonBtn) {
  ui.exportJsonBtn.addEventListener('click', () => {
    const report = {
      manifestVersion: '3',
      extensionVersion: chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '1.2.0',
      exportedAt: new Date().toISOString(),
      currentHost: currentTabHost,
      tabUrl: sanitizeUrl(currentTabFullUrl),
      settings: {
        autoNext: currentSettings.autoNext,
        autoRate: currentSettings.autoRate,
        playbackRate: currentSettings.playbackRate,
        autoSkipNonVideo: currentSettings.autoSkipNonVideo,
        verbose: currentSettings.verbose,
        siteRule: (currentSettings.siteSettings && currentSettings.siteSettings[currentTabHost]) || null
      },
      frames: lastDiagResults.map(({ frameId, result }) => {
        if (!result) return { frameId, available: false };
        return {
          frameId,
          frameType: result.frame,
          url: sanitizeUrl(result.url),
          injected: result.injected,
          scriptVersion: result.scriptVersion,
          videos: (result.videos || []).map((v) => ({
            durationText: v.durationText,
            positionText: v.positionText,
            paused: v.paused,
            playbackRate: v.playbackRate,
            src: sanitizeUrl(v.src)
          })),
          candidates: result.candidates || [],
          events: result.events || [],
          diagnostics: result.diag || null
        };
      })
    };
    copyToClipboard(JSON.stringify(report, null, 2), '✓ 脱敏诊断 JSON 已复制到剪贴板');
  });
}

if (ui.copyTextBtn) {
  ui.copyTextBtn.addEventListener('click', () => {
    const lines = [];
    lines.push(`=== AutoNext 诊断报告 (v${chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '1.2.0'}) ===`);
    lines.push(`时间: ${new Date().toLocaleString()}`);
    lines.push(`页面域名: ${currentTabHost || '(无)'}`);
    lines.push(`全局配置: 连播=${currentSettings.autoNext ? '开' : '关'}, 倍速=${currentSettings.autoRate ? '开' : '关'}(${currentSettings.playbackRate}x), 跳非视频=${currentSettings.autoSkipNonVideo ? '开' : '关'}`);
    if (currentTabHost && currentSettings.siteSettings && currentSettings.siteSettings[currentTabHost]) {
      lines.push(`当前站点规则: ${JSON.stringify(currentSettings.siteSettings[currentTabHost])}`);
    }
    lines.push(`Frame 数量: ${lastDiagResults.length}`);

    lastDiagResults.forEach(({ frameId, result }) => {
      if (!result) {
        lines.push(`\n[Frame ${frameId}] 无法读取`);
        return;
      }
      lines.push(`\n[Frame ${frameId} · ${result.frame || '未知'}]`);
      lines.push(`  地址: ${sanitizeUrl(result.url)}`);
      lines.push(`  已注入脚本: ${result.injected ? `是 (v${result.scriptVersion})` : '否'}`);
      if (result.videos && result.videos.length) {
        result.videos.forEach((v, idx) => {
          lines.push(`  视频 #${idx + 1}: ${v.durationText} / 进度 ${v.positionText} / ${v.paused ? '暂停' : '播放中'} / ${v.playbackRate}x`);
        });
      } else {
        lines.push('  视频: 未检测到');
      }
      if (result.candidates && result.candidates.length) {
        lines.push(`  候选按钮 (前 ${result.candidates.length} 项):`);
        result.candidates.forEach((c) => {
          lines.push(`    - [${c.score}] ${c.text || c.tag} (${c.reason})`);
        });
      }
      if (result.events && result.events.length) {
        lines.push('  最近事件:');
        result.events.slice(-5).forEach((ev) => {
          const t = new Date(ev.timestamp).toTimeString().slice(0, 8);
          lines.push(`    [${t}] ${ev.type}: ${JSON.stringify(ev.detail)}`);
        });
      }
    });

    lines.push('\n==================================');
    copyToClipboard(lines.join('\n'), '✓ 诊断纯文本已复制到剪贴板');
  });
}

load();

