# 视频自动播放器

当前版本：`1.2.4`（Manifest V3）

一个用于 Chrome / Edge 的网页视频播放辅助扩展。它只在当前页面操作已有的 HTML5 `<video>` 播放器和页面原有的前进控件，适合需要连续播放多个网页视频的场景。

## 功能概览

| 功能 | 说明 |
| --- | --- |
| 自动播放与恢复 | 发现播放器（含 open Shadow DOM 内播放器）后尝试开始播放；页面切换或短暂暂停后，在有限次数和时间窗口内恢复。 |
| 连续页面导航 | 视频自然结束后，优先使用自定义 CSS Selector，未指定时启发式评分点击“下一节 / 下一个 / Next”控件。 |
| 章节多任务点与目录导航 | 支持超星等平台同章节内多任务点 Tab（`[id^="dct"]`、`.tabtags` 等）依次顺播；在无跨章按钮时通过目录树相邻小节兜底跳转。 |
| 测验小节放行与安全隔离 | 智能放行通往“章节测验 / 单元测试”的合法前进导航，同时 100% 坚决拦截“提交测验 / 交卷 / 开始答题”等答卷控件，绝不误触。 |
| 自定义播放速率 | 支持任意自定义 `playbackRate`（0.1x ~ 16.0x），提供 1.0x ~ 3.0x 快捷选档与输入框；平台限制时自适应回退并保持播放。 |
| 域名级站点规则 | 支持为当前站点单独设置连播开关、独立倍速与自定义下一节选择器，未配置时继承全局默认。 |
| 可选跳过无视频页面 | 明确开启后，连续内容中遇到没有播放器的页面时继续寻找下一个视频页面；默认关闭。 |
| 诊断面板与日志导出 | 3 标签页布局（播放控制 / 当前站点 / 诊断日志），支持最近 50 条生命周期事件回放，一键导出已脱敏的 JSON / 文本诊断报告。 |
| 隐私脱敏安全防护 | 诊断与导出中自动抹除 URL 和媒体源里的敏感参数（token、ticket、auth、sign、key、jwt 等），杜绝凭证泄漏。 |

## 使用边界

本项目仅调用浏览器公开的播放器 API，并点击当前页面已经存在的导航控件：

- 不修改 `currentTime`、`duration` 或页面进度记录；
- 不伪造完成状态、时长或学习记录；
- 不调用或修改站点后端接口；
- 不绕过验证码、登录验证、可见性限制或其他安全机制；
- 不代替用户完成测验、作业、讨论或表单提交；
- 遵守 W3C 规范：受标准限制，封闭式 `closed` Shadow DOM 无法被外部脚本穿透读取。

请只在你有权访问和使用的页面上运行，并遵守对应网站、组织或课程的使用规定。开启“跳过无视频页面”前，请确认这些页面不包含你需要完成的内容。

## 快速开始

1. 打开 `edge://extensions` 或 `chrome://extensions`，开启开发者模式。
2. 选择“加载已解压的扩展”，指向包含 `manifest.json` 的项目目录。
3. 打开需要播放的网页，点击工具栏中的“视频自动播放器”。
4. 按需要配置播放速率、站点规则或开启“自动进入下一节”，然后刷新已打开的页面。

更新代码后，需要先在扩展管理页点击“重新加载”，再回到网页按 `Ctrl + Shift + R` 强制刷新，确保页面注入的是最新版本。

## 目录结构

