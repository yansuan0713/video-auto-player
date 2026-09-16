/**
 * settings.js —— 开关状态的读写与变更订阅
 *
 * 存储位置：chrome.storage.local
 *   autoNext : boolean  主开关（popup 里的“自动播放下一节”）
 *   verbose  : boolean  详细日志（可选，默认关）
 */
(function () {
  'use strict';

  const AutoNext = window.AutoNext;
  const DEFAULTS = { autoNext: false, autoRate2x: false, autoSkipNonVideo: false, verbose: false };

  AutoNext.hasStorage = typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.local);

  const apply = (values) => {
    AutoNext.setLogOptions({
      enabled: true, // 关键日志默认始终输出，保证 [AutoNext] video ended 这类提示可见
      verbose: values.verbose === true
    });
  };

  AutoNext.settings = {
    /** 自动进入下一节 */
    enabled: DEFAULTS.autoNext,
    /** 自动二倍速 */
    autoRate2x: DEFAULTS.autoRate2x,
    /** 自动跳过非视频页面（默认关闭：可能跳过测验/作业，见 README） */
    autoSkipNonVideo: DEFAULTS.autoSkipNonVideo,

    /** 读取一次并同步到内存 */
    load() {
      return new Promise((resolve) => {
        if (!AutoNext.hasStorage) {
          AutoNext.warn('chrome.storage 不可用，使用默认值（两项功能均关闭）');
          resolve({ ...DEFAULTS });
          return;
        }
        chrome.storage.local.get(DEFAULTS, (values) => {
          if (chrome.runtime.lastError) {
            AutoNext.error('读取设置失败：', chrome.runtime.lastError.message);
            resolve({ ...DEFAULTS });
            return;
          }
          this.enabled = values.autoNext === true;
          this.autoRate2x = values.autoRate2x === true;
          this.autoSkipNonVideo = values.autoSkipNonVideo === true;
          apply(values);
          AutoNext.debug(`设置已加载 autoNext=${this.enabled} autoRate2x=${this.autoRate2x} verbose=${values.verbose}`);
          resolve(values);
        });
      });
    },

    /** 订阅变更：popup 一改开关，已打开的页面立刻生效 */
    subscribe(onChange) {
      if (!AutoNext.hasStorage || !chrome.storage.onChanged) return;
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.verbose) {
          apply({ verbose: changes.verbose.newValue === true });
        }
        const changed = {};
        if (changes.autoNext) {
          this.enabled = changes.autoNext.newValue === true;
          changed.autoNext = this.enabled;
          AutoNext.log(this.enabled ? '自动进入下一节已开启' : '自动进入下一节已关闭');
        }
        if (changes.autoRate2x) {
          this.autoRate2x = changes.autoRate2x.newValue === true;
          changed.autoRate2x = this.autoRate2x;
        }
        if (changes.autoSkipNonVideo) {
          this.autoSkipNonVideo = changes.autoSkipNonVideo.newValue === true;
          changed.autoSkipNonVideo = this.autoSkipNonVideo;
        }
        if (typeof onChange === 'function' && Object.keys(changed).length) onChange(changed);
      });
    }
  };

})();
