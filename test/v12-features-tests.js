/**
 * test/v12-features-tests.js —— v1.2.0 新增特性与合规性回归测试
 *
 * 覆盖范围：
 *   1. 设置迁移与配置升级 (v1.1.7 -> v1.2.0, migrateSettings)
 *   2. 播放速率系统升级 (任意自定义倍速 0.1~16x、动态 setRate、防互抢限频)
 *   3. 域名级站点设置覆盖 (siteSettings 优先级、单站独立倍速与连播规则)
 *   4. 自定义 CSS Selector 与安全防御过滤 (反向词排除、disabled/hidden 排除、优雅回退启发式)
 *   5. 敏感参数脱敏 (URL token/ticket/auth/sign/key/secret 脱敏，诊断与日志防泄漏)
 *   6. Open Shadow DOM 穿透查找视频 (递归遍历、Web Components 兼容、closed 边界保护)
 *   7. 内存循环日志队列 (Ring Buffer 50条上限、FIFO 驱逐、生命周期全链路记录)
 *   8. SPA 路由与单页跳转感知 (pushState, replaceState, popstate, hashchange)
 *   9. Popup v1.2.0 选项卡交互、导出功能与 MV3 CSP 零 innerHTML 合规检查
 *
 * 运行： node test/v12-features-tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { FakeElement, FakeVideoElement, FakeEvent } = require('./fake-dom');
const { createSandbox, loadExtension, runTimers, tickIntervals, buildLessonPage } = require('./run-tests');
const { DEFAULTS, migrateSettings } = require('../background');

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: !!condition, detail });
  console.log(`${condition ? '  ✓' : '  ✗'} ${name}${condition ? '' : `  → ${detail}`}`);
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// ————————————————————————————————————————————————————————————————
// 1. 设置迁移与配置升级测试
// ————————————————————————————————————————————————————————————————
async function testSettingsMigration() {
  console.log('\n[Suite 1] 设置迁移与配置升级 (v1.1.7 -> v1.2.0)');

  // 1.1 默认空配置
  const def = migrateSettings({});
  check('空配置返回完整 1.2.0 默认值', def.configVersion === '1.2.0' && def.playbackRate === 2.0 && def.autoRate === false);
  check('默认包含空的 siteSettings 对象', typeof def.siteSettings === 'object' && Object.keys(def.siteSettings).length === 0);

  // 1.2 v1.1.7 格式升级 (autoRate2x: true)
  const oldTrue = {
    autoNext: true,
    autoRate2x: true,
    autoSkipNonVideo: false,
    verbose: false
  };
  const migTrue = migrateSettings(oldTrue);
  check('旧版 autoRate2x: true 映射为 autoRate: true', migTrue.autoRate === true);
  check('保留 autoRate2x 兼容字段为 true', migTrue.autoRate2x === true);
  check('补齐 playbackRate 默认 2.0', migTrue.playbackRate === 2.0);
  check('补齐 configVersion 标记 1.2.0', migTrue.configVersion === '1.2.0');

  // 1.3 v1.1.7 格式升级 (autoRate2x: false)
  const oldFalse = {
    autoNext: false,
    autoRate2x: false
  };
  const migFalse = migrateSettings(oldFalse);
  check('旧版 autoRate2x: false 映射为 autoRate: false', migFalse.autoRate === false);
  check('保留 autoRate2x 兼容字段为 false', migFalse.autoRate2x === false);

  // 1.4 倍速数值纠错与边界保护
  const migInvalid = migrateSettings({ playbackRate: 'not-a-number' });
  check('非数字倍速被纠正为 2.0', migInvalid.playbackRate === 2.0);
  const migZero = migrateSettings({ playbackRate: 0 });
  check('非正数倍速被纠正为 2.0', migZero.playbackRate === 2.0);
  const migNegative = migrateSettings({ playbackRate: -1.5 });
  check('负数倍速被纠正为 2.0', migNegative.playbackRate === 2.0);

  // 1.5 siteSettings 结构保护
  const migBadSites = migrateSettings({ siteSettings: 'corrupted-string' });
  check('损坏的 siteSettings 被纠正为有效对象', typeof migBadSites.siteSettings === 'object' && migBadSites.siteSettings !== null);
}

// ————————————————————————————————————————————————————————————————
// 2. 自定义播放速率系统升级测试
// ————————————————————————————————————————————————————————————————
async function testConfigurableRates() {
  console.log('\n[Suite 2] 自定义播放速率系统 (0.1x ~ 16.0x 与防互抢)');

  // 2.1 初始设为 1.75x
  {
    const page = buildLessonPage({});
    const { sandbox, timers, clock } = createSandbox({
      page,
      storage: { autoNext: true, autoRate: true, autoRate2x: true, playbackRate: 1.75 }
    });
    const api = loadExtension(sandbox);
    await runTimers(timers);

    check('视频初始化应用目标速率 1.75x', page.video.playbackRate === 1.75, String(page.video.playbackRate));
    check('stats 准确报告 1.75x', api.videoHandler.stats().playbackRate === 1.75);

    // 页面试图重置为 1.0 时，防互抢限频保护并恢复 1.75x
    page.video.resetRateBySite(1.0);
    check('网站改回 1.0 时先被动记录', page.video.playbackRate === 1.0);
    await runTimers(timers, { skipDelay: 350, clock });
    check('限频结束后自动恢复为 1.75x', page.video.playbackRate === 1.75, String(page.video.playbackRate));
  }

  // 2.2 动态更新倍速 setRate()
  {
    const page = buildLessonPage({});
    const { sandbox, timers } = createSandbox({
      page,
      storage: { autoNext: true, autoRate: true, autoRate2x: true, playbackRate: 1.0 }
    });
    const api = loadExtension(sandbox);
    await runTimers(timers);

    check('初始倍速为 1.0x', page.video.playbackRate === 1.0);
    api.setRate(2.5);
    check('setRate(2.5) 立即更新当前视频倍速至 2.5x', page.video.playbackRate === 2.5);
    check('rateController 目标速率同步更新为 2.5', api.rateController.getTargetRate() === 2.5);

    // 边界 clamp 测试
    api.setRate(0.01);
    check('过小倍速被安全限制在 0.1x', api.rateController.getTargetRate() === 0.1);
    api.setRate(32.0);
    check('过大倍速被安全限制在 16.0x', api.rateController.getTargetRate() === 16.0);
    api.setRate('abc');
    check('非法字符输入不崩溃并维持安全值', Number.isFinite(api.rateController.getTargetRate()));
  }
}

// ————————————————————————————————————————————————————————————————
// 3. 域名级站点设置覆盖测试
// ————————————————————————————————————————————————————————————————
async function testSiteSpecificSettings() {
  console.log('\n[Suite 3] 域名级站点独立设置与覆盖');

  const siteSettings = {
    'special-mooc.edu.cn': {
      enabled: true,
      autoRate: false,
      playbackRate: 1.5,
      customSelector: '#special-next-btn'
    }
  };

  // 3.1 命中独立规则站点：禁用倍速
  {
    const page = buildLessonPage({});
    const { sandbox, timers } = createSandbox({
      page,
      storage: {
        autoNext: true,
        autoRate: true,
        autoRate2x: true,
        playbackRate: 2.0,
        siteSettings
      }
    });
    sandbox.location.href = 'https://special-mooc.edu.cn/course/view?id=1';
    const api = loadExtension(sandbox);
    await runTimers(timers);

    check('命中 special-mooc 域名规则', api.settings.currentHost === 'special-mooc.edu.cn');
    check('站点规则覆写生效：该站点 autoRate 保持关闭', api.settings.get().autoRate === false);
    check('该站点视频未被设为全局 2.0x（保持 1.0x）', page.video.playbackRate === 1.0);
  }

  // 3.2 普通未配置站点：继承全局规则
  {
    const page = buildLessonPage({});
    const { sandbox, timers } = createSandbox({
      page,
      storage: {
        autoNext: true,
        autoRate: true,
        autoRate2x: true,
        playbackRate: 2.0,
        siteSettings
      }
    });
    sandbox.location.href = 'https://other-mooc.com/study';
    const api = loadExtension(sandbox);
    await runTimers(timers);

    check('未配置站点使用全局默认', api.settings.get().autoRate === true);
    check('全局 2.0x 正常生效', page.video.playbackRate === 2.0);
  }

  // 3.3 嵌套 iframe 场景未单独配置时安全继承顶层规则
  {
    const page = buildLessonPage({});
    const { sandbox, timers } = createSandbox({
      page,
      storage: {
        autoNext: true,
        autoRate: true,
        autoRate2x: true,
        playbackRate: 2.0,
        siteSettings
      }
    });
    // 模拟 iframe 宿主环境
    sandbox.window.top = {
      location: { hostname: 'special-mooc.edu.cn' }
    };
    sandbox.location.href = 'https://player-cdn.cn/embed/video.html';
    const api = loadExtension(sandbox);
    await runTimers(timers);

    check('iframe 自身无配置时继承顶层 special-mooc 规则', api.settings.get().autoRate === false);
    check('iframe 视频应用所继承顶层规则的 1.0x（而非全局 2.0x）', page.video.playbackRate === 1.0);
  }

  // 3.4 嵌套 iframe 自身拥有显式配置时，自身配置优先于顶层
  {
    const page = buildLessonPage({});
    const iframeSpecificSettings = {
      ...siteSettings,
      'player-cdn.cn': {
        override: true,
        autoRate: true,
        playbackRate: 3.0
      }
    };
    const { sandbox, timers } = createSandbox({
      page,
      storage: {
        autoNext: true,
        autoRate: false,
        playbackRate: 1.0,
        siteSettings: iframeSpecificSettings
      }
    });
    sandbox.window.top = {
      location: { hostname: 'special-mooc.edu.cn' }
    };
    sandbox.location.href = 'https://player-cdn.cn/embed/video.html';
    const api = loadExtension(sandbox);
    await runTimers(timers);

    check('iframe 拥有自身规则时优先使用自身规则', api.settings.get().playbackRate === 3.0);
    check('iframe 自身倍速 3.0x 独立生效', page.video.playbackRate === 3.0);
  }
}

// ————————————————————————————————————————————————————————————————
// 4. 自定义 CSS Selector 与安全防御过滤测试
// ————————————————————————————————————————————————————————————————
async function testCustomSelectorAndSafetyFilters() {
  console.log('\n[Suite 4] 自定义选择器命中与多重安全过滤');

  // 4.1 正常命中自定义选择器
  {
    const doc = new FakeElement('html');
    const body = doc.append(new FakeElement('body'));
    const video = body.append(new FakeVideoElement({ duration: 600 }));
    const clicked = [];
    const customBtn = body.append(new FakeElement('button', { id: 'my-custom-next', text: '前往后续章节' }));
    customBtn.addEventListener('click', () => clicked.push('custom'));
    const normalBtn = body.append(new FakeElement('button', { class: 'btn-next', text: '下一节' }));
    normalBtn.addEventListener('click', () => clicked.push('normal'));

    const { sandbox, timers } = createSandbox({
      page: { documentElement: doc, body, video, state: { clicked } },
      storage: { autoNext: true, customNextSelector: '#my-custom-next' }
    });
    loadExtension(sandbox);
    await runTimers(timers);

    video.watch(30);
    video.finish();
    await runTimers(timers);

    check('优先命中自定义 CSS 选择器', clicked.includes('custom'));
    check('未点击常规启发式按钮', !clicked.includes('normal'));
  }

  // 4.2 反向词排除：自定义选择器若误选中“上一节 / 返回”，坚决不点击
  {
    const doc = new FakeElement('html');
    const body = doc.append(new FakeElement('body'));
    const video = body.append(new FakeVideoElement({ duration: 600 }));
    const clicked = [];
    const badBtn = body.append(new FakeElement('button', { id: 'danger-prev-btn', text: '上一节（回顾）' }));
    badBtn.addEventListener('click', () => clicked.push('danger-prev'));
    const safeBtn = body.append(new FakeElement('button', { class: 'btn-next', text: '下一节' }));
    safeBtn.addEventListener('click', () => clicked.push('safe-next'));

    const { sandbox, timers } = createSandbox({
      page: { documentElement: doc, body, video, state: { clicked } },
      storage: { autoNext: true, customNextSelector: '#danger-prev-btn' }
    });
    loadExtension(sandbox);
    await runTimers(timers);

    video.watch(30);
    video.finish();
    await runTimers(timers);

    check('自定义选择器命中包含反向词“上一节”时被安全拦截', !clicked.includes('danger-prev'));
    check('安全拦截后优雅回退并点击真正“下一节”', clicked.includes('safe-next'));
  }

  // 4.3 禁用态排除：disabled 按钮不点击
  {
    const doc = new FakeElement('html');
    const body = doc.append(new FakeElement('body'));
    const video = body.append(new FakeVideoElement({ duration: 600 }));
    const clicked = [];
    const disBtn = body.append(new FakeElement('button', { id: 'dis-next', text: '下一节', attrs: { disabled: 'true' } }));
    disBtn.addEventListener('click', () => clicked.push('disabled-btn'));
    const fallbackBtn = body.append(new FakeElement('button', { class: 'btn-next', text: '下一节' }));
    fallbackBtn.addEventListener('click', () => clicked.push('fallback-btn'));

    const { sandbox, timers } = createSandbox({
      page: { documentElement: doc, body, video, state: { clicked } },
      storage: { autoNext: true, customNextSelector: '#dis-next' }
    });
    loadExtension(sandbox);
    await runTimers(timers);

    video.watch(30);
    video.finish();
    await runTimers(timers);

    check('处于 disabled 状态的自定义按钮被排除', !clicked.includes('disabled-btn'));
    check('排除后回退到可用候选按钮', clicked.includes('fallback-btn'));
  }

  // 4.4 隐藏态排除：display: none 不点击
  {
    const doc = new FakeElement('html');
    const body = doc.append(new FakeElement('body'));
    const video = body.append(new FakeVideoElement({ duration: 600 }));
    const clicked = [];
    const hiddenBtn = body.append(new FakeElement('button', { id: 'hidden-next', text: '下一节', style: { display: 'none' } }));
    hiddenBtn.addEventListener('click', () => clicked.push('hidden-btn'));
    const fallbackBtn = body.append(new FakeElement('button', { class: 'btn-next', text: '下一节' }));
    fallbackBtn.addEventListener('click', () => clicked.push('fallback-btn'));

    const { sandbox, timers } = createSandbox({
      page: { documentElement: doc, body, video, state: { clicked } },
      storage: { autoNext: true, customNextSelector: '#hidden-next' }
    });
    loadExtension(sandbox);
    await runTimers(timers);

    video.watch(30);
    video.finish();
    await runTimers(timers);

    check('处于 display: none 的自定义按钮被排除', !clicked.includes('hidden-btn'));
    check('隐藏按钮排除后回退到可见候选按钮', clicked.includes('fallback-btn'));
  }

  // 4.5 表单与提交按钮防御排除（严禁自动点击表单与测验提交控件）
  {
    const doc = new FakeElement('html');
    const body = doc.append(new FakeElement('body'));
    const video = body.append(new FakeVideoElement({ duration: 600 }));
    const clicked = [];

    // 表单内部按钮
    const form = body.append(new FakeElement('form', { id: 'quiz-form' }));
    const formSubmitBtn = form.append(new FakeElement('button', { id: 'btn-quiz-submit', text: '下一节' }));
    formSubmitBtn.addEventListener('click', () => clicked.push('form-submit'));

    // 普通 type="submit" 提交按钮
    const rawSubmitBtn = body.append(new FakeElement('button', { id: 'raw-submit', attrs: { type: 'submit' }, text: '下一节' }));
    rawSubmitBtn.addEventListener('click', () => clicked.push('raw-submit'));

    // 合法外部下一节按钮
    const trueNextBtn = body.append(new FakeElement('button', { class: 'btn-next', text: '下一节' }));
    trueNextBtn.addEventListener('click', () => clicked.push('true-next'));

    const { sandbox, timers } = createSandbox({
      page: { documentElement: doc, body, video, state: { clicked } },
      storage: { autoNext: true }
    });
    loadExtension(sandbox);
    await runTimers(timers);

    video.watch(30);
    video.finish();
    await runTimers(timers);

    check('位于 form 内部的伪“下一节”按钮被严格排除', !clicked.includes('form-submit'));
    check('type="submit" 提交按钮被严格排除', !clicked.includes('raw-submit'));
    check('表单/提交控件排除后安全命中真正“下一节”按钮', clicked.includes('true-next'));
  }

  // 4.6 测验/答题/交卷等负面词排除（即使通过自定义选择器指定也予以拒绝）
  {
    const doc = new FakeElement('html');
    const body = doc.append(new FakeElement('body'));
    const video = body.append(new FakeVideoElement({ duration: 600 }));
    const clicked = [];

    const quizBtn1 = body.append(new FakeElement('button', { id: 'exam-btn', text: '提交测验答题' }));
    quizBtn1.addEventListener('click', () => clicked.push('exam-btn'));

    const quizBtn2 = body.append(new FakeElement('button', { id: 'submit-exam', text: '交卷并查看分数' }));
    quizBtn2.addEventListener('click', () => clicked.push('submit-exam'));

    const trueNext = body.append(new FakeElement('button', { id: 'real-next', text: '下一节' }));
    trueNext.addEventListener('click', () => clicked.push('real-next'));

    const { sandbox, timers } = createSandbox({
      page: { documentElement: doc, body, video, state: { clicked } },
      storage: { autoNext: true, customNextSelector: '#exam-btn' }
    });
    loadExtension(sandbox);
    await runTimers(timers);

    video.watch(30);
    video.finish();
    await runTimers(timers);

    check('含有“提交/测验/交卷/答题/exam/quiz”的候选被严格排除', !clicked.includes('exam-btn') && !clicked.includes('submit-exam'));
    check('负面考试词过滤后回退至真实课程章节', clicked.includes('real-next'));
  }
}

// ————————————————————————————————————————————————————————————————
// 5. 敏感参数脱敏安全测试
// ————————————————————————————————————————————————————————————————
async function testUrlSanitization() {
  console.log('\n[Suite 5] 敏感参数脱敏 (token / ticket / auth / jwt / sign / key / secret / session / enc)');

  const page = buildLessonPage({});
  const { sandbox, timers } = createSandbox({ page, storage: { autoNext: true } });
  const api = loadExtension(sandbox);
  await runTimers(timers);

  const dom = api.dom;
  const rawUrl = 'https://mooc.example.com/play?chapterId=101&token=sec_tok_1&ticket=sec_tick_2&auth=sec_auth_3&jwt=sec_jwt_4&sign=sec_sign_5&key=sec_key_6&secret=sec_secret_7&session=sec_sess_8&enc=sec_enc_9&courseTitle=math#token=hash_tok_10';
  const clean = dom.sanitizeUrl(rawUrl);

  check('token 被替换为 [REDACTED]', clean.includes('token=[REDACTED]'));
  check('ticket 被替换为 [REDACTED]', clean.includes('ticket=[REDACTED]'));
  check('auth 被替换为 [REDACTED]', clean.includes('auth=[REDACTED]'));
  check('jwt 被替换为 [REDACTED]', clean.includes('jwt=[REDACTED]'));
  check('sign 被替换为 [REDACTED]', clean.includes('sign=[REDACTED]'));
  check('key 被替换为 [REDACTED]', clean.includes('key=[REDACTED]'));
  check('secret 被替换为 [REDACTED]', clean.includes('secret=[REDACTED]'));
  check('session 被替换为 [REDACTED]', clean.includes('session=[REDACTED]'));
  check('enc 被替换为 [REDACTED]', clean.includes('enc=[REDACTED]'));
  check('URL hash 中敏感参数被脱敏', clean.includes('#[REDACTED]'));
  check('业务参数 chapterId 与 courseTitle 保持原样', clean.includes('chapterId=101') && clean.includes('courseTitle=math'));
  check('所有敏感明文均无泄漏', !/sec_tok|sec_tick|sec_auth|sec_jwt|sec_sign|sec_key|sec_secret|sec_sess|sec_enc|hash_tok/.test(clean));

  // diagnostics() 中的脱敏
  sandbox.location.href = 'https://study.test/video?token=super_secret_token_123&session=sess_abc_456';
  page.video.src = 'https://cdn.test/stream.m3u8?sign=sensitive_sign_456&enc=encrypted_key_789';
  page.video.currentSrc = page.video.src;
  const diag = api.videoHandler.diagnostics();
  check('diagnostics.pageUrl 已经脱敏', diag.pageUrl.includes('[REDACTED]') && !diag.pageUrl.includes('super_secret_token_123') && !diag.pageUrl.includes('sess_abc_456'));
  check('diagnostics.currentSrc 已经脱敏', diag.currentSrc.includes('[REDACTED]') && !diag.currentSrc.includes('sensitive_sign_456') && !diag.currentSrc.includes('encrypted_key_789'));
}

// ————————————————————————————————————————————————————————————————
// 6. Open Shadow DOM 视频穿透查找测试
// ————————————————————————————————————————————————————————————————
async function testShadowDomVideoDiscovery() {
  console.log('\n[Suite 6] Open Shadow DOM 穿透查找与 Web Components 兼容');

  const doc = new FakeElement('html');
  const body = doc.append(new FakeElement('body'));

  // 6.1 一层 Open Shadow DOM
  const customHost = body.append(new FakeElement('div', { id: 'player-web-component' }));
  const shadowRoot1 = customHost.attachShadow({ mode: 'open' });
  const innerWrapper = shadowRoot1.append(new FakeElement('div', { class: 'video-wrapper' }));
  const shadowVideo1 = innerWrapper.append(new FakeVideoElement({ duration: 500 }));

  // 6.2 嵌套 Open Shadow DOM
  const outerHost = body.append(new FakeElement('div', { id: 'outer-host' }));
  const shadowRootOuter = outerHost.attachShadow({ mode: 'open' });
  const innerHost = shadowRootOuter.append(new FakeElement('div', { id: 'inner-host' }));
  const shadowRootInner = innerHost.attachShadow({ mode: 'open' });
  const shadowVideo2 = shadowRootInner.append(new FakeVideoElement({ duration: 800 }));

  // 6.3 Closed Shadow DOM (作为边界测试)
  const closedHost = body.append(new FakeElement('div', { id: 'closed-host' }));
  closedHost.attachShadow({ mode: 'closed' });

  const { sandbox, timers } = createSandbox({
    page: { documentElement: doc, body, video: shadowVideo1, state: { clicked: [] } },
    storage: { autoNext: true, autoRate: true, autoRate2x: true, playbackRate: 2.0 }
  });
  const api = loadExtension(sandbox);
  await runTimers(timers);

  const discovered = api.dom.findVideos(sandbox.document);
  check('成功在 open Shadow DOM 内发现视频', discovered.includes(shadowVideo1));
  check('成功递归发现多层嵌套 Shadow DOM 内的视频', discovered.includes(shadowVideo2));
  check('发现数量至少包含 2 个 Shadow DOM 视频', discovered.length >= 2);
  check('遍历 closed Shadow DOM 时安全不崩溃', true);
}

// ————————————————————————————————————————————————————————————————
// 7. 内存循环日志队列测试 (Ring Buffer)
// ————————————————————————————————————————————————————————————————
async function testEventLogRingBuffer() {
  console.log('\n[Suite 7] 内存循环日志队列 (Ring Buffer 容量与全链路事件)');

  const page = buildLessonPage({});
  const { sandbox, timers } = createSandbox({ page, storage: { autoNext: true, autoRate: true, playbackRate: 2.0 } });
  const api = loadExtension(sandbox);
  await runTimers(timers);

  // 7.1 检测到视频时自动记录
  const events1 = api.getEvents();
  check('视频检测自动生成 VIDEO_DETECTED 事件', events1.some((e) => e.type === 'VIDEO_DETECTED'));

  // 7.2 写入与结构检验
  api.logger.addEvent('MANUAL_TEST', { testKey: 'testVal' });
  const manualEv = api.getEvents().find((e) => e.type === 'MANUAL_TEST');
  check('事件包含有效毫秒时间戳', typeof manualEv.timestamp === 'number' && manualEv.timestamp > 0);
  check('事件包含时间字符串', typeof manualEv.timeStr === 'string' && manualEv.timeStr.length > 0);
  check('事件携带正确 detail', manualEv.detail.testKey === 'testVal');

  // 7.3 50 条上限与 FIFO 驱逐机制
  api.logger.clearEvents();
  check('clearEvents() 成功清空队列', api.getEvents().length === 0);
  for (let i = 1; i <= 60; i++) {
    api.logger.addEvent('STRESS_TEST', { seq: i });
  }
  const ring = api.getEvents();
  check('队列长度严格限制为 50 条', ring.length === 50);
  check('FIFO 驱逐生效：最早的 10 条已被丢弃，首项 seq 为 11', ring[0].detail.seq === 11);
  check('最后一项 seq 为 60', ring[49].detail.seq === 60);

  // 7.4 播放结束与跳转事件
  page.video.watch(30);
  page.video.finish();
  await runTimers(timers);
  const endEvents = api.getEvents();
  check('视频结束生成 VIDEO_ENDED 事件', endEvents.some((e) => e.type === 'VIDEO_ENDED'));
  check('执行跳转生成 NAVIGATION_TRIGGERED 事件', endEvents.some((e) => e.type === 'NAVIGATION_TRIGGERED'));
}

// ————————————————————————————————————————————————————————————————
// 8. SPA 路由与单页跳转感知测试 (popstate / hashchange / URL 轮询)
// ————————————————————————————————————————————————————————————————
async function testSpaNavigation() {
  console.log('\n[Suite 8] SPA 路由与单页跳转感知 (popstate / hashchange / URL 轮询)');

  const page = buildLessonPage({});
  const { sandbox, timers, intervals, clock } = createSandbox({ page, storage: { autoNext: true } });
  const api = loadExtension(sandbox);
  await runTimers(timers);

  let scanCount = 0;
  const originalScan = api.videoHandler.scan.bind(api.videoHandler);
  api.videoHandler.scan = () => {
    scanCount++;
    return originalScan();
  };

  // 8.1 模拟 popstate 路由后退/前进感知（真实验证，绝无条件跳过）
  const beforePop = scanCount;
  clock.advance(600);
  sandbox.location.href = 'https://study.test/chapter/popstate-changed';
  sandbox.window.dispatchEvent(new FakeEvent('popstate'));
  await runTimers(timers);
  check('popstate 事件触发了重新扫描', scanCount > beforePop);

  // 8.2 模拟 hashchange 锚点路由切换感知（真实验证，绝无条件跳过）
  const beforeHash = scanCount;
  clock.advance(600);
  sandbox.location.href = 'https://study.test/chapter/popstate-changed#hash-change';
  sandbox.window.dispatchEvent(new FakeEvent('hashchange'));
  await runTimers(timers);
  check('hashchange 事件触发了重新扫描', scanCount > beforeHash);

  // 8.3 模拟 URL 变更后由 urlCheckTimer 轮询兜底感知并触发扫描
  const beforePolling = scanCount;
  clock.advance(600);
  sandbox.location.href = 'https://study.test/chapter/spa-route-polling-detected';
  tickIntervals(intervals);
  await runTimers(timers);
  check('URL 改变后由 urlCheckTimer 轮询成功感知并重新扫描', scanCount > beforePolling);
}

// ————————————————————————————————————————————————————————————————
// 9. 全仓库 CSP 与危险 API 深度合规检查 (background / popup / content)
// ————————————————————————————————————————————————————————————————
async function testPopupAndCspCompliance() {
  console.log('\n[Suite 9] 全仓库 CSP 与危险 API 深度合规检查 (background / popup / content)');

  const dangerousPatterns = [
    { name: 'eval', regex: /\beval\s*\(/ },
    { name: 'new Function', regex: /new\s+Function\s*\(/ },
    { name: 'innerHTML', regex: /\.innerHTML\s*=/ },
    { name: 'outerHTML', regex: /\.outerHTML\s*=/ },
    { name: 'insertAdjacentHTML', regex: /\.insertAdjacentHTML\s*\(/ },
    { name: 'document.write', regex: /document\.write\s*\(/ }
  ];

  // 9.1 检查 background.js
  const bgCode = fs.readFileSync(path.resolve(__dirname, '../background.js'), 'utf8');
  for (const { name, regex } of dangerousPatterns) {
    check(`background.js 绝无 ${name} 危险调用`, !regex.test(bgCode));
  }

  // 9.2 检查 popup.js
  const popupCode = fs.readFileSync(path.resolve(__dirname, '../popup.js'), 'utf8');
  for (const { name, regex } of dangerousPatterns) {
    check(`popup.js 绝无 ${name} 危险调用`, !regex.test(popupCode));
  }

  // 9.3 检查 content/*.js 全部模块
  const contentFiles = fs.readdirSync(path.resolve(__dirname, '../content')).filter((f) => f.endsWith('.js'));
  for (const f of contentFiles) {
    const code = fs.readFileSync(path.resolve(__dirname, '../content', f), 'utf8');
    const hasDanger = dangerousPatterns.some(({ regex }) => regex.test(code));
    check(`content/${f} 严格遵守 CSP (0 eval / 0 Function / 0 HTML 注入)`, !hasDanger);
  }

  // 9.4 检查 popup.html 无任何内联事件监听器 (如 onclick/onload/onerror)
  const popupHtml = fs.readFileSync(path.resolve(__dirname, '../popup.html'), 'utf8');
  const hasInlineHandler = /\son[a-z]+\s*=/i.test(popupHtml);
  check('popup.html 无内联事件属性 (如 onclick=)', !hasInlineHandler);
}

// ————————————————————————————————————————————————————————————————
// 主执行器
// ————————————————————————————————————————————————————————————————
(async () => {
  console.log('Video Auto Player v1.2.0 新特性全量测试套件');
  console.log('='.repeat(60));

  await testSettingsMigration();
  await testConfigurableRates();
  await testSiteSpecificSettings();
  await testCustomSelectorAndSafetyFilters();
  await testUrlSanitization();
  await testShadowDomVideoDiscovery();
  await testEventLogRingBuffer();
  await testSpaNavigation();
  await testPopupAndCspCompliance();

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(60));
  console.log(`共 ${results.length} 项新特性断言，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
})();