```text
视频自动播放器/
├── manifest.json              # MV3 清单、权限和注入配置 (v1.2.4)
├── background.js              # Service Worker：设置初始化、旧版存储平滑迁移与消息通信
├── popup.html                 # 3 Tab 弹窗面板（播放控制、站点规则、诊断日志与脱敏导出）
├── popup.js                   # 原生 DOM 挂载、选项卡切换、规则持久化（0 innerHTML CSP 合规）
├── content/
│   ├── logger.js              # 日志出口与 50 条内存循环队列 (Ring Buffer)
│   ├── settings.js            # 开关状态、站点规则覆盖计算 (resolveEffective) 与存储监听
│   ├── dom-utils.js           # DOM 可见性判定、URL 敏感参数脱敏与 open Shadow DOM 穿透查找
│   ├── button-finder.js       # 多任务点 Tab 优先、自定义 CSS Selector 与前进控件多维度打分
│   ├── frame-messenger.js     # iframe 跨层消息协调、去重防回环与导航状态广播
│   ├── skip-controller.js     # 可选的无视频页面自动跳过控制器
│   ├── rate-controller.js     # 任意目标倍速控制、限频防互抢与平台限制自适应降级
│   ├── video-handler.js       # 播放器发现、状态看门狗、异常暂停取证与自然结束跳转
│   ├── ui.js                  # 页面内状态提示 UI
│   └── content.js             # 主控制器、SPA 路由增强 (pushState/popstate/hashchange) 与控制台 API
├── test/
│   ├── fake-dom.js            # 测试用轻量 DOM 桩（支持 open/closed Shadow DOM、组合选择器与伪类）
│   ├── run-tests.js           # 内容脚本行为测试（122 项）
│   ├── popup-tests.js         # 弹窗面板交互与 CSP 安全测试（53 项）
│   ├── v12-features-tests.js  # v1.2 特性与同章节多任务点测试（150 项）
│   ├── regression-autoplay-tests.js # 连续播放核心链路回归测试（55 项）
│   └── e2e-browser-test.js    # Headless Chromium 三层 iframe 端到端测试
├── .github/workflows/test.yml # GitHub Actions 持续集成自动化工作流
├── package.json               # 自动化测试脚本与项目描述
└── README.md
```

## 弹窗与调试

弹窗采用分区选项卡设计：
- **播放控制**：状态概览卡片、连播/倍速开关、1.0x ~ 3.0x 快捷选档及 0.1x ~ 16.0x 自定义倍速输入、跳非视频开关；
- **当前站点**：识别当前域名，支持按站点开启规则覆盖、设置单站连播/倍速与自定义“下一节”CSS Selector；
- **诊断日志**：查看最近 50 条关键生命周期事件（含播放检测、结束、跳转、回退等），一键复制脱敏诊断文本或导出脱敏 JSON 文件。

也可以在 DevTools Console 中直接调用调试接口：

```js
__AUTO_NEXT__.debug()          // 开启详细日志
__AUTO_NEXT__.debug(false)     // 关闭详细日志
__AUTO_NEXT__.stats()          // 查看当前 frame 状态与已脱敏 URL
__AUTO_NEXT__.scan()           // 手动扫描播放器（包含 Shadow DOM）
__AUTO_NEXT__.setRate(1.75)    // 手动将播放器设为指定速率 (0.1~16x)
__AUTO_NEXT__.events()         // 读取内存循环事件日志 (最近 50 条)
__AUTO_NEXT__.candidates()     // 查看前 10 个前进控件候选及评分
__AUTO_NEXT__.clickNext()      // 调试用：直接执行一次前进查找与点击
__AUTO_NEXT__.manualNavigateNext() // 手动导航并确认页面确实发生切换
__AUTO_NEXT__.trySkip()        // 手动检查是否需要跳过无视频页面
```

## 本地测试

项目附带完整的 Node.js 测试套件，无需启动真实浏览器即可全真模拟 DOM 运行环境：

```bash
# 执行全部 380 项 Node 回归断言
npm test

# 分别执行各子套件
npm run test:content  # 122 项 content script 行为测试
npm run test:popup    # 53 项 popup 面板与 CSP 测试
npm run test:v12      # 150 项 v1.2.x 进阶特性与多任务点加固断言
npm run test:regression # 55 项连续播放核心链路回归断言
npm run test:e2e      # 真实 Chromium 三层 iframe 端到端验证
```

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `storage` | 保存本地全局开关、倍速偏好及域名独立规则 |
| `scripting` + `activeTab` | 点击诊断或手动导航时，对当前标签页（含各 frame）执行只读探测与操作 |
| `<all_urls>` | 支持不同网页来源和嵌套 iframe 中的 HTML5 播放器 |

