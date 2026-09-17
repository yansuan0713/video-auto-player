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

  AutoNext.hasStorage = typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.local);

  /**
   * 迁移旧版本（v1.1.7）数据结构到 v1.2.0
   * @param {object} raw
   * @returns {{migrated: object, changed: boolean}}
   */
  function migrateSettings(raw = {}) {
    const next = { ...DEFAULTS, ...raw };
    let changed = false;

    // v1.1.7 只有 autoRate2x，将其迁移并保持与 autoRate 双向兼容
    if (raw.autoRate === undefined) {
      if (raw.autoRate2x !== undefined) {
        next.autoRate = raw.autoRate2x === true;
      }
      changed = true;
    }
    next.autoRate2x = next.autoRate === true;

    if (typeof next.playbackRate !== 'number' || !Number.isFinite(next.playbackRate) || next.playbackRate <= 0) {
      next.playbackRate = 2.0;
      changed = true;
    }

    if (!next.siteSettings || typeof next.siteSettings !== 'object' || Array.isArray(next.siteSettings)) {
      next.siteSettings = {};
      changed = true;
    }

    if (next.configVersion !== '1.2.0') {
      next.configVersion = '1.2.0';
      changed = true;
    }

    return { migrated: next, changed };
  }

  /**
   * 计算指定站点最终生效的设置（站点设置优先于全局设置）
   * @param {object} globalValues 全局设置
   * @param {string} [hostname] 目标站点域名，缺省取当前窗口域名
   */
  function resolveEffective(globalValues = {}, hostname) {
    let host = hostname || '';
    if (!host && typeof window !== 'undefined' && window.location) {
      if (window.location.hostname) {
        host = window.location.hostname;
      } else if (window.location.href) {
        try {
          host = new URL(window.location.href).hostname;
        } catch (_) {}
      }
    }
    const sites = globalValues.siteSettings || {};
    let siteRule = (host && sites[host]) || null;

    // 若当前 frame 自身没有显式覆盖规则，且当前处于 iframe 中，尝试探测顶层窗口或父级页面规则以安全继承
    if ((!siteRule || (!siteRule.override && !siteRule.enabled)) && typeof window !== 'undefined') {
      let topHost = '';
      try {
        if (window.top && window.top !== window && window.top.location && window.top.location.hostname) {
          topHost = window.top.location.hostname;
        }
      } catch (_) {
        // 跨域 iframe 下访问 window.top.location 会抛出 SecurityError，尝试从 document.referrer 提取顶层/父级域名
        try {
          if (typeof document !== 'undefined' && document.referrer) {
            topHost = new URL(document.referrer).hostname;
          }
        } catch (_) {}
      }
      if (topHost && sites[topHost] && (sites[topHost].override === true || sites[topHost].enabled === true)) {
        siteRule = sites[topHost];
      }
    }

    const hasSiteOverride = !!(siteRule && (siteRule.override === true || siteRule.enabled === true));

    const autoNext = (hasSiteOverride && typeof siteRule.autoNext === 'boolean')
      ? siteRule.autoNext
      : (globalValues.autoNext === true);

    const autoRate = (hasSiteOverride && typeof siteRule.autoRate === 'boolean')
      ? siteRule.autoRate
      : (globalValues.autoRate === true || globalValues.autoRate2x === true);

    const playbackRate = (hasSiteOverride && typeof siteRule.playbackRate === 'number' && siteRule.playbackRate > 0)
      ? siteRule.playbackRate
      : (typeof globalValues.playbackRate === 'number' && globalValues.playbackRate > 0 ? globalValues.playbackRate : 2.0);

    const autoSkipNonVideo = (hasSiteOverride && typeof siteRule.autoSkipNonVideo === 'boolean')
      ? siteRule.autoSkipNonVideo
      : (globalValues.autoSkipNonVideo === true);

    const siteCustom = siteRule && (typeof siteRule.customNextSelector === 'string' ? siteRule.customNextSelector : (typeof siteRule.customSelector === 'string' ? siteRule.customSelector : ''));
    const globalCustom = typeof globalValues.customNextSelector === 'string' ? globalValues.customNextSelector : (typeof globalValues.customSelector === 'string' ? globalValues.customSelector : '');
    const customNextSelector = (siteCustom || globalCustom || '').trim();

    return {
      autoNext,
      autoRate,
      autoRate2x: autoRate,
      playbackRate,
      autoSkipNonVideo,
      customNextSelector,
      hasSiteOverride,
      siteRule,
      hostname: host
    };
  }

  const apply = (values) => {
    AutoNext.setLogOptions({
      enabled: true, // 关键日志默认始终输出
      verbose: values.verbose === true
    });
  };

  let cachedValues = { ...DEFAULTS };
  let effectiveValues = resolveEffective(cachedValues);

  AutoNext.settings = {
    DEFAULTS,
    migrateSettings,
    resolveEffective,

    /** 自动进入下一节（生效值） */
    get enabled() {
      return effectiveValues.autoNext;
    },
    set enabled(val) {
      effectiveValues.autoNext = !!val;
      cachedValues.autoNext = !!val;
    },

    /** 自动倍速（生效值） */
    get autoRate() {
      return effectiveValues.autoRate;
    },
    set autoRate(val) {
      effectiveValues.autoRate = !!val;
      effectiveValues.autoRate2x = !!val;
      cachedValues.autoRate = !!val;
      cachedValues.autoRate2x = !!val;
    },

    /** 兼容旧代码与单测的 autoRate2x 属性 */
    get autoRate2x() {
      return effectiveValues.autoRate;
    },
    set autoRate2x(val) {
      this.autoRate = val;
    },

    /** 生效的目标播放倍速 */
    get playbackRate() {
      return effectiveValues.playbackRate;
    },
    set playbackRate(val) {
      const num = Number(val);
      if (Number.isFinite(num) && num > 0) {
        effectiveValues.playbackRate = num;
        cachedValues.playbackRate = num;
      }
    },

    /** 自动跳过非视频页面（生效值） */
    get autoSkipNonVideo() {
      return effectiveValues.autoSkipNonVideo;
    },
    set autoSkipNonVideo(val) {
      effectiveValues.autoSkipNonVideo = !!val;
      cachedValues.autoSkipNonVideo = !!val;
    },

    /** 自定义下一节选择器（站点规则） */
    get customNextSelector() {
      return effectiveValues.customNextSelector;
    },

    /** 站点设置原始字典 */
    get siteSettings() {
      return cachedValues.siteSettings || {};
    },

    /** 当前页面是否启用了站点规则覆盖 */
    get hasSiteOverride() {
      return effectiveValues.hasSiteOverride;
    },

    /** 获取当前生效设置快照 */
    effective() {
      return { ...effectiveValues };
    },

    /** 别名：兼容部分直接调用 settings.get() 的场景 */
    get() {
      return { ...effectiveValues };
    },

    /** 当前页面匹配到的域名 */
    get currentHost() {
      return effectiveValues.hostname || '';
    },

    /** 获取全局原始设置快照 */
    raw() {
      return { ...cachedValues };
    },

    /** 读取一次并同步到内存，自动执行旧版配置迁移 */
    load() {
      return new Promise((resolve) => {
        if (!AutoNext.hasStorage) {
          AutoNext.warn('chrome.storage 不可用，使用默认值');
          effectiveValues = resolveEffective(cachedValues);
          resolve({ ...DEFAULTS });
          return;
        }
        chrome.storage.local.get(null, (raw) => {
          if (chrome.runtime.lastError) {
            AutoNext.error('读取设置失败：', chrome.runtime.lastError.message);
            effectiveValues = resolveEffective(cachedValues);
            resolve({ ...DEFAULTS });
            return;
          }
          const { migrated, changed } = migrateSettings(raw);
          cachedValues = migrated;
          effectiveValues = resolveEffective(cachedValues);
          apply(cachedValues);

          if (changed) {
            chrome.storage.local.set(cachedValues, () => {
              AutoNext.debug('已自动将设置迁移至 v1.2.0 格式');
            });
          }

          AutoNext.debug(`设置已加载 autoNext=${effectiveValues.autoNext} autoRate=${effectiveValues.autoRate}(${effectiveValues.playbackRate}x) siteOverride=${effectiveValues.hasSiteOverride}`);
          resolve(cachedValues);
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
          const nextVal = changes.autoNext.newValue === true;
          cachedValues.autoNext = nextVal;
          effectiveValues.autoNext = nextVal;
          changed.autoNext = nextVal;
          AutoNext.log(nextVal ? '自动进入下一节已开启' : '自动进入下一节已关闭');
        }
        if (changes.autoRate2x || changes.autoRate) {
          const nextVal = (changes.autoRate && changes.autoRate.newValue === true) ||
                          (changes.autoRate2x && changes.autoRate2x.newValue === true);
          cachedValues.autoRate = nextVal;
          cachedValues.autoRate2x = nextVal;
          effectiveValues.autoRate = nextVal;
          effectiveValues.autoRate2x = nextVal;
          changed.autoRate = nextVal;
          changed.autoRate2x = nextVal;
        }
        if (changes.playbackRate && typeof changes.playbackRate.newValue === 'number') {
          cachedValues.playbackRate = changes.playbackRate.newValue;
          effectiveValues.playbackRate = changes.playbackRate.newValue;
          changed.playbackRate = effectiveValues.playbackRate;
        }
        if (changes.autoSkipNonVideo) {
          const nextVal = changes.autoSkipNonVideo.newValue === true;
          cachedValues.autoSkipNonVideo = nextVal;
          effectiveValues.autoSkipNonVideo = nextVal;
          changed.autoSkipNonVideo = nextVal;
        }
        if (changes.siteSettings) {
          cachedValues.siteSettings = changes.siteSettings.newValue || {};
          effectiveValues = resolveEffective(cachedValues);
          changed.siteSettings = cachedValues.siteSettings;
        }
        if (typeof onChange === 'function' && Object.keys(changed).length) {
          onChange(changed);
        }
      });
    }
  };

})();
