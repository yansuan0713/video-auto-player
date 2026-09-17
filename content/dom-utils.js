/**
 * dom-utils.js —— 通用 DOM 小工具
 * 只放无状态的纯函数，方便其他模块复用与单测。
 */
(function () {
  'use strict';

  const AutoNext = window.AutoNext;

  const dom = {
    /** 节点是否在文档里且可见（可见性判定宽容一些：不透明、有尺寸即可） */
    isVisible(el) {
      if (!el || !el.isConnected) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      if (parseFloat(style.opacity || '1') === 0) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 && rect.height < 1) return false;
      return true;
    },

    /** 元素是否处于禁用态 */
    isDisabled(el) {
      if (el.hasAttribute('disabled')) return true;
      if (el.getAttribute('aria-disabled') === 'true') return true;
      const cls = typeof el.className === 'string' ? el.className : '';
      return /\b(disabled|is-disabled|btn-disabled|vjs-disabled)\b/i.test(cls);
    },

    /** 归一化文本：去掉空白与控制字符，便于做关键词匹配 */
    normalize(text) {
      return String(text == null ? '' : text)
        .replace(/[\s\u00a0\u3000]+/g, '')
        .replace(/[「」【】\[\]()（）<>《》"'`]/g, '')
        .trim();
    },

    /**
     * 元素**自身**的可读文本（含 title / aria-label 等属性），不沾染父容器里其他按钮的文字。
     * 判定“上一节 / 返回”这类负面词必须用这个，否则会被兄弟按钮的文字带偏。
     */
    ownTextOf(el) {
      const parts = [
        el.textContent,
        el.getAttribute('title'),
        el.getAttribute('aria-label'),
        el.getAttribute('data-title')
      ];
      return parts.filter(Boolean).join(' ');
    },

    /**
     * 候选按钮的可读文本：自身文字优先。
     * 很多按钮的外层是 <a>/<button>，文字在内层 span 里；
     * 也有些页面的文字在父级 label 上，所以自身没文字时向上找一层。
     * 但**绝不把父容器的全部文字**拼进来（那会把同一行的其他按钮文字混进来）。
     */
    textOf(el) {
      const own = dom.ownTextOf(el);
      if (dom.normalize(own)) return own;

      const childText = Array.from(el.children || [])
        .map((child) => child.textContent)
        .filter(Boolean)
        .join(' ');
      if (dom.normalize(childText)) return childText;

      let node = el.parentElement;
      for (let depth = 0; node && depth < 2; depth += 1) {
        const text = node.getAttribute('title') || node.getAttribute('aria-label');
        if (text) return text;
        if (node.children.length === 1) return node.textContent;
        node = node.parentElement;
      }
      return '';
    },

    /** 元素是否像“可点击控件”（a / button / role=button / 有 onclick） */
    isClickable(el) {
      const tag = el.tagName;
      if (tag === 'A' || tag === 'BUTTON' || tag === 'INPUT') return true;
      if (el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link') return true;
      if (el.hasAttribute('onclick') || el.getAttribute('tabindex') === '0') return true;
      return false;
    },

    /**
     * 模拟一次真实点击。
     * 学习通部分按钮是 Vue/React 绑定的，需要完整的事件序列才会触发。
     */
    click(el) {
      const rect = el.getBoundingClientRect();
      const opts = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2
      };
      const hasPointer = typeof window.PointerEvent === 'function';
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        const isPointer = type.startsWith('pointer');
        if (isPointer && !hasPointer) continue;
        const Ctor = isPointer ? window.PointerEvent : window.MouseEvent;
        try {
          el.dispatchEvent(new Ctor(type, opts));
        } catch (err) {
          AutoNext.debug('派发事件失败：', type, err && err.message);
        }
      }
      // 事件被 preventDefault 时兜底调用原生 click()
      if (typeof el.click === 'function' && !(typeof HTMLInputElement !== 'undefined' && el instanceof HTMLInputElement)) {
        try { el.click(); } catch (_) { /* ignore */ }
      }
    },

    /** 限频：返回一个包装函数，同一 ms 窗口内只执行第一次 */
    throttle(fn, ms) {
      let last = 0;
      return function throttled(...args) {
        const now = Date.now();
        if (now - last < ms) return undefined;
        last = now;
        return fn.apply(this, args);
      };
    },

    /** 防抖 */
    debounce(fn, ms) {
      let timer = null;
      return function debounced(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), ms);
      };
    },

    /** 兼容 structuredClone 缺失的环境 */
    clone(value) {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch (_) {
        return value;
      }
    },

    /**
     * 对 URL 和媒体源做敏感信息脱敏（去除 token/ticket/sign/auth 等）
     * 诊断输出、日志展示与一键导出时必须使用此方法处理 URL
     */
    sanitizeUrl(rawUrl) {
      if (!rawUrl || typeof rawUrl !== 'string') return '';
      // 精确键：短键或易与业务参数撞车的键（sig/at_/credential 等）必须整体匹配，
      // 否则 design(含 sign)、signal(含 sig) 这类正常参数会被误脱敏。
      const SENSITIVE_KEYS = /^(token|ticket|auth|authorization|session|sessionid|jwt|access_token|accesstoken|secret|signature|sign|sig|at_|credential|x-amz-signature|x-amz-credential|x-amz-security-token|key|password|pwd|code|user_token|enc)$/i;
      // 子串键：只保留够长、语义明确、几乎不会作为普通词出现的片段
      const SENSITIVE_PATTERN = /token|ticket|authorization|jwt|signature|secret|credentials|sessionid|password/i;
      try {
        const base = typeof window !== 'undefined' && window.location ? window.location.href : 'http://localhost';
        const parsed = new URL(rawUrl, base);
        const keys = Array.from(parsed.searchParams.keys());
        for (const key of keys) {
          if (SENSITIVE_KEYS.test(key) || SENSITIVE_PATTERN.test(key)) {
            parsed.searchParams.set(key, '[REDACTED]');
          }
        }
        if (parsed.hash && /(?:^|[#&?=_])(?:token|ticket|auth|authorization|jwt|signature|sign|sig|at_|credential|x-amz-[a-z0-9-]+|key|secret|session|enc)(?:[=&_]|$)/i.test(parsed.hash)) {
          parsed.hash = '#[REDACTED]';
        }
        return parsed.toString().replace(/%5BREDACTED%5D/gi, '[REDACTED]');
      } catch (_) {
        return rawUrl.replace(
          /([?&](?:token|ticket|auth|jwt|sign|sig|at_|credential|x-amz-signature|x-amz-credential|x-amz-security-token|key|secret|session|enc)=)[^&#]*/gi,
          '$1[REDACTED]'
        );
      }
    },

    /**
     * 发现页面中的全部 <video> 元素，支持递归穿透 open Shadow DOM。
     * （封闭式 closed Shadow DOM 属于浏览器标准边界，由规范限制外部脚本读取）
     */
    findVideos(root = document) {
      if (!root) return [];
      const videos = [];
      const seen = new Set();
      const walk = (node) => {
        if (!node || seen.has(node)) return;
        seen.add(node);
        if (node.tagName === 'VIDEO') {
          videos.push(node);
        }
        if (node.shadowRoot) {
          walk(node.shadowRoot);
        }
        const children = node.children || [];
        for (let i = 0; i < children.length; i += 1) {
          walk(children[i]);
        }
      };
      walk(root.documentElement || root);
      return videos;
    }
  };

  AutoNext.dom = dom;

})();
