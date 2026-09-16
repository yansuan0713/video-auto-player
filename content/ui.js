/**
 * ui.js —— 页面右下角的轻量状态提示
 * 纯 DOM 注入，不使用 innerHTML，避免触发页面的 CSP 限制。
 */
(function () {
  'use strict';

  const AutoNext = window.AutoNext;

  const COLORS = {
    info: 'rgba(30, 41, 59, .92)',
    success: 'rgba(22, 101, 52, .92)',
    warn: 'rgba(146, 64, 14, .92)',
    error: 'rgba(153, 27, 27, .92)'
  };

  let host = null;
  let box = null;
  let hideTimer = null;

  function ensure() {
    if (box && box.isConnected) return box;
    host = document.createElement('div');
    host.id = '__auto_next_toast__';
    host.style.cssText = [
      'all:initial',
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:2147483647',
      'pointer-events:none',
      'font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif'
    ].join(';');
    box = document.createElement('div');
    box.style.cssText = [
      'all:initial',
      'display:block',
      'max-width:280px',
      'padding:8px 12px',
      'border-radius:8px',
      'background:rgba(30,41,59,.92)',
      'color:#fff',
      'font-size:12px',
      'line-height:1.5',
      'font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif',
      'box-shadow:0 6px 18px rgba(0,0,0,.28)',
      'transition:opacity .25s ease',
      'opacity:0'
    ].join(';');
    host.appendChild(box);
    (document.body || document.documentElement).appendChild(host);
    return box;
  }

  /** 只有顶层 frame 显示提示，避免 iframe 里飘出好几个一样的气泡 */
  function shouldShow() {
    if (window.top === window) return true;
    try {
      return window.self === window.top;
    } catch (_) {
      return false;
    }
  }

  /**
   * @param {string} message
   * @param {'info'|'success'|'warn'|'error'} [type]
   * @param {number} [duration]
   */
  function show(message, type = 'info', duration = 3200) {
    try {
      if (!shouldShow() || !document.body) return;
      const el = ensure();
      el.textContent = `[AutoNext] ${message}`;
      el.style.background = COLORS[type] || COLORS.info;
      el.style.opacity = '1';
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (el) el.style.opacity = '0';
      }, duration);
    } catch (err) {
      AutoNext.debug('提示气泡渲染失败：', err && err.message);
    }
  }

  // 无论页面是否具备插入条件，都要保证接口存在，调用方不必再判空
  AutoNext.toast = { show };

})();
