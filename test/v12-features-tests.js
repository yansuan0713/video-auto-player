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

  // 4.x 回归：整页被 <form> 包裹（ASP.NET WebForms 风格）时，合法的“下一节”仍须可识别。
  //     曾经的实现用 closest('form') 沿祖先链排除，会把这类页面的所有按钮一并否掉。
  {
    const doc = new FakeElement('html');
    const body = doc.append(new FakeElement('body'));
    // 关键：form 包住整个 body 内容
    const formWrapper = body.append(new FakeElement('form', { id: 'aspnet-form', attrs: { runat: 'server' } }));
    const video = formWrapper.append(new FakeVideoElement({ duration: 600 }));
    const clicked = [];

    const nav = formWrapper.append(new FakeElement('div', { class: 'prev_next' }));
    const nextLink = nav.append(new FakeElement('a', {
      id: 'prevNextFocusNext',
      class: 'prev_next next',
      text: '下一节'
    }));
    nextLink.addEventListener('click', () => clicked.push('wrapped-next'));

    // 关键：同一 form 内同时存在 type="submit" 提交按钮与“提交测验”按钮，必须被严格排除
    const submitBtn = formWrapper.append(new FakeElement('button', {
      id: 'aspnet-submit',
      attrs: { type: 'submit' },
      text: '下一节'
    }));
    submitBtn.addEventListener('click', () => clicked.push('aspnet-submit'));

    const quizBtn = formWrapper.append(new FakeElement('button', {
      id: 'quiz-submit',
      text: '提交测验'
    }));
    quizBtn.addEventListener('click', () => clicked.push('quiz-submit'));

    const { sandbox, timers } = createSandbox({
      page: { documentElement: doc, body, video, state: { clicked } },
      storage: { autoNext: true }
    });
    const api = loadExtension(sandbox);
    await runTimers(timers);

    check('整页 form 包裹时仍能识别到“下一节”候选', api.buttonFinder.findCandidates().length > 0,
      String(api.buttonFinder.findCandidates().length));

    video.watch(30);
    video.finish();
    await runTimers(timers);
    check('整页 form 包裹时仍能点击“下一节”', clicked.includes('wrapped-next'), JSON.stringify(clicked));
    check('同一 form 内的 type="submit" 按钮必须被排除', !clicked.includes('aspnet-submit'), JSON.stringify(clicked));
    check('同一 form 内的“提交测验”按钮必须被排除', !clicked.includes('quiz-submit'), JSON.stringify(clicked));
  }

  // 4.y 安全底线不回退：form 内的提交控件与带提交语义的按钮仍须排除
  {
    const doc = new FakeElement('html');
    const body = doc.append(new FakeElement('body'));
    const video = body.append(new FakeVideoElement({ duration: 600 }));
    const clicked = [];

    const form = body.append(new FakeElement('form', { id: 'quiz-form' }));
    const submitControl = form.append(new FakeElement('button', {
      id: 'form-submit-control',
      attrs: { type: 'submit' },
      text: '下一节'
    }));
    submitControl.addEventListener('click', () => clicked.push('submit-control'));

    const roleSubmit = body.append(new FakeElement('div', {
      id: 'role-submit',
      attrs: { role: 'submit' },
      text: '下一节'
    }));
    roleSubmit.addEventListener('click', () => clicked.push('role-submit'));

    const dataSubmit = body.append(new FakeElement('div', {
      id: 'data-submit',
      attrs: { 'data-action': 'submit' },
      text: '下一节'
    }));
    dataSubmit.addEventListener('click', () => clicked.push('data-submit'));

    const okNext = body.append(new FakeElement('button', { id: 'plain-next', class: 'btn-next', text: '下一节' }));
    okNext.addEventListener('click', () => clicked.push('plain-next'));

    const { sandbox, timers } = createSandbox({
      page: { documentElement: doc, body, video, state: { clicked } },
      storage: { autoNext: true }
    });
    loadExtension(sandbox);
    await runTimers(timers);

    video.watch(30);
    video.finish();
    await runTimers(timers);

    check('type=submit 表单控件仍被排除', !clicked.includes('submit-control'));
    check('role=submit 仍被排除', !clicked.includes('role-submit'));
    check('data-action=submit 仍被排除', !clicked.includes('data-submit'));
    check('同页普通“下一节”按钮仍可命中', clicked.includes('plain-next'), JSON.stringify(clicked));
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

  // 5.1 回归：CDN 签名 at_ / 简写 sig / 云厂商 credential 必须脱敏
  const cdnUrl = 'https://s2.cldisk.com/w7/video/sd.mp4?at_=1789537022&sig=abc123sig&X-Amz-Credential=AKIAEXAMPLE&chapterId=42';
  const cleanCdn = dom.sanitizeUrl(cdnUrl);
  check('at_ (CDN 签名) 被替换为 [REDACTED]', cleanCdn.includes('at_=[REDACTED]'));
  check('sig (签名简写) 被替换为 [REDACTED]', cleanCdn.includes('sig=[REDACTED]'));
  check('X-Amz-Credential 被替换为 [REDACTED]', cleanCdn.includes('Credential=[REDACTED]'));
  check('at_/sig/credential 明文均无泄漏', !/1789537022|abc123sig|AKIAEXAMPLE/.test(cleanCdn));
  check('同一 URL 中的业务参数 chapterId 保持原样', cleanCdn.includes('chapterId=42'));

  // 5.2 回归：hash 中的 at_ / sig / credential 也要脱敏
  const hashUrl = 'https://a.test/x?chapterId=7#at_=9999&sig=hashsig&credential=hashcred';
  const cleanHash = dom.sanitizeUrl(hashUrl);
  check('hash 含 at_/sig/credential 时整体替换为 #[REDACTED]', cleanHash.includes('#[REDACTED]'));
  check('hash 中签名明文无泄漏', !/9999|hashsig|hashcred/.test(cleanHash));

  // 5.3 反向保护：精确键匹配不得误伤只"看起来像"的普通参数（query 和 hash 中均不得误伤 format_ / signal）
  const safeUrl = 'https://a.test/x?design=modern&signal=weak&format_=mp4&chapterId=8&courseTitle=math#format_=mp4&signal=weak';
  const cleanSafe = dom.sanitizeUrl(safeUrl);
  check('design/signal/format_ 等普通参数在 query 与 hash 中均不被误伤',
    cleanSafe.includes('design=modern') && cleanSafe.includes('signal=weak') && cleanSafe.includes('format_=mp4') && cleanSafe.includes('#format_=mp4&signal=weak'),
    cleanSafe);
  check('普通业务参数 chapterId/courseTitle 保持原样',
    cleanSafe.includes('chapterId=8') && cleanSafe.includes('courseTitle=math'),
    cleanSafe);

  // 5.4 popup 侧的内联 sanitizeUrl 必须与 content 侧键集合一致
  const popupCode = fs.readFileSync(path.resolve(__dirname, '../popup.js'), 'utf8');
  check('popup.js 内联 sanitizeUrl 已同步 at_/sig/credential',
    popupCode.includes('at_') && popupCode.includes('credential') && /\bsig\b/.test(popupCode));
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
// 10. 启停生命周期：重复启用不得叠加定时器
// ————————————————————————————————————————————————————————————————

/** 统计某个 frame 中"仍在运行"的 interval（cancelled 为 false 的） */
function activeIntervals(box) {
  return box.intervals.filter((it) => !it.cancelled);
}

async function testEnableDisableLifecycle() {
  console.log('\n[Suite 10] 启停生命周期与重复定时器保护');

  // 10.1 enable → enable：不得叠加 URL 轮询定时器
  {
    const page = buildLessonPage({});
    const box = createSandbox({ page, storage: { autoNext: true } });
    loadExtension(box.sandbox);
    await runTimers(box.timers);

    const baseline = activeIntervals(box).length;
    const pollBefore = activeIntervals(box).filter((it) => it.ms === 5000).length;

    // 模拟重复的启用通知（storage 变更会被多次广播）
    box.storageListeners.forEach((fn) => fn({ autoNext: { newValue: true } }, 'local'));
    box.storageListeners.forEach((fn) => fn({ autoNext: { newValue: true } }, 'local'));

    const after = activeIntervals(box).length;
    const pollAfter = activeIntervals(box).filter((it) => it.ms === 5000).length;

    check('重复 enable 不叠加任何 interval', after === baseline, `${baseline} → ${after}`);
    check('重复 enable 不叠加 URL 轮询定时器', pollAfter === pollBefore, `${pollBefore} → ${pollAfter}`);
  }

  // 10.2 enable → disable → enable：每次只保留一个轮询定时器，且能重新工作
  {
    const page = buildLessonPage({});
    const box = createSandbox({ page, storage: { autoNext: true } });
    loadExtension(box.sandbox);
    await runTimers(box.timers);

    const firstPoll = activeIntervals(box).filter((it) => it.ms === 5000);
    check('启用后存在 1 个 URL 轮询定时器', firstPoll.length === 1, String(firstPoll.length));

    // 关闭
    box.storageListeners.forEach((fn) => fn({ autoNext: { newValue: false } }, 'local'));
    const pollAfterDisable = activeIntervals(box).filter((it) => it.ms === 5000);
    check('关闭后 URL 轮询定时器被清理', pollAfterDisable.length === 0, String(pollAfterDisable.length));
    check('关闭后 watchdog 也被清理',
      activeIntervals(box).filter((it) => it.ms === 800).length === 0);

    // 再次启用
    box.storageListeners.forEach((fn) => fn({ autoNext: { newValue: true } }, 'local'));
    const pollAfterReenable = activeIntervals(box).filter((it) => it.ms === 5000);
    check('重新启用后恰好恢复 1 个 URL 轮询定时器', pollAfterReenable.length === 1, String(pollAfterReenable.length));
  }

  // 10.3 重新启用后功能真的可用（能再次感知 URL 变化并触发重新扫描）
  {
    const page = buildLessonPage({});
    const box = createSandbox({ page, storage: { autoNext: true } });
    const api = loadExtension(box.sandbox);
    await runTimers(box.timers);

    let scanCount = 0;
    const originalScan = api.videoHandler.scan.bind(api.videoHandler);
    api.videoHandler.scan = () => { scanCount += 1; return originalScan(); };

    // 关闭 → 重新启用
    box.storageListeners.forEach((fn) => fn({ autoNext: { newValue: false } }, 'local'));
    box.storageListeners.forEach((fn) => fn({ autoNext: { newValue: true } }, 'local'));
    await runTimers(box.timers);

    const before = scanCount;
    box.sandbox.location.href = 'https://study.test/chapter/after-reenable';
    box.clock.advance(6000);
    // 只触发 URL 轮询定时器
    activeIntervals(box).filter((it) => it.ms === 5000).forEach((it) => it.fn());
    await runTimers(box.timers);

    check('重新启用后 URL 轮询仍能触发重新扫描', scanCount > before, `${before} → ${scanCount}`);
  }
}

// ————————————————————————————————————————————————————————————————
// [Suite 11] 超星同章节多任务点与测验导航防误杀加固
// ————————————————————————————————————————————————————————————————
async function testMultiTaskAndQuizNav() {
  console.log('\n[Suite 11] 超星同章节多任务点与测验导航防误杀加固');

  // 11.1 同一章节存在多任务点 Tab 时，优先点击下一任务点 Tab（而非直接跨章节跳转）
  {
    const doc = new FakeElement('html');
    const body = doc.append(new FakeElement('body'));
    const video = body.append(new FakeVideoElement({ duration: 600 }));
    const clicked = [];

    // 选项卡栏：当前在任务点 1 (dct1)，紧邻任务点 2 (dct2)
    const tabbar = body.append(new FakeElement('div', { class: 'tabtags' }));
    const tab1 = tabbar.append(new FakeElement('span', { id: 'dct1', class: 'currents', text: '视频1' }));
    const tab2 = tabbar.append(new FakeElement('span', { id: 'dct2', text: '视频2' }));
    tab2.addEventListener('click', () => clicked.push('tab2-next-task'));

    // 跨章节全局下一节按钮
    const nextChapter = body.append(new FakeElement('a', { id: 'prevNextFocusNext', class: 'prev_next next', text: '下一节' }));
    nextChapter.addEventListener('click', () => clicked.push('next-chapter-btn'));

    const { sandbox, timers } = createSandbox({
      page: { documentElement: doc, body, video, state: { clicked } },
      storage: { autoNext: true }
    });
    loadExtension(sandbox);
    await runTimers(timers);

    video.watch(30);
    video.finish();
    await runTimers(timers);

    check('同章节内优先切换至下一个未完成任务点 Tab', clicked.includes('tab2-next-task'), JSON.stringify(clicked));
    check('任务点未完成前不越级点击跨章节下一节按钮', !clicked.includes('next-chapter-btn'), JSON.stringify(clicked));
  }

  // 11.2 下一小节为测验/考试时，包含测验标题的“下一节”按钮不被误判排除
  {
    const doc = new FakeElement('html');
    const body = doc.append(new FakeElement('body'));
    const video = body.append(new FakeVideoElement({ duration: 600 }));
    const clicked = [];

    // 超星常见：下一节是测验，title 标注为“下一节：第一章 章节测验”
    const nav = body.append(new FakeElement('div', { class: 'prev_next' }));
    const nextQuizBtn = nav.append(new FakeElement('a', {
      id: 'prevNextFocusNext',
      class: 'prev_next next',
      attrs: { title: '下一节：第1章章节测验' },
      text: '下一节'
    }));
    nextQuizBtn.addEventListener('click', () => clicked.push('next-to-quiz-section'));

    const { sandbox, timers } = createSandbox({
      page: { documentElement: doc, body, video, state: { clicked } },
      storage: { autoNext: true }
    });
    loadExtension(sandbox);
    await runTimers(timers);

    video.watch(30);
    video.finish();
    await runTimers(timers);

    check('通往测验小节的“下一节”按钮正常被识别并点击', clicked.includes('next-to-quiz-section'), JSON.stringify(clicked));
  }

  // 11.3 测验界面内部的提交、交卷、答题控件仍坚决排除
  {
    const doc = new FakeElement('html');
    const body = doc.append(new FakeElement('body'));
    const video = body.append(new FakeVideoElement({ duration: 600 }));
    const clicked = [];

    const submitBtn = body.append(new FakeElement('button', { id: 'submit-quiz', text: '提交测验' }));
    submitBtn.addEventListener('click', () => clicked.push('submit-quiz'));

    const handinBtn = body.append(new FakeElement('button', { id: 'handin-paper', text: '交卷' }));
    handinBtn.addEventListener('click', () => clicked.push('handin-paper'));

    const startQuizBtn = body.append(new FakeElement('button', { id: 'start-quiz', text: '开始答题' }));
    startQuizBtn.addEventListener('click', () => clicked.push('start-quiz'));

    const realNext = body.append(new FakeElement('button', { id: 'real-next-link', class: 'next-btn', text: '下一节' }));
    realNext.addEventListener('click', () => clicked.push('real-next-link'));

    const { sandbox, timers } = createSandbox({
      page: { documentElement: doc, body, video, state: { clicked } },
      storage: { autoNext: true }
    });
    loadExtension(sandbox);
    await runTimers(timers);

    video.watch(30);
    video.finish();
    await runTimers(timers);

    check('测验“提交测验”控件被严格排除', !clicked.includes('submit-quiz'));
    check('测验“交卷”控件被严格排除', !clicked.includes('handin-paper'));
    check('测验“开始答题”控件被严格排除', !clicked.includes('start-quiz'));
    check('排除提交控件后成功命中真实“下一节”', clicked.includes('real-next-link'));
  }

  // 11.4 目录树兄弟小节兜底导航
  {
    const doc = new FakeElement('html');
    const body = doc.append(new FakeElement('body'));
    const video = body.append(new FakeVideoElement({ duration: 600 }));
    const clicked = [];

    const catalog = body.append(new FakeElement('ul', { class: 'posCatalog_level' }));
    catalog.append(new FakeElement('li', { class: 'posCatalog_select', text: '1.1 绪论' }));
    const nextLi = catalog.append(new FakeElement('li', { class: 'posCatalog_item' }));
    const nextLink = nextLi.append(new FakeElement('a', { class: 'posCatalog_name', text: '1.2 导数概念' }));
    nextLink.addEventListener('click', () => clicked.push('catalog-next-lesson'));

    const { sandbox, timers } = createSandbox({
      page: { documentElement: doc, body, video, state: { clicked } },
      storage: { autoNext: true }
    });
    loadExtension(sandbox);
    await runTimers(timers);

    video.watch(30);
    video.finish();
    await runTimers(timers);

    check('无独立下一节按钮时由目录树下一个兄弟章节兜底点击', clicked.includes('catalog-next-lesson'), JSON.stringify(clicked));
  }
}

// ————————————————————————————————————————————————————————————————
// [Suite 12] 自审加固：单击事件去重、手动静默期与全局选择器实时更新
// ————————————————————————————————————————————————————————————————
async function testClickDeduplicationAndGrace() {
  console.log('\n[Suite 12] 自审加固：单击事件去重、手动静默期与全局选择器实时更新');

  // 12.1 dom.click(el) 单次派发保障（杜绝双重 click 事件）
  {
    const doc = new FakeElement('html');
    const body = doc.append(new FakeElement('body'));
    const btn = body.append(new FakeElement('button', { id: 'test-btn', text: '按钮' }));
    let clickCount = 0;
    btn.addEventListener('click', () => { clickCount += 1; });

    const { sandbox, timers } = createSandbox({
      page: { documentElement: doc, body }
    });
    loadExtension(sandbox);
    await runTimers(timers);

    sandbox.window.AutoNext.dom.click(btn);
    check('dom.click(el) 触发 click 事件恰好 1 次（杜绝双重触发）', clickCount === 1, `clickCount=${clickCount}`);
  }

  // 12.2 用户手动导航后 2.5s 静默期有效拦截自动跳转
  {
    const doc = new FakeElement('html');
    const body = doc.append(new FakeElement('body'));
    const video = body.append(new FakeVideoElement({ duration: 600 }));
    const clicked = [];
    const nextBtn = body.append(new FakeElement('button', { id: 'nextBtn', text: '下一节' }));
    nextBtn.addEventListener('click', () => clicked.push('next-btn'));

    const { sandbox, timers, clock } = createSandbox({
      page: { documentElement: doc, body, video, state: { clicked } },
      storage: { autoNext: true }
    });
    loadExtension(sandbox);
    await runTimers(timers);

    // 模拟用户手动点击了“下一节”
    sandbox.window.AutoNext.videoHandler.notifyManualNavigation(2500);

    // 紧接着旧视频触发自然结束（或 watchdog 命中）
    sandbox.window.AutoNext.videoHandler.triggerNextLesson('测试结束');
    await runTimers(timers);

    check('静默期内阻止自动连播重复点击下一节（防跳两节）', clicked.length === 0, JSON.stringify(clicked));

    // 快进时间超过 2500ms 静默期
    clock.advance(3500);
    sandbox.window.AutoNext.videoHandler.triggerNextLesson('静默期后新视频结束');
    await runTimers(timers);

    check('静默期结束后恢复正常自动跳转', clicked.includes('next-btn'), JSON.stringify(clicked));
  }

  // 12.3 全局 customNextSelector 变更在已打开页面实时生效
  {
    const doc = new FakeElement('html');
    const body = doc.append(new FakeElement('body'));
    let notifiedChange = null;

    const { sandbox, timers, storageListeners } = createSandbox({
      page: { documentElement: doc, body },
      storage: { autoNext: true, customNextSelector: '' }
    });
    loadExtension(sandbox);
    await runTimers(timers);

    sandbox.window.AutoNext.settings.subscribe((changes) => {
      notifiedChange = changes;
    });

    // 模拟 storage 中改变了全局 customNextSelector
    storageListeners.forEach((fn) => fn({
      customNextSelector: { newValue: '.custom-next-btn', oldValue: '' }
    }, 'local'));
    await runTimers(timers);

    check('全局 customNextSelector 变更被 settings 实时更新',
      sandbox.window.AutoNext.settings.customNextSelector === '.custom-next-btn',
      sandbox.window.AutoNext.settings.customNextSelector);
    check('settings.subscribe 成功派发 customNextSelector 变更通知',
      notifiedChange && notifiedChange.customNextSelector === '.custom-next-btn',
      JSON.stringify(notifiedChange));
  }

  // 12.4 全局设置更新时不覆盖站点的独立禁用规则
  {
    const doc = new FakeElement('html');
    const body = doc.append(new FakeElement('body'));

    const { sandbox, timers, storageListeners } = createSandbox({
      page: { documentElement: doc, body },
      storage: {
        autoNext: false,
        siteSettings: {
          'special.site.com': { override: true, autoNext: false }
        }
      }
    });
    sandbox.location.href = 'https://special.site.com/study';
    loadExtension(sandbox);
    await runTimers(timers);

    // 外部修改全局 autoNext 为 true
    storageListeners.forEach((fn) => fn({
      autoNext: { newValue: true, oldValue: false }
    }, 'local'));
    await runTimers(timers);

    check('站点规则独立禁用时，全局开关开启不破坏站点覆盖',
      sandbox.window.AutoNext.settings.enabled === false,
      `enabled=${sandbox.window.AutoNext.settings.enabled}`);
  }

  // 12.5 零 webNavigation 权限与 API 依赖
  {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../manifest.json'), 'utf8'));
    const permissions = manifest.permissions || [];
    check('manifest.json 中已彻底移除 webNavigation 权限', !permissions.includes('webNavigation'), JSON.stringify(permissions));

    const popupCode = fs.readFileSync(path.join(__dirname, '../popup.js'), 'utf8');
    check('popup.js 中绝无 chrome.webNavigation 遗留调用', !popupCode.includes('chrome.webNavigation'));
  }

  // 12.6 isInternalClicking 状态追踪与防误判门控
  {
    const doc = new FakeElement('html');
    const body = doc.append(new FakeElement('body'));
    const nextBtn = body.append(new FakeElement('button', { id: 'nextBtn', text: '下一节' }));

    const { sandbox, timers } = createSandbox({
      page: { documentElement: doc, body },
      storage: { autoNext: true }
    });
    loadExtension(sandbox);
    await runTimers(timers);

    const dom = sandbox.window.AutoNext.dom;
    const vh = sandbox.window.AutoNext.videoHandler;

    check('isInternalClicking 初始状态为 false', dom.isInternalClicking() === false);

    let observedDuringClick = null;
    nextBtn.addEventListener('click', () => {
      observedDuringClick = dom.isInternalClicking();
    });

    const prevGrace = vh.stats().cycle.manualNavGraceUntil;
    dom.click(nextBtn);
    const postInternalGrace = vh.stats().cycle.manualNavGraceUntil;

    check('dom.click 执行期间 isInternalClicking 深度追踪为 true', observedDuringClick === true);
    check('dom.click 执行结束后 isInternalClicking 恢复为 false', dom.isInternalClicking() === false);
    check('插件内部点击不会激活手动静默保护期（防误判）', prevGrace === postInternalGrace, `prev=${prevGrace} post=${postInternalGrace}`);

    // 用户真实点击触发原生事件冒泡
    nextBtn.dispatchEvent(new FakeEvent('click', { bubbles: true }));
    const postUserGrace = vh.stats().cycle.manualNavGraceUntil;
    check('用户真实点击能够正常激活手动导航静默保护期', postUserGrace > (prevGrace || 0), `post=${postUserGrace}`);
  }

  // 12.7 checkHandoffResult 在手动导航静默期内放弃重试
  {
    const doc = new FakeElement('html');
    const body = doc.append(new FakeElement('body'));
    const video = body.append(new FakeVideoElement({ duration: 600 }));
    const parentWin = { postMessage: () => {} };

    const { sandbox, timers } = createSandbox({
      page: { documentElement: doc, body, video },
      storage: { autoNext: true }
    });
    sandbox.window.parent = parentWin;
    sandbox.window.top = parentWin;
    loadExtension(sandbox);
    await runTimers(timers);

    video.watch(30);
    video.finish();
    await runTimers(timers, { maxRounds: 2 });

    const statsAfterEnded = sandbox.window.AutoNext.videoHandler.stats();
    check('子 frame 无按钮播完后启动交接且等待回音', statsAfterEnded.cycle.handoffCount === 1);

    // 在 2500ms 交接检查到期前，模拟用户手动点击导航，触发 3000ms 静默保护期
    sandbox.window.AutoNext.videoHandler.notifyManualNavigation(3000);
    const requestsAfterCancel = sandbox.window.AutoNext.messenger.stats.requested;

    // 运行并消耗后续所有定时器（包含 2500ms 的 checkHandoffResult 定时器）
    await runTimers(timers, { maxRounds: 5 });

    const statsAfterTimer = sandbox.window.AutoNext.videoHandler.stats();
    check('手动导航取消旧交接任务且没有再次求助',
      statsAfterTimer.cycle.handoffCount === 0
      && sandbox.window.AutoNext.messenger.stats.requested === requestsAfterCancel);
    check('处于手动导航静默期时跳转循环保持停止 (!cycle.running)', !statsAfterTimer.cycle.running);
  }

  // 12.8 消除 selectorCache 死代码与 background migrateSettings 校验同步
  {
    const buttonFinderCode = fs.readFileSync(path.join(__dirname, '../content/button-finder.js'), 'utf8');
    check('button-finder.js 中已彻底移除 selectorCache 死代码', !buttonFinderCode.includes('selectorCache'));

    const bgMig = migrateSettings({ siteSettings: [1, 2, 3] });
    check('background.js migrateSettings 能够纠正数组类型的 siteSettings', typeof bgMig.siteSettings === 'object' && !Array.isArray(bgMig.siteSettings));
    check('background.js migrateSettings 补齐 customNextSelector', typeof bgMig.customNextSelector === 'string');
  }
}

// ————————————————————————————————————————————————————————————————
// 主执行器
// ————————————————————————————————————————————————————————————————
(async () => {
  console.log('Video Auto Player v1.2.4 全量测试套件');
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
  await testEnableDisableLifecycle();
  await testMultiTaskAndQuizNav();
  await testClickDeduplicationAndGrace();

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(60));
  console.log(`共 ${results.length} 项新特性断言，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
})();
