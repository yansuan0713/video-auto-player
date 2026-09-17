/**
 * button-finder.js —— “下一节 / 下一个任务点” 按钮候选查找
 *
 * 设计目标：**不写死单个 CSS selector**。
 * 采用“候选选择器打分 + 文本关键词打分”的加权模型：
 *
 *   总分 = 选择器得分(SELECTORS) + 文本得分(TEXTS) + 结构得分(结构特征) - 惩罚分
 *
 * 页面改版后，即使旧的 class / id 全变了，只要按钮文字里还有
 * “下一节 / 下一章 / 下一个 / 下一任务点”等中文关键词，依然能命中；
 * 反之，如果文字变了但选择器还在，也能命中。两条腿走路，容错率更高。
 */
(function () {
  'use strict';

  const AutoNext = window.AutoNext;
  const { dom } = AutoNext;

  /** 第一层：常见选择器候选（越靠前越可信） */
  const SELECTORS = [
    // —— 超星学习通常见结构（由具体到通用，全部允许失效）——
    ['#prevNextFocusNext', 100],
    ['#nextBtn', 96],
    ['.posCatalog_select .prev_next.next', 90],
    ['.prev_next.next', 88],
    ['a[onclick*="getTeacherAjax"][onclick*="next"]', 86],
    ['#prevNextNext', 86],
    // —— 通用命名（class / id / 属性里带 next 的控件）——
    ['[data-action="next"]', 84],
    ['[data-role="next"]', 84],
    ['[data-testid="next"]', 82],
    ['[data-next]', 78],
    ['a[title*="下一"]', 80],
    ['button[title*="下一"]', 80],
    ['[aria-label*="下一"]', 78],
    ['[aria-label*="next" i]', 70],
    ['[title*="next" i]', 68],
    ['a.next', 66],
    ['button.next', 66],
    ['a[class*="next" i]', 58],
    ['button[class*="next" i]', 58],
    ['[class*="next-btn" i]', 58],
    ['[class*="nextBtn"]', 58],
    ['[id*="next" i]', 52],
    ['[class*="next" i]', 50],
    ['[onclick*="next" i]', 46],
    ['[href*="next" i]', 44]
  ];

  /** 第二层：文本关键词，exact > startsWith > includes */
  const TEXTS = [
    { value: '下一节', exact: 74, startsWith: 62, includes: 50 },
    { value: '下一章', exact: 72, startsWith: 60, includes: 48 },
    { value: '下一个', exact: 70, startsWith: 58, includes: 46 },
    { value: '下一任务点', exact: 74, startsWith: 62, includes: 50 },
    { value: '下一课', exact: 68, startsWith: 56, includes: 44 },
    { value: '下一讲', exact: 68, startsWith: 56, includes: 44 },
    { value: '下一集', exact: 64, startsWith: 52, includes: 42 },
    { value: '下一视频', exact: 70, startsWith: 58, includes: 46 },
    { value: 'next', exact: 46, startsWith: 38, includes: 26 }
  ];

  /** 反向词：命中则重罚，避免把“上一节 / 返回目录 / 下一章练习”当成导航 */
  const NEGATIVE = [
    '上一节', '上一章', '上一个', '上一页', '返回', 'back', 'prev', 'previous', 'replay', '重播', '重看',
    '提交', '交卷', '答题', '测验', '考试', 'submit', 'quiz', 'exam'
  ];

  const TEXT_LIMIT = 60; // 文本太长基本是容器，不是按钮

  const selectorCache = new Map();

  /** 安全地跑一个选择器：页面可能在改版中，非法选择器不该让插件崩掉 */
  function safeQueryAll(selector) {
    try {
      return Array.from(document.querySelectorAll(selector));
    } catch (err) {
      AutoNext.debug(`选择器不可用，已跳过：${selector}`, err && err.message);
      return [];
    }
  }

  /** 汇总每个元素的选择器得分，同时记录它**自身**命中的最高分 */
  function collectSelectorHits() {
    const hits = new Map();
    for (const [selector, score] of SELECTORS) {
      for (const el of safeQueryAll(selector)) {
        const prev = hits.get(el);
        if (!prev || score > prev.score) hits.set(el, { score, self: true });
      }
    }
    return hits;
  }

  /**
   * 取某元素从“后代选择器命中”继承来的分数。
   * 只沿着 rawEl → el 这条祖先链往上继承（也就是 closestClickable 走过的路径），
   * 绝不跨到兄弟分支，否则目录容器会因为包含多个候选而反超真正的按钮。
   */
  function inheritedScore(rawEl, el, hits) {
    let best = 0;
    let node = rawEl;
    for (let depth = 0; node && depth < 3; depth += 1) {
      const hit = hits.get(node);
      if (hit && hit.score > best) best = hit.score;
      if (node === el) break;
      node = node.parentElement;
    }
    return best;
  }

  function textScore(rawText) {
    const text = dom.normalize(rawText);
    if (!text || text.length > TEXT_LIMIT) return 0;
    const lower = text.toLowerCase();
    let best = 0;
    for (const rule of TEXTS) {
      const key = rule.value.toLowerCase();
      if (text === key) best = Math.max(best, rule.exact);
      else if (text.startsWith(key)) best = Math.max(best, rule.startsWith);
      else if (text.includes(key)) best = Math.max(best, rule.includes);
      else if (lower.includes(key)) best = Math.max(best, Math.round(rule.includes * 0.6));
    }
    return best;
  }

  function hasNegative(text) {
    const lower = String(text).toLowerCase();
    return NEGATIVE.some((word) => lower.includes(word));
  }

  /** 向上找最近的可点击祖先，避免选到内层 span / i 图标 */
  function closestClickable(el) {
    let node = el;
    for (let depth = 0; node && depth < 3; depth += 1) {
      if (dom.isClickable(node)) return node;
      node = node.parentElement;
    }
    return null;
  }

  /** 元素是否有“向前”的视觉暗示（右箭头 / next 图标），按 class token 精确匹配以免误报 */
  const ICON_TOKEN = /^(next|arrow-?right|arrowright|right-?arrow|next-?(btn|button|icon))$/i;
  function hasNextIcon(el) {
    const nodes = [el].concat(Array.from(el.children || [])).slice(0, 5);
    return nodes.some((node) => {
      const tokens = String((node && node.className) || '').split(/\s+/).filter(Boolean);
      return tokens.some((token) => ICON_TOKEN.test(token));
    });
  }

  /** 检查元素是否属于表单或提交按钮（严禁自动点击表单/测验提交） */
  function isFormOrSubmit(el) {
    if (!el || !el.tagName) return false;
    const tag = String(el.tagName).toUpperCase();
    if (tag === 'FORM') return true;
    const type = el.type || (typeof el.getAttribute === 'function' && el.getAttribute('type'));
    if (type && String(type).toLowerCase() === 'submit') return true;
    if (typeof el.getAttribute === 'function') {
      const role = el.getAttribute('role');
      if (role && String(role).toLowerCase() === 'submit') return true;
      const action = el.getAttribute('data-action');
      if (action && String(action).toLowerCase() === 'submit') return true;
    }
    if (el.form) return true;
    if (typeof el.closest === 'function') {
      try {
        if (el.closest('form')) return true;
      } catch (_) {}
    }
    let node = el.parentElement;
    while (node) {
      if (node.tagName && String(node.tagName).toUpperCase() === 'FORM') return true;
      node = node.parentElement;
    }
    return false;
  }

  /**
   * 扫描当前 document，返回按可信度降序排列的候选按钮。
   * 支持用户为特定站点配置的自定义 CSS 选择器：自定义规则优先（分值 1000），
   * 但必须继续经受反向词（“上一节/返回/重播/提交/测验”）、表单排除、禁用态和可见性的严格安全检验。
   * @param {string} [customSelector] 可选的自定义选择器（缺省自动取 settings 中的站点规则）
   * @returns {Array<{el: HTMLElement, score: number, reason: string, text: string}>}
   */
  function findCandidates(customSelector) {
    const selectorHits = collectSelectorHits();
    const results = new Map();

    const consider = (rawEl, extraScore, reason) => {
      if (!rawEl || !rawEl.tagName || rawEl === document.body || rawEl === document.documentElement) return;
      const el = closestClickable(rawEl) || rawEl;

      // 严防误触：表单或提交按钮一律排除，绝不自动提交作业/测验
      if (isFormOrSubmit(rawEl) || isFormOrSubmit(el)) return;

      // 负面词只看元素自身文字：父容器里的“上一节”按钮不该把“下一节”一起否掉
      const ownText = dom.ownTextOf(el);
      if (hasNegative(dom.normalize(ownText))) return;
      if (dom.isDisabled(el)) return;
      if (!dom.isVisible(el)) return;

      const text = dom.textOf(el);
      const normalized = dom.normalize(text);
      if (normalized.length > TEXT_LIMIT) return; // 文字太长的是容器，不是按钮

      // 自身命中用自身分数；只有“因为后代命中才被牵连进来”的元素才继承祖先链上的分数
      const ownHit = selectorHits.get(el);
      const selScore = ownHit ? ownHit.score : inheritedScore(rawEl, el, selectorHits);
      const txtScore = textScore(text);
      if (selScore === 0 && txtScore === 0 && extraScore === 0) return;

      let score = selScore + txtScore + extraScore;
      const notes = [reason, selScore ? `selector+${selScore}` : '', txtScore ? `text+${txtScore}` : ''];

      if (dom.isClickable(el)) {
        score += 6;
        notes.push('clickable+6');
      }
      if (hasNextIcon(el)) {
        score += 8;
        notes.push('icon+8');
      }

      const prev = results.get(el);
      if (!prev || score > prev.score) {
        results.set(el, { el, score, reason: notes.filter(Boolean).join(' '), text: normalized });
      }
    };

    // 0) 自定义选择器优先匹配（若配置）
    const effectiveSelector = typeof customSelector === 'string' && customSelector.trim()
      ? customSelector.trim()
      : (AutoNext.settings && typeof AutoNext.settings.customNextSelector === 'string'
        ? AutoNext.settings.customNextSelector.trim()
        : '');

    if (effectiveSelector) {
      const customMatches = safeQueryAll(effectiveSelector);
      for (const rawEl of customMatches) {
        if (!rawEl || !rawEl.tagName || rawEl === document.body || rawEl === document.documentElement) continue;
        const el = closestClickable(rawEl) || rawEl;

        // 安全底线：即使用户配置的选择器命中了表单提交控件，也坚决排除
        if (isFormOrSubmit(rawEl) || isFormOrSubmit(el)) {
          AutoNext.debug('自定义选择器命中表单提交元素，已安全排除');
          continue;
        }

        const ownText = dom.ownTextOf(el);
        // 安全底线：即使用户填的选择器命中了“上一节/返回/重播/提交/测验”，也坚决排除，绝不反向跳转
        if (hasNegative(dom.normalize(ownText))) {
          AutoNext.debug(`自定义选择器命中元素含有反向词，已安全排除：${ownText}`);
          continue;
        }
        if (dom.isDisabled(el) || !dom.isVisible(el)) continue;

        const text = dom.textOf(el);
        const normalized = dom.normalize(text);
        results.set(el, {
          el,
          score: 1000,
          reason: `自定义规则 [${effectiveSelector}]`,
          text: normalized
        });
      }
    }

    // 1) 选择器命中的元素
    for (const el of selectorHits.keys()) consider(el, 0, 'selector');

    // 2) 文本命中的元素：先看 clickable 控件，再兜底看带文字的小容器
    for (const el of safeQueryAll('a, button, [role="button"], [role="link"], li, span, div, input[type="button"]')) {
      if (!el.textContent || dom.normalize(el.textContent).length > TEXT_LIMIT) continue;
      consider(el, 0, 'text');
    }

    return Array.from(results.values()).sort((a, b) => b.score - a.score);
  }

  /**
   * 找到最可信的“下一个”按钮
   * @param {number} minScore 可信度阈值，低于该值视为“没找到”
   * @param {string} [customSelector] 可选的自定义选择器
   */
  function findNextButton(minScore = 40, customSelector) {
    const candidates = findCandidates(customSelector);
    const best = candidates[0];
    if (!best || best.score < minScore) {
      if (best) AutoNext.debug(`候选按钮可信度不足（${best.score} < ${minScore}），视为未找到`);
      return null;
    }
    return best;
  }

  /**
   * 在当前页面查找并点击；返回被点击的元素或 null
   * @param {number} minScore 可信度阈值
   * @param {string} [customSelector] 可选的自定义选择器
   */
  function clickNextButton(minScore = 40, customSelector) {
    const found = findNextButton(minScore, customSelector);
    if (!found) {
      AutoNext.warn('next lesson not found：页面里没有找到可信的“下一节 / 下一个任务点”按钮');
      AutoNext.debug('候选列表：', findCandidates(customSelector).slice(0, 8).map((c) => `${c.el.tagName}=${c.score}(${c.reason})`));
      return null;
    }
    AutoNext.log('next lesson found', found.text || '(无文字)', `score=${found.score}`, found.reason);
    AutoNext.log('navigating to next lesson', `→ 点击「${found.text || found.el.tagName}」`);
    dom.click(found.el);
    return found.el;
  }

  AutoNext.buttonFinder = { findCandidates, findNextButton, clickNextButton };

})();
