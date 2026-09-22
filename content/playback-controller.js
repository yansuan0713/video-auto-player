/**
 * Owns pending play requests and temporary mute state.
 * One request per video/source; invalidate before source changes or teardown.
 * Does not decide when playback is appropriate (video-handler owns that policy).
 */
(function () {
  'use strict';
  const AutoNext = window.AutoNext;

  /**
   * @param {{sourceKey: function(HTMLVideoElement): string,
   *   canContinue: function(HTMLVideoElement): boolean}} dependencies
   * @returns {{play: function(HTMLVideoElement): boolean,
   *   pending: function(HTMLVideoElement): boolean,
   *   cancel: function(HTMLVideoElement): void, destroy: function(): void}}
   */
  AutoNext.createPlaybackController = function ({ sourceKey, canContinue }) {
    const requests = new Map();
    const audio = new Map();
    const show = (...args) => AutoNext.toast && AutoNext.toast.show(...args);
    const current = (video, request) => requests.get(video) === request
      && request.source === sourceKey(video) && video.isConnected !== false
      && canContinue(video);

    function restoreAudio(video) {
      const saved = audio.get(video);
      if (!saved) return;
      audio.delete(video);
      window.removeEventListener('click', saved.restore, true);
      window.removeEventListener('keydown', saved.restore, true);
      // Restore only the mute value we own; do not overwrite user-adjusted volume.
      if (video.muted === true) video.muted = saved.muted;
    }

    function cancel(video) {
      requests.delete(video);
      restoreAudio(video);
    }

    function saveAudio(video) {
      if (audio.has(video)) return;
      const saved = { muted: video.muted, restore: null };
      saved.restore = () => restoreAudio(video);
      audio.set(video, saved);
      video.muted = true;
    }

    function reportError(video, error) {
      const name = error && error.name || 'Error';
      // AbortError commonly means load()/source replacement, not an autoplay ban.
      AutoNext.warn('自动播放未成功：', name);
      if (AutoNext.addEvent) AutoNext.addEvent('PLAY_REJECTED', { name });
      if (name !== 'AbortError') show(
        name === 'NotSupportedError' ? '媒体格式不支持，请检查视频源' : '自动播放未成功，请手动点击播放', 'warn');
    }

    function run(video, request, mutedRetry) {
      const success = () => {
        if (!current(video, request)) {
          if (requests.get(video) === request) cancel(video);
          return;
        }
        requests.delete(video);
        if (!mutedRetry) return;
        const saved = audio.get(video);
        if (!saved) return;
        window.addEventListener('click', saved.restore, { capture: true, once: true });
        window.addEventListener('keydown', saved.restore, { capture: true, once: true });
        if (AutoNext.addEvent) AutoNext.addEvent('AUTOPLAY_MUTED_FALLBACK', {});
        show('已静音自动开播，点击或按键恢复声音', 'info', 5000);
      };
      const failure = (error) => {
        if (!current(video, request)) {
          if (requests.get(video) === request) cancel(video);
          return;
        }
        if (!mutedRetry && error && error.name === 'NotAllowedError' && !video.muted) {
          saveAudio(video);
          run(video, request, true);
          return;
        }
        cancel(video);
        reportError(video, error);
      };
      try {
        const promise = video.play();
        if (promise && typeof promise.then === 'function') {
          // Observe both rejection and errors from callbacks; never leave a detached rejection.
          Promise.resolve(promise).then(success, failure).catch(error => {
            if (requests.get(video) === request) cancel(video);
            AutoNext.warn('播放结果处理失败：', error && error.name);
          });
        } else success();
      } catch (error) { failure(error); }
    }

    return {
      play(video) {
        const existing = requests.get(video);
        if (existing && existing.source === sourceKey(video)) return false;
        cancel(video);
        if (!canContinue(video) || video.isConnected === false) return false;
        const request = { source: sourceKey(video) };
        requests.set(video, request);
        run(video, request, false);
        return true;
      },
      pending(video) {
        const request = requests.get(video);
        return !!request && request.source === sourceKey(video);
      },
      cancel,
      destroy() {
        for (const video of new Set([...requests.keys(), ...audio.keys()])) cancel(video);
      }
    };
  };
})();
