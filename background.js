/**
 * background.js —— MV3 service worker
 *
 * 职责很轻，只做两件事：
 *   1. 首次安装时写入默认设置；
 *   2. 让 popup 能通过消息读写设置（popup 直接操作 storage，
 *      再广播一次变化，保证 iframe 里的 content script 也能立刻收到）。
 */
'use strict';

const DEFAULTS = { autoNext: false, autoRate2x: false, autoSkipNonVideo: false, verbose: false };

chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.local.get(DEFAULTS, (values) => {
    chrome.storage.local.set(values, () => {
      console.log('[AutoNext] 设置已初始化', values, '原因：', details.reason);
    });
  });
});

/** popup 或其他扩展页面可以发消息查询 / 修改设置 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  switch (message.type) {
    case 'AUTO_NEXT_GET_SETTINGS':
      chrome.storage.local.get(DEFAULTS, (values) => sendResponse({ ok: true, values }));
      return true; // 异步响应
    case 'AUTO_NEXT_SET_SETTINGS':
      chrome.storage.local.set(message.values || {}, () => sendResponse({ ok: true }));
      return true;
    case 'AUTO_NEXT_BADGE':
      // content script 拿不到 chrome.action，由这里代设扩展图标角标，
      // 这样"视频结束了 / 没找到下一节"在页面上能直接看到，不必盯着控制台
      showBadge(message.text || '', message.color);
      sendResponse({ ok: true });
      return false;
    default:
      return false;
  }
});

let badgeTimer = null;

function showBadge(text, color) {
  clearTimeout(badgeTimer);
  chrome.action.setBadgeBackgroundColor({ color: color || '#2563eb' });
  chrome.action.setBadgeText({ text });
  if (!text) return;
  badgeTimer = setTimeout(() => chrome.action.setBadgeText({ text: '' }), 6000);
}