扩展不上传任何页面数据，亦不主动发起外部网络请求（免申请 `webNavigation` 等敏感权限，各 frame 探测通过 `scripting.allFrames` 原生支持）。

## 更新日志

### v1.2.4 (2026-09-22)
- **结尾防抢跑**：watchdog 只在距离真实结尾不超过 0.25 秒时兜底判定完成；若平台在倒数几秒暂停，会先补播最后几秒，不再提前跳节。
- **未完成任务点弹窗恢复**：识别“当前章节还有任务点未完成”提示后自动点击“去学习”，并撤销本轮错误导航锁，绝不点击弹窗里的“下一节”。
- **连续播放状态锁修复**：SPA URL 轮询仅触发恢复扫描，不再把已开始播放的新视频重新加锁，修复播放不定数量视频后停在末尾的问题。
- **手动下一节防卡死**：改为先扫描全部 frame、只在最佳 frame 点击一次，并为脚本调用增加 4 秒超时；页面端同步确认导航是否真正生效。

### v1.2.3 (2026-09-21)
- **核心连播链路回归排查与修复（视频 A 播完 → 自动进入视频 B → 视频 B 自动起播）**：
  - **跨 Frame 消息中继闭环**：修复 `frame-messenger.js` 中间 frame 吞没 `NAVIGATING`、`NAVIGATED` 与 `SCAN` 广播的缺陷，建立父子双向中继与 `markSeen` 去重，确保多层嵌套 iframe 下顶层导航与深层视频 frame 始终保持连通。
  - **统一导航后生命周期与渐进重试**：在 `video-handler.js` 中导出并完善 `afterNavigation(reason)`，在远程跳转、SPA URL 变更与路由切换后统一重置上一轮已完成状态，分阶段（300ms / 1200ms / 2500ms）执行快速到兜底的视频探测与起播恢复。
  - **MutationObserver 属性监听增强**：在 `content.js` 中补充 `attributes: ['src']` 监听，深度捕获同元素换源（`video.src` 或 `<source src>` 变动），杜绝 DOM 节点未增删时的识别盲区。
  - **活跃视频选举与已移除节点剪枝**：`scan()` 自动清理脱离 DOM 的旧视频记录；重构 `state.active` 选举模型（播放中 > 未播完可见 > 未播完候选 > 首次发现），防止已播完视频永久霸占焦点阻塞新视频播放。
  - **换源感知滞后消除**：优化 `sourceKeyOf(video)` 提取，优先读取显式 `src` 属性再降级 `currentSrc`，消除底层微任务延时导致的换源漏报。
  - **表单内合法前进按钮解禁**：移除 `button-finder.js` 中对 `el.form` 的无条件一票否决，在严密防范 `submit` 提交控件的基础上放行 `<form>` 内包含的正常下一节按钮。
  - **小视频容差计算加固**：加固 `isAtEnd` 计算（`safeTolerance = Math.min(tolerance, video.duration * 0.5)`），防止短视频在开局误判为结尾。
  - **Watchdog 空窗期防重与导航锁源绑定**：在 `triggerNextLesson` 设置 `rec.triggered = true` 并由 watchdog 强校验拦截二次跳转；在 `cycle` 引入 `navigatedSource`，确保旧视频瞬态 playing 绝不提前解除导航锁，必须由新源解锁。
  - **全链路端到端验证**：新增 27 项高强度核心链路回归单测（`test/regression-autoplay-tests.js`）及基于 Headless Chromium 的多层 iframe 真实浏览器 E2E 测试（`test/e2e-browser-test.js`）。

