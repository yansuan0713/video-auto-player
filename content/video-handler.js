/**
 * video-handler.js —— HTML5 <video> 检测、自动续播与“自然播放结束”判定
 *
 * 合规声明：本模块只控制播放器的播放/暂停状态，并在**播放自然结束**后触发导航。
 * 不修改 currentTime、不改 playbackRate、不伪造学习时长、不发送任何请求。
 */
(function () {
  'use strict';

  const AutoNext = window.AutoNext;
  const { dom, messenger } = AutoNext;
  const toast = AutoNext.toast || { show: () => {} };
  /** 自动二倍速模块（可选依赖，缺失时静默降级） */
  const rate = AutoNext.rateController || {
    apply: () => false, applyAll: () => 0, bind: () => {}, fallbackToNormal: () => false,
    isEnabled: () => false, snapshot: () => []
  };
  /** 自动跳过非视频页面（可选依赖，缺失时静默降级） */
  const skip = AutoNext.skipController || null;

  const DEFAULT_OPTIONS = {
    /** 判定"播到结尾"的容差（秒）—— 用于 ended 事件 */
    endTolerance: 1.5,
    /** 轮询兜底判定"已经播完"的容差（秒）—— 平台可能停在离结尾几秒处 */
    finishTolerance: 3,
    /** 视频至少要播放过这么久，才算"真的看过"（防止拖到结尾被当成看完） */
    minPlayedSeconds: 3,
    /** 时长太短的元素直接忽略（广告、动图预览） */
    minDuration: 15,
    /** 单次 timeupdate 跳变超过这个秒数，视为拖进度条，不计入有效播放 */
    maxTrustedDelta: 30,
    /** 同一个视频最多尝试自动播放几次（浏览器可能拒绝首次自动播放） */
    maxAutoPlayAttempts: 4,
    /** 跳转后自动播放的宽限期（毫秒），期内反复重试 */
    playGraceMs: 6000,
    /** 宽限期内的重试间隔（毫秒） */
    playGraceIntervalMs: 1500,
    /** 新视频在开头这段时间因 2x 被暂停时，自动退回正常速度 */
    rateFallbackMaxCurrentTime: 15,
    /** 播放中途暂停/缓冲后的恢复观察期（毫秒） */
    stallRecoveryGraceMs: 15000,
    /** 暂停后稍等播放器状态稳定再恢复，避免 pause/play 同步递归 */
    stallRecoveryDelayMs: 800
  };

  /** 轮询兜底的间隔（毫秒） */
  const FINISH_WATCH_INTERVAL_MS = 800;
  /** 兜底判定需要连续成立几次才认账（防缓冲卡顿误判） */
  const FINISH_CONFIRM_TICKS = 2;

  const state = {
    /** @type {Map<HTMLVideoElement, object>} */
    byVideo: new Map(),
    /** @type {HTMLVideoElement|null} 当前跟踪的播放器 */
    active: null,
    /** 定时器集合，便于销毁 */
    timers: new Set(),
    /** 最近一次 ended 事件的时间戳（用于诊断面板还原现场） */
    lastEndedAt: 0,
    /** 结尾兜底轮询的定时器 */
    watchdogTimer: null,
    /** 跳转后自动播放重试的定时器 */
    playGraceTimer: null,
    /** 自动播放宽限期截止时间；用于识别“新视频开头因倍速限制被暂停” */
    playGraceUntil: 0
  };

  let options = { ...DEFAULT_OPTIONS };
  let handlers = {};
  let cyclesRun = 0;

  const isVideoElement = (node) =>
    typeof HTMLVideoElement !== 'undefined' && node instanceof HTMLVideoElement;

  function isEligible(video) {
    if (!isVideoElement(video)) return false;
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) return false;
    if (duration < options.minDuration) return false;
    return true;
  }

  function recordOf(video, { create = true } = {}) {
    let rec = state.byVideo.get(video);
    if (!rec && create) {
      rec = {
        played: 0,
        lastTime: 0,
        triggered: false,
        /** 判断 src 是否变化过，SPA 换集时同一个 <video> 会换源 */
        sourceKey: '',
        /** 自动播放尝试次数（允许重试，但有上限） */
        autoPlayAttempts: 0,
        /** 最近一次自动播放后累计推进量；稳定播放后重置尝试额度 */
        progressSinceAutoPlay: 0,
        /** 中途暂停恢复任务是否已排队，避免同一次暂停重复安排 */
        resumeScheduled: false,
        /** 暂停取证：最近一次被暂停的现场信息 */
        lastPause: null,
        /** “video detected” 只打印一次，避免 loadedmetadata / playing 重复刷屏 */
        detectedLogged: false,
        /** 诊断用：ended 是否真的被监听到、当时的有效播放量、以及没跳的原因 */
        endedBound: false,
        lastEndedAt: 0,
        lastEndedPlayed: 0,
        lastSkipReason: '',
        /** 诊断用：是不是靠轮询兜底（而非原生 ended）认出"播完了" */
        finishedByWatchdog: false,
        /** 这个视频是否真的开始播放过（兜底判定必须为 true 才允许） */
        everPlayed: false,
        /** 兜底判定连续成立的次数（缓冲卡顿会造成单次误判，需连续两次确认） */
        finishHits: 0
      };
      state.byVideo.set(video, rec);
    }
    return rec || null;
  }

  /** 统一的“发现可用播放器”处理：打印日志、应用倍速并启动自动播放窗口 */
  function markDetected(video, reason) {
    const rec = recordOf(video);
    const firstDetection = !rec.detectedLogged;
    if (firstDetection) {
      rec.detectedLogged = true;
      const sanitizedSrc = dom.sanitizeUrl ? dom.sanitizeUrl(video.currentSrc || '') : (video.currentSrc || '');
      AutoNext.log('video detected', `${Math.round(video.duration)}s`, video.currentSrc || '(无 src)',
        `| ${reason}`);
      if (AutoNext.addEvent) {
        AutoNext.addEvent('VIDEO_DETECTED', {
          duration: Math.round(video.duration || 0),
          src: sanitizedSrc,
          reason
        });
      }
    }
    state.active = video;
    // 自动倍速：检测到视频后立刻尝试一次（幂等，已是目标倍速时不会做任何事）
    rate.apply(video, 'detected');
    // iframe 重建后，loadedmetadata 可能早于 content script 注入；首次扫描就是唯一信号。
    // 因此发现一个新的、已就绪且暂停的视频时，直接启动有上限的自动播放窗口。
    if (firstDetection && AutoNext.settings.enabled && video.paused && !video.ended) {
      startPlayGrace('检测到新视频');
    }
  }

  function sourceKeyOf(video) {
    if (video.currentSrc || video.src) return video.currentSrc || video.src;
    const source = video.querySelector('source');
    return source ? source.src : '';
  }

  /**
   * preload=none 的播放器在第一次 play() 前可能一直没有 duration / readyState。
   * 只允许“尚未播过、仍在开头、已有媒体源”的新播放器走这条引导加载路径，
   * 避免把正常播放中的缓冲误当成新视频反复强播。
   */
  function canBootstrapUnready(video, rec) {
    const durationReady = Number.isFinite(video.duration) && video.duration > 0;
    return !durationReady
      && !rec.everPlayed
      && Number(video.currentTime || 0) <= 0.5
      && !!sourceKeyOf(video);
  }

  function isAtEnd(video, tolerance = options.endTolerance) {
    if (!Number.isFinite(video.duration) || video.duration <= 0) return false;
    if (video.ended) return true;
    return video.currentTime >= video.duration - tolerance;
  }

  function isLooping(video) {
    return video.loop === true || video.hasAttribute('loop');
  }

  /**
   * 兜底判定：视频其实已经播到结尾了。
   *
   * 为什么要这个？学习通等平台在视频末尾有自己的完成上报逻辑，
   * 常见做法是**在结尾处把视频暂停**，此时原生 ended 事件不一定会触发，
   * 只监听 ended 就会永远等下去。所以除了事件，还要看"状态"：
   * 暂停 + 播放位置已经在结尾 + 有效播放时长足够 → 认定这一节看完了。
   *
   * ⚠️ 这里的判断必须足够保守：**缓冲卡顿时也会出现"暂停 + 位置接近结尾"**，
   *    误判的后果是对正在播放的视频点"下一节"，表现为"视频播几秒就被打断"。
   *    因此额外要求：真的播放过、有足够数据（readyState ≥ 2）、播放时长够。
   */
  function looksFinished(video) {
    if (video.ended) return true;
    if (!video.paused) return false;
    if (video.seeking) return false;
    // 没有足够数据（正在缓冲/加载）时一律不判定为播完
    if (typeof video.readyState === 'number' && video.readyState < 2) return false;
    // 从没真正播放过的视频不能算"看完"（防止页面刚加载就被当成结束）
    const rec = recordOf(video, { create: false });
    if (rec && !rec.everPlayed) return false;
    return isAtEnd(video, options.finishTolerance);
  }

  // —— 事件处理 ————————————————————————————————————————————————

  function onPlaying(event) {
    const video = event.target;
    if (!isEligible(video)) return;
    const rec = recordOf(video);
    rec.everPlayed = true; // 真的播过了，兜底判定才有资格生效
    if (state.active !== video || !rec.detectedLogged) {
      markDetected(video, 'playing');
    }
    rec.lastTime = video.currentTime;
    rate.apply(video, 'play'); // 有些播放器会在 play 时把倍速重置回 1.0
    handlers.onVideoAvailable && handlers.onVideoAvailable(video);
  }

  function onTimeUpdate(event) {
    const video = event.target;
    const rec = recordOf(video, { create: false });
    if (!rec) return;
    const delta = video.currentTime - rec.lastTime;
    // 正常播放时 timeupdate 大约每 250ms 一次；只有明显跳变（拖进度条）才不计入有效播放
    if (delta > 0 && delta <= options.maxTrustedDelta) {
      rec.played += delta;
      rec.progressSinceAutoPlay += delta;
      // 已稳定推进一段时间，说明上一轮恢复成功；为后续真正的中途暂停恢复额度。
      if (rec.progressSinceAutoPlay >= options.minPlayedSeconds) {
        rec.autoPlayAttempts = 0;
        rec.progressSinceAutoPlay = 0;
      }
    }
    rec.lastTime = video.currentTime;
    rec.finishHits = 0; // 还在推进，说明没结束
  }

  function onSeeking(event) {
    const rec = recordOf(event.target, { create: false });
    if (rec) {
      rec.played = 0; // 用户手动拖动了进度，重新计时
      rec.progressSinceAutoPlay = 0;
      rec.finishHits = 0;
    }
  }

  /**
   * 暂停处理：留下现场记录，并在安全条件满足时安排有上限的恢复。
   *
   * 用途：区分"平台/播放器把视频暂停了"和"我们自己的逻辑误伤"，
   * 同时让自动连播能从可见页面上的意外暂停或缓冲恢复。
   */
  function onPause(event) {
    const video = event.target;
    if (!isEligible(video)) return;
    const rec = recordOf(video, { create: false });
    // 正常结束（ended）和被我们主动暂停的情况不算异常
    if (video.ended) return;

    const pausedAt = Number(video.currentTime.toFixed(1));
    const duration = Number.isFinite(video.duration) ? Number(video.duration.toFixed(1)) : null;
    const nearEnd = duration !== null && pausedAt >= duration - options.finishTolerance;

    rec.lastPause = {
      at: Date.now(),
      currentTime: pausedAt,
      duration,
      nearEnd,
      playedSeconds: rec ? Number(rec.played.toFixed(1)) : 0,
      playbackRate: video.playbackRate,
      // 页面是否被切走 / 最小化：学习通的反作弊会在切走时暂停视频
      pageHidden: document.hidden,
      visibilityState: document.visibilityState,
      hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : null,
      readyState: video.readyState,
      networkState: video.networkState,
      // 我们自己的流程是否正在跑（用来排除"是我们点的下一节"）
      cycleRunning: cycle.running,
      cycleNavigated: cycle.navigated
    };

    if (AutoNext.addEvent) {
      AutoNext.addEvent('VIDEO_PAUSED', {
        currentTime: pausedAt,
        duration,
        nearEnd,
        playedSeconds: rec ? Number(rec.played.toFixed(1)) : 0,
        pageHidden: document.hidden
      });
    }

    // 某些课程明确要求“任务点完成前不可倍速”：播放器会先响应 play，随后立即 pause。
    // 只在新视频的短宽限期、页面可见、数据已就绪且仍在开头时回退当前源到 1x。
    const inPlayGrace = Date.now() < state.playGraceUntil;
    const rateRestrictedPattern = inPlayGrace
      && !document.hidden
      && !nearEnd
      && !video.seeking
      && (typeof video.readyState !== 'number' || video.readyState >= 2)
      && pausedAt <= options.rateFallbackMaxCurrentTime
      && video.playbackRate > 1.01;
    if (rateRestrictedPattern && rate.fallbackToNormal(video, '新视频开头被平台暂停')) {
      AutoNext.warn('自动播放与课程倍速限制冲突，已对当前视频停用二倍速并恢复播放');
      schedule(() => {
        if (AutoNext.settings.enabled && video.paused && !document.hidden) {
          tryAutoPlay(video, '回退 1.0x 后重试');
        }
      }, 100);
      return;
    }

    // 自动连播模式下，平台或播放器可能在任意位置暂停（真实现场见 43s / 116s）。
    // 先延迟一次，让缓冲/播放器内部状态稳定；真正播放仍由有上限的重试窗口接手。
    const shouldRecoverMidPlayback = AutoNext.settings.enabled
      && rec.everPlayed
      && !document.hidden
      && !nearEnd
      && !video.seeking
      && !cycle.running
      && !cycle.navigated;
    if (shouldRecoverMidPlayback && !rec.resumeScheduled) {
      rec.resumeScheduled = true;
      AutoNext.warn('检测到视频中途暂停，将在播放器状态稳定后尝试恢复');
      schedule(() => {
        rec.resumeScheduled = false;
        if (!AutoNext.settings.enabled || document.hidden || !video.paused || video.ended || video.seeking) return;
        if (isAtEnd(video, options.finishTolerance)) return;
        startPlayGrace('视频中途暂停恢复', options.stallRecoveryGraceMs);
      }, options.stallRecoveryDelayMs);
    }

    if (nearEnd) {
      AutoNext.debug('视频在结尾附近暂停（可能是平台完成上报，兜底检测会接手）', `${pausedAt}s`);
      return;
    }

    // 中途暂停是异常信号，明确记下来
    AutoNext.warn('视频在播放中途被暂停',
      `位置 ${pausedAt}s / ${duration}s`,
      `有效播放 ${rec ? rec.played.toFixed(1) : 0}s`,
      `倍速 ${video.playbackRate}`,
      `页面可见=${!document.hidden}(${document.visibilityState})`,
      `readyState=${video.readyState}`,
      `我方流程运行中=${cycle.running}`);
    AutoNext.warn('如果这不是你自己按的暂停，请把这行连同上面的现场信息一起反馈');
  }

  function onEnded(event) {
    const video = event.target;
    if (!isEligible(video)) return;

    const rec = recordOf(video);
    state.lastEndedAt = Date.now();
    rec.lastEndedAt = state.lastEndedAt;
    rec.lastEndedPlayed = rec.played;

    AutoNext.log('video ended', `${Math.round(video.duration)}s`);
    if (AutoNext.addEvent) {
      AutoNext.addEvent('VIDEO_ENDED', {
        duration: Math.round(video.duration || 0),
        played: Number(rec.played.toFixed(1))
      });
    }
    AutoNext.debug('结束时的播放统计：', {
      currentTime: Number(video.currentTime.toFixed(2)),
      duration: Number(video.duration.toFixed(2)),
      played: Number(rec.played.toFixed(1))
    });

    // 循环播放不触发跳转（否则会无限跳）
    if (isLooping(video)) {
      rec.lastSkipReason = '视频设置了 loop';
      AutoNext.warn('视频设置了 loop，跳过自动跳转');
      return;
    }
    // 关键安全判定：确认是“自然播放到结尾”，而不是 seek 到末尾等异常情况
    if (!isAtEnd(video)) {
      rec.lastSkipReason = '播放位置不在结尾（判定为非自然结束）';
      AutoNext.warn('ended 事件触发但播放位置不在结尾，判定为非自然结束，忽略');
      return;
    }
    if (rec.played < options.minPlayedSeconds) {
      rec.lastSkipReason = `有效播放时长仅 ${rec.played.toFixed(1)}s，不足 ${options.minPlayedSeconds}s`;
      AutoNext.warn(`有效播放时长仅 ${rec.played.toFixed(1)}s，不足 ${options.minPlayedSeconds}s，忽略`);
      return;
    }
    triggerNextLesson('video ended');
  }

  function onSourceMutated(video) {
    const rec = recordOf(video, { create: false });
    const key = sourceKeyOf(video);
    if (rec && rec.sourceKey && key !== rec.sourceKey) {
      AutoNext.debug('检测到播放器换源，重置上一轮状态');
      resetCycle({ keepSource: false });
    }
    if (rec) {
      rec.autoPlayAttempts = 0; // 换源后重新允许自动播放
      rec.progressSinceAutoPlay = 0;
      rec.resumeScheduled = false;
      rec.lastPause = null;
      rec.detectedLogged = false; // 换源等于换了一节，重新打印一次 detected
    }
    // 换源后播放器常常把倍速重置回 1.0，这里补一次（后续 loadedmetadata / play 还会再补）
    rate.apply(video, '换源后');
    handlers.onVideoAvailable && handlers.onVideoAvailable(video);
  }

  // —— 监听注册 ————————————————————————————————————————————————

  function attach(video) {
    if (!isVideoElement(video) || video.dataset.autoNextBound === '1') return;
    video.dataset.autoNextBound = '1';

    video.addEventListener('loadedmetadata', onPlaying);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('play', onPlaying); // 兜底判定需要知道"真的开始播过"
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('seeking', onSeeking);
    video.addEventListener('ended', onEnded);
    video.addEventListener('pause', onPause); // 暂停取证
    video.addEventListener('emptied', () => onSourceMutated(video));

    // 自动二倍速自己管理 ratechange / loadedmetadata / play 的倍速纠正
    rate.bind(video);

    const rec = recordOf(video);
    rec.sourceKey = sourceKeyOf(video);
    rec.endedBound = true; // 诊断用：确认 ended 监听确实挂上了

    if (isEligible(video)) {
      markDetected(video, '首次发现');
    } else {
      AutoNext.debug('发现 <video>，但时长不足或元数据未就绪，暂不跟踪');
      const canStartLoading = AutoNext.settings.enabled
        && video.paused
        && !video.ended
        && canBootstrapUnready(video, rec);
      if (canStartLoading) {
        state.active = video;
        startPlayGrace('发现待加载的新视频');
      }
    }

    // 元数据到达后重新判断一次（首次扫描时 duration 往往还是 NaN）
    video.addEventListener('loadedmetadata', () => {
      if (isEligible(video)) markDetected(video, 'loadedmetadata');
    }, { once: true });
  }

  function scan() {
    let count = 0;
    const list = (dom && typeof dom.findVideos === 'function')
      ? dom.findVideos(document)
      : Array.from(document.querySelectorAll('video'));
    list.forEach((video) => {
      attach(video);
      count += 1;
    });
    AutoNext.debug(`扫描完成，页面内 <video> 数量：${count}`);
    const eligible = Array.from(state.byVideo.keys()).filter(isEligible);
    if (eligible.length && state.active !== eligible[0]) state.active = eligible[0];
    // 每次扫描（首次加载 / SPA 换页 / 跳转下一节后 / MutationObserver 触发）都补一次倍速
    rate.applyAll('scan');
    return eligible;
  }

  /**
   * 自动点播放。
   *
   * ⚠️ 这里必须允许**重试**：浏览器首次自动播放可能被策略拒绝
   * （尤其在学习通 iframe 里、或跳转后还没拿到用户手势），
   * 一旦只试一次，视频就会永久卡在暂停状态 —— 表现为"视频播到一半停住不动"。
   * 所以用尝试次数计数，而不是"试过就不再试"。
   */
  function tryAutoPlay(video, reason) {
    if (!isVideoElement(video) || !video.paused) return false;
    const rec = recordOf(video);
    const durationReady = Number.isFinite(video.duration) && video.duration > 0;
    const bootstrapUnready = canBootstrapUnready(video, rec);
    if (durationReady && video.duration < options.minDuration) return false;
    if (!durationReady && !bootstrapUnready) return false;
    // 已结束、正在拖动或停在结尾附近时不能重播上一节。
    // SPA 换页期间旧播放器可能仍留在 DOM 中，误播它会与新播放器争抢状态。
    if (video.ended || video.seeking || isAtEnd(video, options.finishTolerance)) return false;
    // 缓冲中（HAVE_METADATA / HAVE_NOTHING）先等数据恢复，由宽限期的下一轮再试。
    if (typeof video.readyState === 'number' && video.readyState < 2 && !bootstrapUnready) return false;
    if (rec.autoPlayAttempts >= options.maxAutoPlayAttempts) return false;

    rec.autoPlayAttempts += 1;
    rec.progressSinceAutoPlay = 0;
    rate.apply(video, '自动播放前'); // 先设好倍速再播，避免开头几秒按 1.0 播放
    AutoNext.log('auto play', `尝试自动播放（第 ${rec.autoPlayAttempts} 次）`, reason || '');

    let result;
    try {
      result = video.play();
    } catch (err) {
      AutoNext.warn('调用播放失败：', err && err.message);
      return false;
    }
    if (result && typeof result.catch === 'function') {
      result.catch((err) => {
        AutoNext.warn('自动播放被浏览器拦截，稍后会自动重试：', err && err.name);
        toast.show('自动播放被拦截，正在重试', 'warn');
      });
    }
    return true;
  }

  /**
   * 跳转之后的宽限期重试。
   *
   * 有些情况下新播放器是"晚一点"才出现的，或者第一次 play() 落空
   * （元素刚创建、元数据还没就绪），也可能先播放成功、随后又被平台暂停。
   * 所以完整保留一小段宽限期：播放中只观察，暂停时才重试；到期立即停手，
   * 不会长期和平台或用户抢控制权。
   */
  function startPlayGrace(reason, graceMs = options.playGraceMs) {
    stopPlayGrace();
    const startedAt = Date.now();
    state.playGraceUntil = startedAt + graceMs;
    const tick = () => {
      if (!AutoNext.settings.enabled) return stopPlayGrace();
      const elapsed = Date.now() - startedAt;
      if (elapsed >= graceMs) return stopPlayGrace();
      const video = state.active || Array.from(state.byVideo.keys())[0] || null;
      // 后台标签页常被平台主动暂停；不在后台强行恢复，以免绕过平台的可见性规则。
      if (document.hidden) return;
      // 播放中保持安静但不提前撤掉守护，这样能接住稍后发生的异常暂停。
      if (video && video.paused) {
        tryAutoPlay(video, `跳转后重试(${Math.round(elapsed / 1000)}s)`);
      }
    };
    tick();
    state.playGraceTimer = setInterval(tick, options.playGraceIntervalMs);
  }

  function stopPlayGrace() {
    state.playGraceUntil = 0;
    if (state.playGraceTimer === null) return;
    clearInterval(state.playGraceTimer);
    state.playGraceTimer = null;
  }

  // —— 跳转流程 ————————————————————————————————————————————————

  const NEXT_ATTEMPT_INTERVAL = 1200;
  const MAX_NEXT_ATTEMPTS = 5;
  /** 向其他 frame 请求协助后，等回音的宽限期 */
  const HANDOFF_GRACE_MS = 2500;
  /** 发出协助请求后，最多重试几次（防止消息丢失导致彻底卡死） */
  const MAX_HANDOFF_RETRIES = 3;

  const cycle = {
    running: false,
    attempts: 0,
    navigated: false,
    /** 上一次向父级 frame 发出协助请求的时间 */
    handoffAt: 0,
    /** 诊断用：发出了几次协助请求、投递到了几个 frame */
    handoffCount: 0,
    handoffDelivered: 0,
    lastEndedAt: 0
  };

  function resetCycle({ keepSource = true } = {}) {
    cycle.running = false;
    cycle.attempts = 0;
    cycle.navigated = false;
    cycle.handoffAt = 0;
    cycle.handoffCount = 0;
    cycle.handoffDelivered = 0;
    if (!keepSource) {
      const video = state.active;
      const rec = video ? recordOf(video, { create: false }) : null;
      if (rec) {
        rec.triggered = false;
        rec.autoPlayAttempts = 0;
        rec.progressSinceAutoPlay = 0;
        rec.resumeScheduled = false;
        rec.played = 0;
        rec.lastPause = null;
        rec.sourceKey = video ? sourceKeyOf(video) : '';
      }
    }
  }

  function anyFrameNavigated() {
    return cycle.navigated || messenger.recentlyNavigated();
  }

  function findButtonAndClick() {
    const customSel = AutoNext.settings ? AutoNext.settings.customNextSelector : '';
    const btn = AutoNext.buttonFinder.clickNextButton(40, customSel);
    if (!btn) return false;
    cycle.navigated = true;
    messenger.reportNavigated(); // 只有真的点下去了才广播，别的 frame 才不会重复点
    messenger.setBadge('→', '#16a34a'); // 图标上显示"已跳转"
    toast.show('已跳转下一节', 'success');
    if (AutoNext.addEvent) {
      const btnText = (dom && dom.ownTextOf ? dom.ownTextOf(btn) : '') || btn.textContent || btn.tagName;
      AutoNext.addEvent('NAVIGATED', { button: String(btnText).slice(0, 40) });
    }
    return true;
  }

  /**
   * 交接给其他 frame 之后的回音检查。
   * 如果既没有 frame 报告"已跳转"，也没有人接手，就自己再发起一轮，
   * 避免一条消息丢失就彻底卡死。
   */
  function checkHandoffResult() {
    if (!AutoNext.settings.enabled) return;
    if (cycle.navigated || messenger.recentlyNavigated()) {
      AutoNext.debug('交接成功：其他 frame 已完成跳转');
      return;
    }
    const video = state.active;
    if (!video || !looksFinished(video)) {
      AutoNext.debug('交接后视频状态已变化，不再重试');
      return;
    }
    if (cycle.handoffCount >= MAX_HANDOFF_RETRIES) {
      AutoNext.warn(
        `已向其他 frame 发出 ${cycle.handoffCount} 次“帮忙找下一节”请求但没有回音。`,
        '这通常说明“下一节”按钮所在的页面层拿不到这条消息，请把这条日志反馈给插件作者。'
      );
      messenger.setBadge('!', '#dc2626');
      return;
    }
    AutoNext.warn(`其他 frame 没有响应，重试交接（第 ${cycle.handoffCount + 1} 次）`);
    // 直接重跑查找流程：先本地再交接，绕过节流但保留所有安全判定
    cycle.running = true;
    cycle.attempts = 0;
    schedule(attemptNext, 500);
  }

  /** 点击“下一节”后都会走到这里：等新播放器加载出来，补一次倍速 + 必要时自动播放 */
  function afterNavigation() {
    cycle.running = false;
    AutoNext.debug('本轮跳转流程结束，等待下一节播放器加载');
    schedule(() => {
      scan();
      // 用宽限期重试自动播放：新播放器可能晚一点才出现，
      // 或者第一次 play() 因为元数据没就绪而落空 —— 只试一次会导致视频永久卡在暂停
      startPlayGrace('跳转到下一节之后');
      rate.applyAll('下一节'); // 下一节播放器可能刚创建，或把倍速重置回了 1.0
      // 如果下一节根本不是视频（测验/讨论/空白任务点），交给跳过控制器继续往后走
      if (skip && skip.onPageSettled) skip.onPageSettled('视频结束跳转之后');
    }, 2500);
  }

  /**
   * 尝试跳转下一节：先在**本 frame** 找按钮，找不到就请父级 frame 帮忙找。
   * 这样无论播放器和按钮谁在 iframe 里都能覆盖。
   */
  function attemptNext() {
    if (cycle.navigated) {
      AutoNext.debug('本 frame 已完成跳转，结束流程');
      finishCycle();
      return;
    }

    if (messenger.recentlyNavigated()) {
      AutoNext.debug('其他 frame 已完成跳转，本次跳过');
      finishCycle();
      return;
    }

    if (findButtonAndClick()) {
      finishCycle();
      return;
    }
    cycle.attempts += 1;

    // 本 frame 没有按钮 → 请求其他 frame 帮忙找（只请求一次）。
    // 注意：postMessage 只能发给直接父/子级，而播放器的嵌套层级不固定，
    // 所以用 requestHelp() 父子双发 + 逐级中继，保证请求能爬到有按钮的那一层。
    if (!messenger.isTop && cycle.attempts === 1) {
      AutoNext.debug('本 frame 未找到按钮，请求其他 frame 查找');
      cycle.handoffAt = Date.now();
      cycle.handoffCount += 1;
      cycle.handoffDelivered = messenger.requestHelp ? messenger.requestHelp() : 0;
      if (!cycle.handoffDelivered) {
        AutoNext.warn('没能把请求发给任何其他 frame，跨 frame 协调不可用');
      }
      cycle.running = false;
      // 等一段时间看有没有回音；没人接手就自己再试一轮
      schedule(checkHandoffResult, HANDOFF_GRACE_MS + 1200);
      return;
    }

    if (cycle.attempts >= MAX_NEXT_ATTEMPTS) {
      AutoNext.warn('next lesson not found：多次尝试后仍未找到“下一节 / 下一个任务点”，已停止（不做任何操作）');
      toast.show('未找到下一节按钮，已停止自动跳转', 'warn');
      cycle.running = false;
      return;
    }
    schedule(attemptNext, NEXT_ATTEMPT_INTERVAL);
  }

  function finishCycle() {
    afterNavigation();
  }

  /** 视频自然结束后的统一入口 */
  function triggerNextLesson(reason) {
    if (!AutoNext.settings.enabled) {
      AutoNext.log('视频已结束，但自动连播开关是关闭的，未做任何操作');
      return;
    }
    if (cycle.running) {
      AutoNext.debug('已有跳转流程在进行中，忽略重复触发');
      return;
    }
    if (anyFrameNavigated()) {
      AutoNext.debug('刚刚已经跳转过，忽略（防连跳）');
      return;
    }
    const now = Date.now();
    if (now - cycle.lastEndedAt < 3000) {
      AutoNext.debug('3 秒内重复的 ended 事件，忽略');
      return;
    }
    const video = state.active;
    cycle.lastEndedAt = now;
    cycle.running = true;
    cycle.attempts = 0;
    AutoNext.log('视频已播完，开始跳转', `(${reason})`);
    if (AutoNext.addEvent) {
      AutoNext.addEvent('NAVIGATION_TRIGGERED', { reason: reason || '' });
    }

    schedule(attemptNext, 800);
  }

  /**
   * 轮询兜底：只监听 ended 会漏掉"平台在结尾自己暂停、但没触发 ended"的情况。
   * 这个检查很轻（只读属性），而且所有防重复逻辑都靠 cycle 的时间戳，
   * 所以真实 ended 事件仍然优先，不会重复跳转。
   */
  function startWatchdog() {
    if (state.watchdogTimer) return;
    state.watchdogTimer = setInterval(() => {
      if (!AutoNext.settings.enabled) return;
      if (cycle.running || cycle.navigated) return;
      const video = state.active;
      if (!video || !isEligible(video)) return;
      const rec = recordOf(video, { create: false });
      if (!rec || rec.endedBound !== true) return;
      if (!looksFinished(video)) {
        rec.finishHits = 0;
        return;
      }
      if (isLooping(video)) return;
      // 缓冲卡顿也会出现"暂停 + 接近结尾"，要求连续两次（约 1.6 秒）都成立才算数
      rec.finishHits += 1;
      if (rec.finishHits < FINISH_CONFIRM_TICKS) {
        AutoNext.debug(`疑似播完，等待确认（${rec.finishHits}/${FINISH_CONFIRM_TICKS}）`);
        return;
      }
      if (video.ended && rec.lastEndedAt) return; // 原生 ended 已经处理过了
      if (Date.now() - cycle.lastEndedAt < 3000) return; // 刚处理过

      // 和 ended 路径同样的安全判定：拖到结尾不算看完，直接不处理
      if (rec.played < options.minPlayedSeconds) {
        rec.lastSkipReason = `有效播放时长仅 ${rec.played.toFixed(1)}s，不足 ${options.minPlayedSeconds}s`;
        AutoNext.warn(`结尾兜底：${rec.lastSkipReason}，忽略`);
        return;
      }

      rec.finishedByWatchdog = true;
      triggerNextLesson('检测到已播到结尾（未触发 ended 事件）');
    }, FINISH_WATCH_INTERVAL_MS);
    AutoNext.debug(`结尾兜底检测已启动（每 ${FINISH_WATCH_INTERVAL_MS}ms）`);
  }

  function stopWatchdog() {
    if (!state.watchdogTimer) return;
    clearInterval(state.watchdogTimer);
    state.watchdogTimer = null;
    AutoNext.debug('结尾兜底检测已停止');
  }

  /** 定时器统一登记，页面卸载时可以全部清掉 */
  function schedule(fn, ms) {
    const timer = setTimeout(() => {
      state.timers.delete(timer);
      try {
        fn();
      } catch (err) {
        AutoNext.error('定时任务异常：', err);
      }
    }, ms);
    state.timers.add(timer);
    return timer;
  }

  function destroy() {
    for (const timer of state.timers) clearTimeout(timer);
    state.timers.clear();
    if (state.watchdogTimer) clearInterval(state.watchdogTimer);
    state.watchdogTimer = null;
    stopPlayGrace();
    state.byVideo.clear();
    state.active = null;
  }

  /** 供 popup 诊断面板还原“跳转那一刻”的现场 */
  function diagnostics() {
    const video = state.active || Array.from(state.byVideo.keys())[0] || null;
    const rec = video ? recordOf(video, { create: false }) : null;
    const events = AutoNext.getEvents ? AutoNext.getEvents() : [];
    const customSelector = AutoNext.settings ? AutoNext.settings.customNextSelector : '';
    const pageUrl = dom.sanitizeUrl ? dom.sanitizeUrl(location.href) : location.href;
    const currentSrc = video ? (dom.sanitizeUrl ? dom.sanitizeUrl(sourceKeyOf(video)) : sourceKeyOf(video)) : '';
    if (!video || !rec) {
      return {
        hasVideo: false,
        pageUrl,
        currentSrc,
        cycle: { ...cycle },
        lastEndedAt: state.lastEndedAt,
        events,
        customSelector
      };
    }
    return {
      hasVideo: true,
      pageUrl,
      currentSrc,
      endedBound: rec.endedBound === true,
      endedEverFired: rec.lastEndedAt > 0,
      finishedByWatchdog: rec.finishedByWatchdog === true,
      autoPlayAttempts: rec.autoPlayAttempts,
      progressSinceAutoPlay: Number(rec.progressSinceAutoPlay.toFixed(1)),
      resumeScheduled: rec.resumeScheduled === true,
      lastPause: rec.lastPause || null,
      everPlayed: rec.everPlayed === true,
      finishHits: rec.finishHits,
      lastEndedAgoMs: rec.lastEndedAt ? Date.now() - rec.lastEndedAt : null,
      playedSeconds: Number(rec.played.toFixed(1)),
      lastEndedPlayed: Number((rec.lastEndedPlayed || 0).toFixed(1)),
      triggered: rec.triggered === true,
      lastSkipReason: rec.lastSkipReason || '',
      currentTime: Number(video.currentTime.toFixed(1)),
      duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(1)) : null,
      paused: video.paused,
      ended: video.ended,
      messengerStats: messenger.stats ? { ...messenger.stats } : null,
      cycle: { ...cycle },
      events,
      customSelector
    };
  }

  function stats() {
    const videos = Array.from(state.byVideo.keys());
    const rates = rate.snapshot ? rate.snapshot() : [];
    const sanitizedUrl = dom.sanitizeUrl ? dom.sanitizeUrl(location.href) : location.href;
    const effectiveTargetRate = (AutoNext.settings && AutoNext.settings.playbackRate) || (rate.options && rate.options.targetRate) || 2.0;
    return {
      frame: messenger.isTop ? 'top' : 'iframe',
      url: sanitizedUrl,
      rawUrl: location.href,
      cyclesRun,
      autoNext: !!AutoNext.settings.enabled,
      autoRate: !!(AutoNext.settings && (AutoNext.settings.autoRate || AutoNext.settings.autoRate2x)),
      autoRate2x: rate.isEnabled ? rate.isEnabled() : false,
      playbackRate: effectiveTargetRate,
      customSelector: (AutoNext.settings && AutoNext.settings.customNextSelector) || '',
      hasSiteOverride: !!(AutoNext.settings && AutoNext.settings.hasSiteOverride),
      active: state.active ? {
        duration: state.active.duration,
        paused: state.active.paused,
        src: dom.sanitizeUrl ? dom.sanitizeUrl(sourceKeyOf(state.active)) : sourceKeyOf(state.active)
      } : null,
      videos: videos.map((video, index) => ({
        duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(1)) : null,
        paused: video.paused,
        currentTime: Number(video.currentTime.toFixed(1)),
        playbackRate: video.playbackRate,
        src: dom.sanitizeUrl ? dom.sanitizeUrl(sourceKeyOf(video)) : sourceKeyOf(video)
      })),
      rates,
      diagnostics: diagnostics(),
      cycle: { ...cycle }
    };
  }

  AutoNext.videoHandler = {
    scan,
    destroy,
    stats,
    diagnostics,
    startWatchdog,
    stopWatchdog,
    startPlayGrace,
    stopPlayGrace,
    tryAutoPlay,
    triggerNextLesson,
    attemptNext,
    markDetected,
    resetCycle: () => resetCycle({ keepSource: false }),
    configure(opts) {
      options = { ...options, ...opts };
    },
    setHandlers(next) {
      handlers = next || {};
    },
    get activeVideo() {
      return state.active;
    },
    countEndedCycles() {
      cyclesRun += 1;
    }
  };

})();
