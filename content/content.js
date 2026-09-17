/**
 * content.js —— 主控制器
 *
 * 串起所有模块并负责：
 *   · 启动 / 停止（响应 popup 开关）
 *   · MutationObserver 监听 SPA 动态插入的播放器与按钮
 *   · iframe 场景下的父子 frame 协调
 *   · 视频结束后的重试式跳转
 *
 * 合规边界（重要）：本脚本只做“检测视频 + 播放结束后点击页面自带的下一节按钮”。
 * 不修改播放进度、不伪造学习时长、不发送任何伪造完成请求、不绕过验证码或检测机制。
 */
(function () {
  'use strict';

  const AutoNext = window.AutoNext;
  if (!AutoNext || !AutoNext.videoHandler) return;

  const { dom, messenger, toast } = AutoNext;
  const videoHandler = AutoNext.videoHandler;

  /** 自动跳过非视频页面（可选依赖，缺失时静默降级） */
  const skip = AutoNext.skipController || { start: () => {}, stop: () => {}, onPageSettled: () => {}, reset: () => {}, isEnabled: () => false, diagnostics: () => null };

  /** 自动二倍速模块（可选依赖，缺失时静默降级） */
  const rate = AutoNext.rateController || {
    applyAll: () => 0, onToggle: () => {}, isEnabled: () => false, snapshot: () => []
  };

  const SCAN_THROTTLE_MS = 500;
  const URL_CHECK_MS = 5000;

  let observer = null;
  let scanTimer = null;
  let urlCheckTimer = null;
  let started = false;
  let rateReady = false;
  let lastScanUrl = location.href;
  const MANUAL_CLICK_GRACE_MS = 2500;

  const frameLabel = messenger.isTop ? '顶层页面 (top)' : 'iframe 子页面';

  // —— 扫描 ——————————————————————————————————————————————————

  function scan() {
    if (!started) return [];
    if (location.href !== lastScanUrl) {
      AutoNext.debug(`页面 URL 变化：${lastScanUrl} → ${location.href}（SPA 换页）`);
      lastScanUrl = location.href;
      videoHandler.resetCycle();
      skip.onPageSettled('SPA 换页后');
    }
    return videoHandler.scan();
  }

  const throttledScan = dom.throttle(scan, SCAN_THROTTLE_MS);

  function scheduleScan(delay = 300) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => throttledScan(), delay);
  }

  function attemptAutoPlay(video) {
    if (!AutoNext.settings.enabled) return;
    if (document.hidden) {
      AutoNext.debug('页面在后台，等回到前台再自动播放');
      return;
    }
    videoHandler.tryAutoPlay(video);
  }

  // —— 跳转事件处理 ——————————————————————————————————————————

  /** 本 frame 的视频自然结束 */
  function onVideoEnded() {
    videoHandler.countEndedCycles();
    videoHandler.triggerNextLesson('本 frame 视频自然结束');
  }

  /**
   * 挂到 window 上，方便在控制台手工排查：
   * 别的 frame 的视频结束了：代为查找一次，命中就点。
   * @returns {boolean} 本 frame 是否处理了；返回 false 时消息会继续向上中继
   */
  function onRemoteVideoEnded() {
    if (!started || !AutoNext.settings.enabled) return false;
    if (messenger.recentlyNavigated()) {
      AutoNext.debug('其他 frame 已跳转，忽略远程结束通知');
      return true; // 已经有人跳过了，不必再中继
    }
    AutoNext.debug('收到其他 frame 的视频结束通知，代为查找下一节');
    const found = AutoNext.buttonFinder.findNextButton();
    if (!found) {
      AutoNext.warn('next lesson not found：本 frame 也没有可用的下一节按钮');
      messenger.setBadge('!', '#dc2626');
      return false; // 让消息继续向上中继
    }
    AutoNext.log('next lesson found', found.text || '(无文字)', `score=${found.score}`, '[来自其他 frame 的请求]');
    AutoNext.log('navigating to next lesson', `→ 点击「${found.text || found.el.tagName}」`);
    dom.click(found.el);
    messenger.setBadge('→', '#16a34a');
    messenger.reportNavigated();
    videoHandler.resetCycle();
    toast.show('已跳转下一节', 'success');
    return true;
  }

  /** 父级要求重新扫描（iframe 换页后父级感知不到） */
  function onRemoteScan() {
    AutoNext.debug('收到父级扫描请求');
    scheduleScan(100);
    rate.applyAll('父级请求');
  }

  /** 确认已经跳转，停止本 frame 的重复动作 */
  function onRemoteNavigated() {
    videoHandler.resetCycle();
  }

  // —— 手动操作的尊重：用户自己点过“下一节”，就不再插手 ————————————

  function watchUserNavigation() {
    document.addEventListener(
      'click',
      (event) => {
        if (!started) return;
        // 插件自己派发的点击也会冒泡到这里，用“流程进行中”做区分
        if (videoHandler.stats().cycle.running) return;
        const target = event.target && event.target.closest
          ? event.target.closest('a, button, [role="button"], [onclick], li, span, div')
          : null;
        if (!target) return;
        const text = dom.normalize(dom.textOf(target));
        if (!text || text.length > 40) return;
        if (/(下一节|下一章|下一个|下一任务点|上一节|上一章)/.test(text)) {
          AutoNext.debug(`检测到手动导航点击（${text}），静默 ${MANUAL_CLICK_GRACE_MS}ms 以免重复跳转`);
          videoHandler.resetCycle();
          setTimeout(() => {
            AutoNext.debug('手动导航静默期结束');
          }, MANUAL_CLICK_GRACE_MS);
        }
      },
      true
    );
  }

  // —— SPA 路由监听与历史栈增强 ——————————————————————————————

  function watchSpaNavigation() {
    const notifyRoute = () => {
      if (location.href !== lastScanUrl) {
        AutoNext.debug(`SPA 路由切换检测：${lastScanUrl} → ${location.href}`);
        lastScanUrl = location.href;
        videoHandler.resetCycle();
        scheduleScan(150);
        skip.onPageSettled('SPA 换页后');
      }
    };

    try {
      if (window.history) {
        const origPush = window.history.pushState;
        if (typeof origPush === 'function') {
          window.history.pushState = function (...args) {
            const ret = origPush.apply(this, args);
            notifyRoute();
            return ret;
          };
        }
        const origReplace = window.history.replaceState;
        if (typeof origReplace === 'function') {
          window.history.replaceState = function (...args) {
            const ret = origReplace.apply(this, args);
            notifyRoute();
            return ret;
          };
        }
      }
    } catch (_) { /* 某些安全策略下忽略 */ }

    window.addEventListener('popstate', notifyRoute);
    window.addEventListener('hashchange', notifyRoute);
  }

  // —— MutationObserver：处理 SPA / 动态插入的播放器 ————————————

  function startObserver() {
    if (observer) return;
    // 只防抖“安排扫描”这一步，不能防抖原始 mutation 列表。
    // 学习通会先插入 <video>，紧接着再插入普通播放器控件；如果后一批无关变更
    // 覆盖了前一批参数，就会永久错过新视频。
    const scheduleVideoScan = dom.debounce(() => {
      AutoNext.debug('MutationObserver：检测到新的视频节点');
      scheduleScan(200);
    }, 300);
    const onMutate = (mutations) => {
      let relevant = false;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === 'VIDEO' || node.tagName === 'SOURCE' || (node.querySelector && node.querySelector('video')) || node.shadowRoot) {
            relevant = true;
            break;
          }
        }
        if (relevant) break;
      }
      if (relevant) {
        scheduleVideoScan();
      }
    };

    observer = new MutationObserver(onMutate);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    AutoNext.debug('MutationObserver 已启动');
  }

  function stopObserver() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
    AutoNext.debug('MutationObserver 已停止');
  }

  // —— 启停 ——————————————————————————————————————————————————

  function onEnabled() {
    started = true;
    AutoNext.log(`自动连播已启用（${frameLabel}）`);
    scan();
    startObserver();
    videoHandler.startWatchdog(); // 兜底：平台在结尾自行暂停、不触发 ended 时也能识别
    urlCheckTimer = setInterval(() => {
      if (location.href !== lastScanUrl) scheduleScan(100);
    }, URL_CHECK_MS);
  }

  function onDisabled() {
    started = false;
    stopObserver();
    videoHandler.stopWatchdog();
    skip.stop();
    clearInterval(urlCheckTimer);
    urlCheckTimer = null;
    videoHandler.resetCycle();
  }

  /**
   * 开关变化（popup 改完立刻生效，无需刷新页面）
   * @param {{autoNext?: boolean, autoRate?: boolean, autoRate2x?: boolean, playbackRate?: number}} changed
   */
  function onSettingsChanged(changed = {}) {
    if ('autoNext' in changed) {
      if (changed.autoNext) onEnabled();
      else onDisabled();
    }
    if (('autoRate' in changed || 'autoRate2x' in changed || 'playbackRate' in changed) && rateReady) {
      const isRateOn = !!(AutoNext.settings.autoRate || AutoNext.settings.autoRate2x);
      rate.onToggle(isRateOn);
      if (isRateOn && 'playbackRate' in changed && rate.updateTargetRate) {
        rate.updateTargetRate(changed.playbackRate);
      } else {
        rate.applyAll('开关变更');
      }
    }
    if ('autoSkipNonVideo' in changed && rateReady) {
      if (changed.autoSkipNonVideo) skip.start();
      else skip.stop();
    }
    if ('customNextSelector' in changed) {
      AutoNext.debug(`站点自定义选择器更新：${changed.customNextSelector}`);
    }
  }

  async function init() {
    await AutoNext.settings.load();
    watchUserNavigation();
    watchSpaNavigation();
    AutoNext.settings.subscribe(onSettingsChanged);
    // 自动倍速先落地（它与连播开关互相独立，且要在扫描前就位）
    rate.onToggle(rate.isEnabled());
    rateReady = true;
    // 自动跳过非视频页面：只在开关打开时启动
    if (AutoNext.settings.autoSkipNonVideo) skip.start();
    if (AutoNext.settings.enabled) {
      onEnabled();
    } else {
      AutoNext.log(`插件已加载但开关关闭（${frameLabel}），打开 popup 里的开关后即可生效`);
    }
  }

  // —— 模块接线 ——————————————————————————————————————————————

  videoHandler.setHandlers({
    onVideoAvailable: (video) => {
      if (!started) return;
      utils.attemptAutoPlay(video);
    }
  });

  function onRemoteNavigating() {
    AutoNext.debug('收到其他 frame 的正在跳转广播，加锁防并发');
  }

  const utils = {
    attemptAutoPlay,
    scan,
    scheduleScan,
    onVideoEnded,
    onRemoteVideoEnded,
    onRemoteScan,
    onRemoteNavigated,
    onRemoteNavigating
  };

  messenger.listen({
    onVideoEnded: onRemoteVideoEnded,
    onScan: onRemoteScan,
    onNavigating: onRemoteNavigating,
    onNavigated: onRemoteNavigated
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && started) {
      AutoNext.debug('页面回到前台，重新扫描视频');
      scheduleScan(150);
    }
  });

  window.addEventListener('pagehide', () => {
    stopObserver();
    clearInterval(urlCheckTimer);
  });

  AutoNext.setRate = function(val) {
    const target = rate.updateTargetRate ? rate.updateTargetRate(val) : rate.clampRate(val);
    rate.applyAll('手动调用');
    return target;
  };
  AutoNext.getEvents = function() {
    return AutoNext.logger ? AutoNext.logger.getEvents() : [];
  };

  // 供 DevTools 手动调试：__AUTO_NEXT__.stats() / .scan() / .clickNext()
  window.__AUTO_NEXT__ = {
    /** 本 content script 的版本，popup 用它判断"代码是不是旧的" */
    version: (() => {
      try {
        return chrome.runtime.getManifest().version;
      } catch (_) {
        return 'unknown';
      }
    })(),
    controller: utils,
    videoHandler,
    buttonFinder: AutoNext.buttonFinder,
    rateController: rate,
    skipController: skip,
    settings: AutoNext.settings,
    stats: () => videoHandler.stats(),
    scan: () => scan(),
    candidates: (sel) => AutoNext.buttonFinder.findCandidates(sel).slice(0, 10),
    clickNext: (sel) => AutoNext.buttonFinder.clickNextButton(40, sel),
    events: () => (AutoNext.getEvents ? AutoNext.getEvents() : []),
    /** 手动触发一次“跳过当前非视频页面”的判断（用于临时验证） */
    trySkip() {
      return skip.attemptSkip('手动调用');
    },
    /** 手动把当前页面所有播放器设为 2 倍速（兼容旧 API） */
    rate2x() {
      return this.setRate(2.0);
    },
    /** 手动设置目标播放速率 */
    setRate(val) {
      const target = rate.updateTargetRate ? rate.updateTargetRate(val) : rate.clampRate(val);
      const changed = rate.applyAll('手动调用');
      return changed ? `已对 ${changed} 个播放器设为 ${target}x` : `当前播放器已处于 ${target}x 状态`;
    },
    debug(on) {
      const verbose = on !== false;
      if (AutoNext.hasStorage) chrome.storage.local.set({ verbose });
      else AutoNext.setLogOptions({ verbose });
      return `详细日志已${verbose ? '开启' : '关闭'}`;
    }
  };

  init().catch((err) => AutoNext.error('初始化失败：', err));

})();