### v1.2.2 (2026-09-21)
- **双击修复（DOM 单击事件去重）**：修复 `dom.click(el)` 派发手势事件后又调用原生 `click()` 导致的 click 事件被触发两遍的问题，优先调用原生 `el.click()`，单次操作精准派发 1 次 click，彻底避免按钮或计数组件重复响应。
- **手动导航静默期（防跳两节与并发保护）**：
  - 将手动导航静默保护重构为绝对时间戳窗口（`manualNavGraceUntil`），在 `triggerNextLesson` 与 `watchdog` 轮询中统一生效拦截，防止用户手动点击后旧视频再次误触发自动跳转跳两节；
  - 在 `dom-utils.js` 中新增 `isInternalClicking` 执行深度计数，杜绝跨 frame 远程代点或其他插件内部派发的点击冒泡触发 `watchUserNavigation` 产生的假“手动点击”日志和多余静默期；
  - 在 `checkHandoffResult` 重试流程中补齐 `manualNavGraceUntil` 检查，彻底杜绝交接等待超时与手动导航并发时的边界重复跳节。
- **权限精简（彻底移除 webNavigation）**：彻底移除冗余的 `webNavigation` 敏感权限，弹窗探测改为 `chrome.scripting.executeScript({ target: { allFrames: true } })`，减少商店审核风险与用户权限警告。
- **版本与配置对齐（双端漂移消除）**：彻底清除 `button-finder.js` 中的未引用 `selectorCache` 死代码；全面对齐 `background.js`、`popup.js`、`settings.js` 的 `DEFAULTS`（补齐 `customNextSelector: ''`）与 `migrateSettings`（补齐 `Array.isArray(siteSettings)` 校验），消除跨端配置漂移。

### v1.2.1 (2026-09-21)
- **修复（多任务点识别）**：新增超星等平台同章节多任务点 Tab（`[id^="dct"]`、`.tabtags` 及未完成任务点图标）高权重识别规则，解决多视频同页播放完毕后停滞不跳转的问题。
- **修复（反向词误伤）**：重构测验/考试反向词过滤逻辑。引入 `isForwardNav`，智能放行通往“章节测验 / 单元测试”小节的合法“下一节”按钮；同时对测验页面内部的“提交测验 / 交卷 / 开始答题”及 submit 表单保持严格排除。
- **优化（跨 Frame 消息机制）**：修复 `frame-messenger.js` 在向相邻 frame 请求查找下一节时的回环弹跳，发送前标记本 frame 消息已记录，杜绝无效重试与报错。
- **增强（目录树兜底）**：补充章节目录树相邻小节（`.posCatalog_select + li/div`）选择器，在独立下一节按钮隐藏或改版时自动接管。
- **增强（自定义选择器实时生效）**：在 `settings.js` 中新增全局 `customNextSelector` 默认值与变更响应，并重构基于 `resolveEffective` 的配置重算逻辑，确保站点规则覆盖在全局变更时不被破坏。

### v1.2.0 (2026-09-20)
- **新增（自定义播放速率）**：支持 0.1x ~ 16.0x 任意倍速，增加 1.0x ~ 3.0x 快捷选档与输入框，增强平台限制检测与防互抢机制。
- **新增（站点独立规则）**：支持为特定域名单独配置连播开关、独立倍速与自定义下一节 CSS Selector。
- **新增（诊断面板与脱敏导出）**：3 Tab 面板布局，支持 50 条事件内存回放与脱敏诊断报告（JSON / 纯文本）一键导出。
- **增强（Shadow DOM 穿透）**：支持 open Shadow DOM 递归探测。
- **增强（SPA 路由感知）**：集成 popstate / hashchange 与 URL 轮询感知单页应用无刷新换节。

## 许可与贡献

本项目采用 MIT 许可证。提交 Issue 或 Pull Request 时，请提供复现步骤与已脱敏的诊断面板导出信息，严禁附带未经脱敏的个人凭证或敏感数据。

