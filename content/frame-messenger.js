/**
 * frame-messenger.js —— 跨 iframe 协调
 *
 * 场景：学习通的播放器常常在 <iframe> 里，而“下一节”按钮在父页面（或更上层的顶层页面）。
 * content script 在 all_frames 下每个 frame 各跑一份，彼此之间**无法直接访问对方的 DOM**，
 * 因此用 window.postMessage 做最小协调，只传递“事件通知”，不传递任何页面数据。
 *
 * 重要：postMessage 只能发给“直接父级”或“直接子级”，一次跳不过中间层。
 * 学习通的播放器嵌套层级并不固定（实测见过 video iframe 嵌在 knowledge/cards iframe 里面），
 * 所以这里采用**逐级中继**：
 *   UP   向父级 + 所有子级发出，每个 frame 收到后若自己处理不了就继续向它的父级转发，
 *        这样请求一定能爬到顶层（按钮通常在顶层）。
 *   去重 每条消息带唯一 id，处理过的 id 会被记住，中继不会无限循环。
 *
 * 消息类型：
 *   VIDEO     某个 frame 的视频播完了，请帮忙找“下一节”
 *   SCAN      要求重新扫描视频（SPA 换页后感知不到）
 *   NAVIGATED 已经有人点过了，其他 frame 不要再点，避免连跳两节
 */
(function () {
  'use strict';

  const AutoNext = window.AutoNext;

  const SOURCE = 'auto-next-extension';
  const TYPES = {
    VIDEO: 'AUTO_NEXT_VIDEO_ENDED',
    SCAN: 'AUTO_NEXT_SCAN',
    NAVIGATING: 'AUTO_NEXT_NAVIGATING',
    NAVIGATED: 'AUTO_NEXT_NAVIGATED'
  };

  const NAVIGATION_COOLDOWN = 2000; // 同一个 tab 内 2.0s 只允许一次跳转
  const SEEN_LIMIT = 40; // 记最近若干条消息 id，防止中继回环

  let lastNavigationAt = 0;
  let msgSeq = 0;
  const seenIds = new Set();
  /** 诊断用：本 frame 一共发出/收到过多少次求助 */
  const stats = { requested: 0, received: 0, relays: 0, errors: 0 };

  function markSeen(id) {
    if (!id) return true;
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    if (seenIds.size > SEEN_LIMIT) {
      // Set 保持插入顺序，删掉最早的一条
      seenIds.delete(seenIds.values().next().value);
    }
    return true;
  }

  function childFrames() {
    try {
      return Array.from(window.frames || []);
    } catch (_) {
      return [];
    }
  }

  /** 带来源标记地发消息 */
  function send(target, type, id) {
    if (!target || typeof target.postMessage !== 'function') return false;
    try {
      target.postMessage({ source: SOURCE, type, id: id || `m${(msgSeq += 1)}` }, '*');
      return true;
    } catch (err) {
      stats.errors += 1;
      AutoNext.debug('postMessage 失败：', err && err.message);
      return false;
    }
  }

  /**
   * 向上层 + 所有直接子级发出消息。
   * 每个 frame 收到后会按需继续向上中继，所以即使嵌套多层也能到达顶层。
   */
  function notifyUp(type, id) {
    let delivered = 0;
    const msgId = id || `m${(msgSeq += 1)}`;
    markSeen(msgId);
    if (!messenger.isTop) {
      if (send(window.parent, type, msgId)) delivered += 1;
    }
    for (const frame of childFrames()) {
      if (send(frame, type, msgId)) delivered += 1;
    }
    return delivered;
  }

  /** 让扩展图标显示一个角标（content script 拿不到 chrome.action，转发给 service worker） */
  function setBadge(text, color) {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return;
      chrome.runtime.sendMessage({ type: 'AUTO_NEXT_BADGE', text, color }, () => {
        void chrome.runtime.lastError; // service worker 未唤醒时忽略
      });
    } catch (_) { /* 忽略 */ }
  }

  const messenger = {
    isTop: window.top === window,
    setBadge,
    stats,

    /** 广播给所有子 frame */
    broadcast(type, id) {
      let delivered = 0;
      for (const frame of childFrames()) {
        if (send(frame, type, id)) delivered += 1;
      }
      return delivered;
    },

    /** 通知父级 frame */
    notifyParent(type, id) {
      if (messenger.isTop) return 0;
      return send(window.parent, type, id) ? 1 : 0;
    },

    /**
     * 请求“帮忙找下一节”：同时发给父级和所有子级，由收到的一方按需继续向上中继。
     * 返回实际投递到的 frame 数（诊断用）。
     */
    requestHelp() {
      stats.requested += 1;
      const ownId = `m${(msgSeq += 1)}`;
      markSeen(ownId);
      const delivered = notifyUp(TYPES.VIDEO, ownId);
      AutoNext.warn('已请求其他 frame 帮忙找“下一节”', `投递到 ${delivered} 个相邻 frame`,
        `（本 frame ${messenger.isTop ? '是顶层' : '不是顶层'}，直接子 frame ${childFrames().length} 个）`);
      return delivered;
    },

    /** 广播“正在跳转中”，锁定所有 frame 防止并发竞争 */
    reportNavigating(id) {
      lastNavigationAt = Date.now();
      const own = id || `m${(msgSeq += 1)}`;
      markSeen(own);
      messenger.broadcast(TYPES.NAVIGATING, own);
      messenger.notifyParent(TYPES.NAVIGATING, own);
    },

    /** 广播“已经跳转了”，让其他 frame 停下来 */
    reportNavigated(id) {
      lastNavigationAt = Date.now();
      const own = id || `m${(msgSeq += 1)}`;
      markSeen(own);
      messenger.broadcast(TYPES.NAVIGATED, own);
      messenger.notifyParent(TYPES.NAVIGATED, own);
    },

    /**
     * 是否刚刚有别的 frame 完成过跳转（避免同一个视频结束事件被多个 frame 各点一次）
     */
    recentlyNavigated(windowMs = NAVIGATION_COOLDOWN) {
      return Date.now() - lastNavigationAt < windowMs;
    },

    /**
     * 注册消息处理
     * @param {{onVideoEnded: Function, onScan: Function, onNavigated: Function, onNavigating: Function}} handlers
     */
    listen(handlers = {}) {
      window.addEventListener('message', (event) => {
        const data = event.data;
        if (!data || typeof data !== 'object' || data.source !== SOURCE) return;
        // 同一条消息可能在父子之间来回弹，用 id 去重（尤其是我们要做中继的时候）
        if (!markSeen(data.id)) return;

        switch (data.type) {
          case TYPES.VIDEO: {
            stats.received += 1;
            // 交给上层处理：能找到按钮就点，找不到就由 content.js 决定是否继续中继
            const handled = handlers.onVideoEnded ? handlers.onVideoEnded(data) : false;
            if (handled !== true && !messenger.isTop) {
              // 本 frame 处理不了：继续往上中继，直到爬到能处理的那一层
              stats.relays += 1;
              messenger.notifyParent(TYPES.VIDEO, data.id);
            }
            break;
          }
          case TYPES.SCAN:
            if (handlers.onScan) handlers.onScan();
            break;
          case TYPES.NAVIGATING:
            lastNavigationAt = Date.now();
            if (handlers.onNavigating) handlers.onNavigating();
            break;
          case TYPES.NAVIGATED:
            lastNavigationAt = Date.now();
            if (handlers.onNavigated) handlers.onNavigated();
            break;
          default:
            break;
        }
      });
    },

    TYPES
  };

  AutoNext.messenger = messenger;

})();
