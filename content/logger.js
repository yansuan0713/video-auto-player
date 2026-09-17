/**
 * logger.js —— 统一日志出口
 *
 * 日志分两层：
 *   · 关键日志（log / warn / error）：默认**始终输出**，格式固定为
 *       [AutoNext] video detected
 *       [AutoNext] video ended
 *       [AutoNext] next lesson found
 *       [AutoNext] navigating
 *   · 详细日志（debug）：只有 popup 里打开“详细调试日志”才输出，避免刷屏
 *
 * 如果确实想彻底静音，可在控制台执行 __AUTO_NEXT__.silent(true)。
 */
(function () {
  'use strict';

  const PREFIX = '[AutoNext]';

  const state = {
    /** 关键日志总开关，默认开 */
    enabled: true,
    /** 详细日志开关，默认关（由 popup 的 verbose 控制） */
    verbose: false
  };

  const out = (method, args) => {
    try {
      console[method](PREFIX, ...args);
    } catch (_) {
      /* 某些页面会重写 console，忽略即可 */
    }
  };

  const AutoNext = (window.AutoNext = window.AutoNext || {});

  /** 关键节点日志：默认始终输出 */
  AutoNext.log = (...args) => {
    if (state.enabled) out('log', args);
  };

  /** 详细日志：仅 verbose 打开时输出 */
  AutoNext.debug = (...args) => {
    if (state.enabled && state.verbose) out('log', args);
  };

  AutoNext.info = (...args) => {
    if (state.enabled) out('info', args);
  };

  AutoNext.warn = (...args) => {
    if (state.enabled) out('warn', args);
  };

  AutoNext.error = (...args) => {
    out('error', args); // 错误始终输出，即使已静音
  };

  const MAX_EVENTS = 50;
  const events = [];

  /**
   * 记录关键事件（供诊断面板与导出使用）
   * @param {string} type 事件类型：VIDEO_DETECTED, RATE_CHANGE, PAUSED, RESUME, ENDED, NEXT_FOUND, NAVIGATED, etc.
   * @param {any} detail 事件详情
   */
  AutoNext.addEvent = (type, detail = {}) => {
    const now = Date.now();
    let timeStr = '';
    try {
      timeStr = new Date(now).toLocaleTimeString();
    } catch (_) {
      const sec = Math.floor(now / 1000) % 86400;
      const h = String(Math.floor(sec / 3600)).padStart(2, '0');
      const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
      const s = String(sec % 60).padStart(2, '0');
      timeStr = `${h}:${m}:${s}`;
    }
    const item = {
      timestamp: now,
      timeStr: timeStr || String(now),
      type: String(type || 'EVENT'),
      detail: typeof detail === 'string' ? { message: detail } : (detail ? { ...detail } : {})
    };
    events.push(item);
    if (events.length > MAX_EVENTS) {
      events.shift();
    }
  };

  AutoNext.getEvents = () => events.slice();
  AutoNext.clearEvents = () => { events.length = 0; };

  AutoNext.logger = {
    addEvent: AutoNext.addEvent,
    getEvents: AutoNext.getEvents,
    clearEvents: AutoNext.clearEvents,
    log: AutoNext.log,
    debug: AutoNext.debug,
    info: AutoNext.info,
    warn: AutoNext.warn,
    error: AutoNext.error,
    setLogOptions: AutoNext.setLogOptions
  };

  /**
   * 由 settings 模块调用
   * @param {{verbose?: boolean, enabled?: boolean}} options
   */
  AutoNext.setLogOptions = ({ enabled, verbose } = {}) => {
    if (typeof enabled === 'boolean') state.enabled = enabled;
    if (typeof verbose === 'boolean') state.verbose = verbose;
  };

  AutoNext.logState = () => ({ ...state });

  AutoNext.setLogOptions();

})();
