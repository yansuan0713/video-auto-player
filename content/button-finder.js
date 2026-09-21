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
    // —— 超星同章节多任务点 (Tab 选项卡与卡片，必须优先于跨章节跳转) ——
    ['[id^="dct"].currents + [id^="dct"]', 200],
    ['[id^="dct"].active + [id^="dct"]', 200],
    ['.tabtags .currents + span', 200],
    ['.tabtags .active + span', 200],
    ['.tabtags .currents + li', 200],
    ['.tabtags .active + li', 200],
    ['.tabtags .currents + a', 200],
    ['.tabtags .active + a', 200],
    ['.tabtags span.currents ~ span:not(.currents):not(.active)', 190],
    ['.tabtags li.currents ~ li:not(.currents):not(.active)', 190],
    ['[id^="dct"].currents ~ [id^="dct"]:not(.currents):not(.active)', 190],

    // —— 超星学习通常见跨章节结构（由具体到通用） ——
    ['#prevNextFocusNext', 100],
    ['#nextBtn', 96],
    ['.prev_next.next', 88],
    ['a[onclick*="getTeacherAjax"][onclick*="next"]', 86],
    ['#prevNextNext', 86],

    // —— 目录树下一个小节（当独立下一节按钮隐藏/改版时兜底） ——
    ['.posCatalog_select + li a', 85],
    ['.posCatalog_select + li .posCatalog_name', 85],
    ['.posCatalog_select + div a', 85],
    ['.posCatalog_select + div .posCatalog_name', 85],
    ['.posCatalog_select ~ li:not(.posCatalog_select) a', 82],
    ['.posCatalog_select ~ div:not(.posCatalog_select) a', 82],

    // —— 通用命名（class / id / 属性里带 next 的控件） ——
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

  /** 严格反向与提交词：出现即一票否决（无论是否带“下一”） */
  const STRICT_NEGATIVE = [
    '上一节', '上一章', '上一个', '上一页', '返回', 'back', 'prev', 'previous', 'replay', '重播', '重看',
    '提交', '交卷', '交作业', '交答卷', '提交测验', '提交考试', '提交作业', '提交答案', '提交答题',
    '开始答题', '开始测验', '开始考试', '查看分数', '确认提交', 'submit', 'handin'
  ];

  /** 测验/试卷类词汇：仅当元素不具备明确前进语义时予以排除（防止误点测验内部控件，但放行“下一节：章节测验”） */
  const QUIZ_WORDS = ['测验', '考试', 'quiz', 'exam', '答题'];

  /** 前进方向语义词 */
  const FORWARD_WORDS = [
    '下一节', '下一章', '下一个', '下一任务点', '下一课', '下一讲', '下一集', '下一视频', 'next'
  ];

  function isForwardNav(text) {
    const lower = String(text || '').toLowerCase();
    return FORWARD_WORDS.some((word) => lower.includes(word));
  }

  const TEXT_LIMIT = 60; // 文本太长基本是容器，不是按钮

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
    const lower = String(text || '').toLowerCase();
    if (STRICT_NEGATIVE.some((word) => lower.includes(word))) {
      return true;
    }
    // 包含测验/考试/答题词汇时：
    // 若同时包含明确的前进导航词（如“下一节：章节测验”、“下一章 单元测试”），说明是通向下节测验的合法导航，不予拦截；
    // 反之，若不含前进词（如“测验”、“随堂测试”、“答题”），则属于测验界面内控件，坚决排除。
    if (QUIZ_WORDS.some((word) => lower.includes(word))) {
      return !isForwardNav(lower);
    }
    return false;
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

  /**
   * 检查元素是否属于表单提交控件（严禁自动点击表单/测验提交）
   *
   * 依据元素自身的明确提交语义判定（type="submit"、role="submit"、data-action="submit" 等），
   * 绝不仅因 element.form 存在就误杀正常的包裹于 form 内的下一节按钮。
   * 测验/交卷/答题类误触由反向负面词（STRICT_NEGATIVE、QUIZ_WORDS）与提交语义共同严密兜底。
   */
  function isFormOrSubmit(el) {
    if (!el || !el.tagName) return false;
    const tag = String(el.tagName).toUpperCase();
    if (tag === 'FORM') return true;
    const typeAttr = typeof el.getAttribute === 'function' ? el.getAttribute('type') : null;
    if (typeAttr && String(typeAttr).toLowerCase() === 'submit') return true;
    if (tag === 'INPUT') {
      const itype = String(typeAttr || el.type || '').toLowerCase();
      if (!['button'].includes(itype)) return true;
    }
    if (typeof el.getAttribute === 'function') {
      const role = el.getAttribute('role');
      if (role && String(role).toLowerCase() === 'submit') return true;
      const action = el.getAttribute('data-action');
      if (action && String(action).toLowerCase() === 'submit') return true;
    }
    return false;
  }

  /**
   * 超星学习通专用：从 #coursetree / .course_tree / .posCatalog_box 目录树中
   * 严格按顺序寻找当前激活小节的下一个小节 (currentIndex + 1)
   */
  function findChaoxingNextCatalogItem() {
    const tree = document.querySelector('#coursetree, .course_tree, .posCatalog_box');
    if (!tree) return null;

    // 查找所有可选小节条目（排除第一级章标题 .firstLayer）
    let items = safeQueryAll('#coursetree .posCatalog_select:not(.firstLayer), .course_tree .posCatalog_select:not(.firstLayer), .posCatalog_box .posCatalog_select:not(.firstLayer)');
    if (!items.length) {
      items = safeQueryAll('#coursetree .posCatalog_select, .course_tree .posCatalog_select, .posCatalog_box .posCatalog_select, #coursetree [id^="cur"], .course_tree [id^="cur"]');
    }
    if (!items.length) return null;

    // 定位当前激活项索引
    const activeIndex = items.findIndex((el) =>
      el.classList.contains('posCatalog_active') ||
      el.classList.contains('active') ||
      (el.querySelector && el.querySelector('.posCatalog_active, .active')) !== null
    );

    // 未找到激活项，或者已到最后一项，无法继续前进
    if (activeIndex === -1 || activeIndex >= items.length - 1) {
      return null;
    }

    // 严格按索引顺序取下一个小节 (currentIndex + 1)
    const nextItem = items[activeIndex + 1];
    if (!nextItem) return null;

    // 严禁点击当前 active 项自身或包含 active 类名的节点
    if (nextItem === items[activeIndex] || nextItem.classList.contains('posCatalog_active')) {
      return null;
    }

    // 选取条目内最精确的可点击目标（子级 a、posCatalog_name、可点击控件，或条目自身）
    const clickableChild = nextItem.querySelector('a, [onclick], [role="button"], button');
    const nameSpan = nextItem.querySelector('.posCatalog_name, .posCatalog_select_name, .title');
    const targetEl = clickableChild || nameSpan || nextItem;

    if (dom.isDisabled(targetEl) || !dom.isVisible(targetEl)) return null;

    const rawText = dom.textOf(targetEl) || dom.textOf(nextItem);
    const normalized = dom.normalize(rawText);
    if (hasNegative(normalized)) return null;

    return {
      el: targetEl,
      score: 95,
      reason: 'chaoxing-coursetree-next+95',
      text: normalized
    };
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

    // 2) 超星目录树专用结构识别（按顺序寻找当前激活项的下一小节）
    const coursetreeCandidate = findChaoxingNextCatalogItem();
    if (coursetreeCandidate && coursetreeCandidate.el) {
      consider(coursetreeCandidate.el, 95, 'chaoxing-coursetree');
    }

    // 3) 文本命中的元素：先看 clickable 控件，再兜底看带文字的小容器
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
   * @param {Set<HTMLElement>} [excludeSet] 可选的排除集合（用于跳过之前点击未生效的元素）
   */
  function findNextButton(minScore = 40, customSelector, excludeSet) {
    const candidates = findCandidates(customSelector);
    const valid = excludeSet ? candidates.filter((c) => !excludeSet.has(c.el)) : candidates;
    const best = valid[0];
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
   * @param {Set<HTMLElement>} [excludeSet] 可选的排除集合
   */
  function clickNextButton(minScore = 40, customSelector, excludeSet) {
    const found = findNextButton(minScore, customSelector, excludeSet);
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

  AutoNext.buttonFinder = {
    findCandidates,
    findNextButton,
    clickNextButton,
    findChaoxingNextCatalogItem
  };

})();
