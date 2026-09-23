/**
 * skip-controller.js —— 自动跳过非视频页面
 *
 * 用途：下一节不是视频（章节测验、讨论、空白任务点等）时，继续点“下一节”，
 * 直到遇到有播放器的章节为止。这样连播链条不会因为一个非视频任务点而中断。
 *
 * ⚠️ 风险提示（这也是它默认关闭的原因）：
 * “不是视频”的章节往往是**需要完成的测验 / 作业 / 讨论**。
 * 跳过它们可能让你丢掉这部分成绩，而且这类页面通常需要你亲自作答，
 * 跳过等于放弃。请你自己判断是否开启。
 *
 * 安全设计（避免把整门课一路点过去）：
 *   · 默认关闭，必须在 popup 里手动打开；
 *   · 连续跳过的页数有上限（默认 5），一路上限立刻停止并提示；
 *   · 每个页面只尝试一次，绝不重复点同一页的“下一节”；
 *   · 一旦遇到真正的视频，计数立即清零；
 *   · 检测到“点了但页面没变”（同一地址反复出现）时判定为死循环并停止。
 *
 * 合规边界：本模块只做“点击页面自带的下一节按钮”，
 * 不提交任何表单、不代替答题、不调用任何课程平台接口。
 */
(function () {
  'use strict';

  const AutoNext = window.AutoNext;
  const { messenger, toast } = AutoNext;

  const DEFAULT_OPTIONS = {
    /** 连续最多跳过几个非视频页面 */
    maxConsecutiveSkips: 5,
    /** 点击“下一节”后等多久再判断结果 */
    waitAfterClickMs: 3000,
    /** 进入页面后先等多久再判定“这里没有视频” */
    settleMs: 2500
  };

  let options = { ...DEFAULT_OPTIONS };
  let enabled = false;
  let running = false;
  /** 定时器集合，便于销毁 */
  const timers = new Set();
  /** 已经尝试过跳过的地址，用来识别死循环 */
  const visited = new Set();

  const state = {
    /** 本轮连续跳过了几个非视频页面（遇到视频会清零） */
    consecutiveSkips: 0,
    /** 累计跳过数 */
    totalSkips: 0,
    /** 停止原因，诊断面板会显示 */
    lastStopReason: '',
    /** 最近一次跳过的时间 */
    lastSkipAt: 0
  };

  function schedule(fn, ms) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      try {
        fn();
      } catch (err) {
        AutoNext.error('跳过流程异常：', err);
      }
    }, ms);
    timers.add(timer);
    return timer;
  }

  function clearTimers() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  }

  /**
   * 本页面是否可能承载视频。
   *
   * 这里必须非常保守：新页面刚加载时 video.duration 是 NaN、
   * 平台换源时会短暂把 duration 清掉，这些时刻都不能判定成"没有视频"，
   * 否则会误判并对正在播放的页面点"下一节"，表现为"视频播几秒就被打断"。
   *
   * 播放器常在子 iframe 内，顶层页面只看自己的 <video> 会误判为非视频页。
   * 跨域 iframe 无法安全检查其内部，因此有嵌入 frame 时也交给连播逻辑处理。
   */
  function hasPlayableVideo() {
    return document.querySelectorAll('video, iframe, frame').length > 0;
  }

  /**
   * 页面是否正在播放（或正在缓冲）。
   * 这是比 duration 可靠得多的"这里有视频"信号：
   * 正在播放的元素即使 duration 暂时是 NaN，也绝不能被跳过。
   */
  function isPlaying() {
    return Array.from(document.querySelectorAll('video')).some(
      (video) => video.paused === false || video.readyState > 0
    );
  }

  /** 找一个可点击的“下一节”，找不到返回 null */
  function findNext() {
    const finder = AutoNext.buttonFinder;
    if (!finder) return null;
    try {
      const found = finder.findNextButton();
      if (!found) return null;
      // 明显不是“前进”方向的按钮不要碰（防止把“上一节”当成“下一节”）
      const text = String(found.text || '');
      if (/上一|返回|prev|back/i.test(text)) return null;
      return found;
    } catch (err) {
      AutoNext.debug('跳过时查找按钮失败：', err && err.message);
      return null;
    }
  }

  function stop(reason, { warn = true } = {}) {
    running = false;
    state.lastStopReason = reason;
    if (warn) AutoNext.warn(`已停止自动跳过：${reason}`);
  }

  /**
   * 尝试跳过当前这个非视频页面。
   * @param {string} reason 触发来源，写进日志便于排查
   */
  function attemptSkip(reason) {
    if (!enabled || running) return false;

    // ★ 只要页面上出现过 <video>（哪怕 duration 还没就绪、哪怕正在缓冲），
    //   就绝不跳过 —— 这一条是防止"把正在播放的视频打断"的关键。
    if (hasPlayableVideo() || isPlaying()) {
      state.consecutiveSkips = 0;
      return false;
    }
    if (state.consecutiveSkips >= options.maxConsecutiveSkips) {
      stop(`连续跳过了 ${state.consecutiveSkips} 个非视频页面，达到上限（可在 popup 里调整上限）`);
      toast.show(`已连续跳过 ${state.consecutiveSkips} 个非视频页面，停止自动跳过`, 'warn');
      return false;
    }

    const here = location.href;
    if (visited.has(here)) {
      stop('同一个页面被重复访问，判定为死循环');
      return false;
    }

    const found = findNext();
    if (!found) {
      stop('这一页找不到可用的“下一节”按钮（不做任何操作）', { warn: false });
      AutoNext.warn('skip-next：这一页没有视频，也找不到“下一节”按钮，已停止（不做任何操作）');
      return false;
    }

    running = true;
    visited.add(here);
    state.consecutiveSkips += 1;
    state.totalSkips += 1;
    state.lastSkipAt = Date.now();

    AutoNext.log('非视频页面，继续下一节',
      `第 ${state.consecutiveSkips}/${options.maxConsecutiveSkips} 个`,
      `→ 点击「${found.text || found.el.tagName}」`,
      `(触发来源：${reason})`);
    messenger.setBadge(String(state.consecutiveSkips), '#f59e0b');
    AutoNext.buttonFinder.clickNextButton();
    messenger.reportNavigated(); // 防止同一页被其他 frame 再点一次

    // 点完之后等页面变化，再决定要不要继续
    schedule(() => {
      running = false;
      if (!enabled) return;
      if (hasPlayableVideo() || isPlaying()) {
        state.consecutiveSkips = 0;
        AutoNext.log('已跳到一个有视频的章节，停止跳过');
        return;
      }
      if (location.href === here) {
        stop('点击“下一节”后页面没有变化，判定为无法继续');
        return;
      }
      attemptSkip('上一个页面也不是视频');
    }, options.waitAfterClickMs);

    return true;
  }

  /** 进入新页面后调用：等页面稳定再判断要不要跳过 */
  function onPageSettled(reason) {
    if (!enabled) return;
    if (hasPlayableVideo() || isPlaying()) {
      state.consecutiveSkips = 0;
      return;
    }
    // 页面刚切换时视频元素可能还没建出来，多等一会儿再判断，
    // 避免把"正在加载的播放器"误判成"没有视频"。
    schedule(() => {
      if (!enabled || hasPlayableVideo() || isPlaying()) return;
      attemptSkip(reason);
    }, options.settleMs);
  }

  function start() {
    enabled = true;
    AutoNext.log('自动跳过非视频页面已开启',
      `（连续最多跳过 ${options.maxConsecutiveSkips} 个，遇到视频即停止）`);
    onPageSettled('开关已开启');
  }

  function stopAll() {
    enabled = false;
    running = false;
    clearTimers();
    AutoNext.log('自动跳过非视频页面已关闭');
  }

  function reset() {
    state.consecutiveSkips = 0;
    state.lastStopReason = '';
    visited.clear();
  }

  AutoNext.skipController = {
    start,
    stop: stopAll,
    /** 视频结束跳转后 / 页面变化后调用 */
    onPageSettled,
    attemptSkip,
    reset,
    isEnabled: () => enabled,
    diagnostics: () => ({ ...state, enabled, running, max: options.maxConsecutiveSkips }),
    configure(opts) {
      options = { ...options, ...opts };
      return { ...options };
    },
    get options() {
      return { ...options };
    }
  };

})();
