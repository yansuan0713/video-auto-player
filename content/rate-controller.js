/**
 * rate-controller.js —— 自动二倍速
 *
 * 只做一件事：把 HTML5 <video> 的 playbackRate 设为 2.0，并在页面把它改回去时重新设回来。
 *
 * 合规边界：只修改浏览器播放器自身的 playbackRate 属性。
 * 不改 duration、不跳进度、不碰任何课程平台接口、不伪造完成状态。
 * 视频仍然按真实时间完整播放（2 倍速 = 用一半时间看完同样内容）。
 */
(function () {
  'use strict';

  const AutoNext = window.AutoNext;

  const DEFAULT_OPTIONS = {
    /** 目标倍速 */
    targetRate: 2.0,
    /** 浮点比较容差：差值小于这个值就认为"已经是 2 倍速" */
    epsilon: 0.01,
    /** 同一个视频两次纠正之间的最小间隔，避免与页面互抢导致死循环 */
    minReapplyInterval: 300
  };

  let options = { ...DEFAULT_OPTIONS };

  /** @type {WeakMap<HTMLVideoElement, object>} */
  const records = new WeakMap();

  /** 当前是否应该强制二倍速 */
  function isEnabled() {
    const settings = AutoNext.settings;
    return !!(settings && settings.autoRate2x);
  }

  /** 差值大于容差才算"不是 2 倍速"——这是避免事件死循环的关键判断 */
  function needsChange(video, target) {
    return Math.abs(video.playbackRate - target) > options.epsilon;
  }

  function createRecord() {
    return {
      lastAppliedAt: 0,
      /** 由插件自己触发的 setRate 期间置为 true，供 ratechange 回调识别 */
      applying: false,
      bound: false,
      /** 被限频推迟的恢复任务（而不是丢掉这次恢复） */
      retryTimer: null,
      /** 当前视频源被平台判定为不允许倍速后，暂停对该源强制 2x */
      suspendedSourceKey: '',
      fallbackCount: 0
    };
  }

  function sourceKeyOf(video) {
    return video.currentSrc || video.src || '(无源)';
  }

  function isSuspendedForCurrentSource(video, rec) {
    if (!rec || !rec.suspendedSourceKey) return false;
    const current = sourceKeyOf(video);
    if (rec.suspendedSourceKey !== current) {
      rec.suspendedSourceKey = '';
      return false;
    }
    return true;
  }

  function clearRetry(rec) {
    if (rec && rec.retryTimer) {
      clearTimeout(rec.retryTimer);
      rec.retryTimer = null;
    }
  }

  /**
   * 把视频设为 2 倍速。
   * @returns {boolean} 是否真的改动了
   */
  function setRate(video, reason) {
    const target = options.targetRate;
    const rec = records.get(video);
    if (isSuspendedForCurrentSource(video, rec)) return false;
    if (!needsChange(video, target)) return false; // ★ 已经是 2 倍速，直接返回，不会触发新的 ratechange

    clearRetry(rec);
    if (rec) rec.applying = true;
    try {
      video.playbackRate = target;
    } catch (err) {
      AutoNext.warn('设置倍速失败：', err && err.message);
      return false;
    } finally {
      if (rec) rec.applying = false;
    }

    // 个别播放器（如某些 HLS 封装）会忽略 playbackRate 赋值，用 defaultPlaybackRate 兜底
    if (needsChange(video, target)) {
      try {
        video.defaultPlaybackRate = target;
      } catch (_) { /* 忽略 */ }
    }

    if (rec) rec.lastAppliedAt = Date.now();
    AutoNext.log('playback rate -> 2x', reason || '', `rate=${video.playbackRate}`);
    return true;
  }

  /** 页面把倍速改回去了 —— 只有开启开关时才纠正 */
  function onRateChange(event) {
    const video = event.target;
    if (!isEnabled()) return;
    const rec = records.get(video);
    if (rec && rec.applying) return; // 是我们自己设的，不必响应
    if (isSuspendedForCurrentSource(video, rec)) return; // 当前源已因平台限制回退到 1x
    if (!needsChange(video, options.targetRate)) return; // 已经是 2 倍速

    const now = Date.now();
    const waited = rec ? now - rec.lastAppliedAt : Infinity;
    if (waited < options.minReapplyInterval) {
      // 页面几乎紧跟着我们改动（防互抢）：不丢弃，而是排到限频窗口结束后再恢复
      const delay = options.minReapplyInterval - waited;
      AutoNext.debug(`倍速再次被改动，${delay}ms 后恢复`);
      if (rec) {
        clearRetry(rec);
        rec.retryTimer = setTimeout(() => {
          rec.retryTimer = null;
          if (isEnabled() && needsChange(video, options.targetRate)) setRate(video, '(限频后恢复)');
        }, delay);
      }
      return;
    }

    AutoNext.debug('检测到倍速被页面改动，恢复 2 倍速');
    setRate(video, '(页面改动后恢复)');
  }

  /** 绑定一次事件即可；后续任何时刻都靠 setRate 幂等生效 */
  function bind(video) {
    let rec = records.get(video);
    if (!rec) {
      rec = createRecord();
      records.set(video, rec);
    }
    if (rec.bound) return rec;
    rec.bound = true;

    video.addEventListener('loadedmetadata', () => apply(video, 'loadedmetadata'));
    video.addEventListener('play', () => apply(video, 'play'));
    video.addEventListener('ratechange', onRateChange);
    video.addEventListener('emptied', () => {
      // 换源后播放器常常重置回 1.0，交给后续的 loadedmetadata / play 再设一次
      rec.lastAppliedAt = 0;
      rec.suspendedSourceKey = '';
    });
    return rec;
  }

  /**
   * 平台在新视频开头因倍速限制而暂停时，对当前视频源回退到正常速度。
   * 只暂停这个源的自动二倍速；换源后会重新尝试，不影响后续允许倍速的视频。
   */
  function fallbackToNormal(video, reason) {
    if (!video || typeof video.playbackRate !== 'number' || !isEnabled()) return false;
    const rec = bind(video);
    if (video.playbackRate <= 1 + options.epsilon && isSuspendedForCurrentSource(video, rec)) return false;

    clearRetry(rec);
    rec.suspendedSourceKey = sourceKeyOf(video);
    rec.applying = true;
    try {
      video.playbackRate = 1;
      video.defaultPlaybackRate = 1;
    } catch (err) {
      rec.suspendedSourceKey = '';
      AutoNext.warn('回退正常倍速失败：', err && err.message);
      return false;
    } finally {
      rec.applying = false;
    }
    rec.lastAppliedAt = 0;
    rec.fallbackCount += 1;
    AutoNext.warn('检测到当前视频可能禁止倍速，已回退到 1.0x', reason || '');
    return true;
  }

  /**
   * 对单个视频应用倍速（幂等，可重复调用）
   * @param {HTMLVideoElement} video
   * @param {string} [reason] 日志里标注触发来源：detected / loadedmetadata / play / …
   */
  function apply(video, reason) {
    if (!video || typeof video.playbackRate !== 'number') return false;
    bind(video);
    if (!isEnabled()) return false;
    return setRate(video, reason);
  }

  /** 对当前页面**所有** video 应用一次（首个 video 找不到时兜底用） */
  function applyAll(reason) {
    if (!isEnabled()) return 0;
    const videos = Array.from(document.querySelectorAll('video'));
    let count = 0;
    for (const video of videos) {
      if (apply(video, reason)) count += 1;
    }
    // 页面里暂时还没有 <video>（播放器是点开才创建的），交给 MutationObserver 后再试
    if (videos.length === 0) {
      AutoNext.debug('页面暂未发现 <video>，倍速将在播放器出现后生效');
    }
    return count;
  }

  /** 开关切换时调用：打开立刻生效，关闭把已改的恢复成 1.0 */
  function onToggle(enabled) {
    if (enabled) {
      const changed = applyAll('(开关已开启)');
      AutoNext.log('自动二倍速已开启', changed ? `已应用到 ${changed} 个播放器` : '等待播放器出现');
      return;
    }
    const videos = Array.from(document.querySelectorAll('video'));
    let restored = 0;
    for (const video of videos) {
      const rec = records.get(video);
      clearRetry(rec); // 取消还没执行的恢复任务，否则关掉开关后又被改回 2.0
      if (Math.abs(video.playbackRate - 1) <= options.epsilon) continue;
      try {
        video.playbackRate = 1;
        restored += 1;
      } catch (_) { /* 忽略 */ }
    }
    AutoNext.log('自动二倍速已关闭', restored ? `已把 ${restored} 个播放器恢复为 1.0x` : '');
  }

  AutoNext.rateController = {
    apply,
    applyAll,
    bind,
    fallbackToNormal,
    onToggle,
    isEnabled,
    /** 当前页面各播放器的倍速，供 __AUTO_NEXT__.stats() 展示 */
    snapshot() {
      return Array.from(document.querySelectorAll('video')).map((video) => ({
        rateSuspended: isSuspendedForCurrentSource(video, records.get(video)),
        fallbackCount: (records.get(video) && records.get(video).fallbackCount) || 0,
        rate: video.playbackRate,
        defaultRate: video.defaultPlaybackRate,
        paused: video.paused
      }));
    },
    configure(opts) {
      options = { ...options, ...opts };
      return { ...options };
    },
    get options() {
      return { ...options };
    }
  };

})();
