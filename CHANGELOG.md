# 更新日志 (Changelog)

所有关键版本变更均记录于此文件。本项目严格遵循语义化版本规范。

---

## v1.2.4 (2026-09-22)

- 修复视频尚余数秒时 watchdog 提前跳转；仅允许在真实结尾 0.25 秒范围内兜底，异常暂停会优先恢复播放。
- 新增学习通“当前章节还有任务点未完成”弹窗处理：自动选择“去学习”，撤销错误导航状态且不误点“下一节”。
- 分离已确认导航与被动 SPA 路由观察，防止迟到的 URL 轮询重新锁住正在播放的新视频。
- 手动“下一节”改为两阶段单 frame 点击并加入 4 秒超时；非视频页也会确认导航是否实际生效。
- 新增结尾抢跑、未完成任务点弹窗、迟到 URL 轮询、多 frame 重复点击与脚本挂起回归测试。

---

## v1.2.3 (2026-09-21)

### 核心连播链路回归排查与全链路修复（“视频 A 播完 → 自动进入视频 B → 视频 B 自动播放”）

#### 1. 跨 Frame 消息中继闭环（多层 iframe 拓扑支持）
- **修复**: 在 `content/frame-messenger.js` 中重构 `NAVIGATING`、`NAVIGATED` 与 `SCAN` 消息的跨层广播机制。
- **改动**: 收到通知的中间 frame 采用 `markSeen(data.id)` 登记防重，同时向上（父级）和向下（所有直接子级 iframe）安全双向透传，彻底消除中间层 iframe 吞没消息导致叶子视频 frame 与顶层导航 frame 断连的缺陷。

#### 2. 统一导航后生命周期与渐进式重试窗口
- **修复**: 在 `content/video-handler.js` 中导出并完善 `afterNavigation(reason)` 恢复管线。
- **改动**: 无论是由本 frame 触发点击、远程 frame 广播 `NAVIGATED`、SPA URL 轮询还是 SPA 路由切换，均统一进入生命周期收尾；分阶段执行快速（300ms）、中期（1200ms）与终态（2500ms）扫描恢复；自动清除上一轮已结束/失效视频的阻塞状态，确保新视频在各种加载延时下均能稳定接管并自动起播。

#### 3. MutationObserver 属性与媒体标签精准监听
- **修复**: 在 `content/content.js` 中将 `MutationObserver` 监听配置升级为包含 `attributes: true, attributeFilter: ['src']`，并增加对 `VIDEO`、`SOURCE`、`IFRAME` 节点及其新增子节点的深度识别。
- **改动**: 彻底解决 SPA 或播放器容器同节点就地替换 `video.src` 或 `<source src>` 时 Observer 漏报、无法感知新视频挂载的盲区。

#### 4. 播放器扫描与活跃视频选举去停滞
- **修复**: 修复 `state.byVideo` 残留已从 DOM 移除（`!video.isConnected`）的旧播放器节点问题。
- **改动**: `scan()` 阶段自动剪枝断开连接的无效节点；引入四级优先级选举策略（`正在播放` > `未播完且可见` > `未播完候选` > `其他合规播放器`），彻底防止已播完或隐藏的旧播放器因 Map 插入顺序永久霸占 `state.active` 导致新视频无法被驱动。

#### 5. 换源检测感知滞后修复
- **修复**: 优化 `sourceKeyOf(video)` 提取逻辑，优先读取显式 `src` 属性与子 `<source src>`，仅在无属性时降级为 `currentSrc`。
- **改动**: 消除浏览器底层更新 `currentSrc` 的异步微任务延迟，确保换源后立刻命中 `onSourceMutated` 触发完整状态重置与重新激活。

#### 6. 表单内合法前进按钮误杀修复
- **修复**: 移除 `content/button-finder.js` 中对 `el.form` 的无条件一票否决。
- **改动**: 保持对 `type="submit"`、`role="submit"`、`data-action="submit"` 及非 button 提交控件的 100% 严格隔离与测验安全保护，同时正常放行包含在 `<form>` 结构内部的常规下一节按钮。

#### 7. 结尾判定加固与 Watchdog 防二次跳转
- **修复**: 加固 `isAtEnd` 与短视频容差计算：`safeTolerance = Math.min(tolerance, video.duration * 0.5)`。
- **改动**: 杜绝短视频开局 `currentTime === 0` 时被数学公式误判为“已在结尾”拒绝播放；在 `triggerNextLesson` 设置 `rec.triggered = true`，并在 `checkFinishWatchdog` 强校验拦截二次跳转，彻底杜绝新视频尚未挂载时旧视频 A 被 watchdog 反复触发跳转跳两节。

#### 8. 导航锁媒体源绑定（防旧视频 playing 提前解锁）
- **修复**: 在 `cycle` 结构中记录 `cycle.navigatedSource`。
- **改动**: `onPlaying` 解锁必须验证当前视频源不是上一轮导航触发源（`!isNavigatedOldSource`），彻底杜绝平台切集/销毁旧 DOM 瞬态派发 `playing` 提前释放导航锁的竞态漏洞。

#### 9. 自动化测试体系增强
- **单测增强**: 新增 `test/regression-autoplay-tests.js` 覆盖 7 大场景 Suite A~G（27 项高强度断言全过）。
- **E2E 浏览器测试**: 新增 `test/e2e-browser-test.js`，基于真实 Headless Chromium 内核与 3 层跨 frame 拓扑进行端到端全链路验证。

---

## v1.2.2 (2026-09-21)

- **双击修复（DOM 单击事件去重）**：修复 `dom.click(el)` 派发手势事件后又调用原生 `click()` 导致 click 事件被触发两遍的问题，优先调用原生 `el.click()`，单次操作精准派发 1 次 click，彻底避免按钮或计数组件重复响应。
- **手动导航静默期（防跳两节与并发保护）**：
  - 将手动导航静默保护重构为绝对时间戳窗口（`manualNavGraceUntil`），在 `triggerNextLesson` 与 `watchdog` 轮询中统一生效拦截，防止用户手动点击后旧视频再次误触发自动跳转跳两节；
  - 在 `dom-utils.js` 中新增 `isInternalClicking` 执行深度计数，杜绝跨 frame 远程代点或其他插件内部派发的点击冒泡触发 `watchUserNavigation` 产生的假“手动点击”日志和多余静默期；
  - 在 `checkHandoffResult` 重试流程中补齐 `manualNavGraceUntil` 检查，彻底杜绝交接等待超时与手动导航并发时的边界重复跳节。
- **权限精简（彻底移除 webNavigation）**：彻底移除冗余的 `webNavigation` 敏感权限，弹窗探测改为 `chrome.scripting.executeScript({ target: { allFrames: true } })`，减少商店审核风险与用户权限警告。
- **版本与配置对齐（双端漂移消除）**：彻底清除 `button-finder.js` 中的未引用 `selectorCache` 死代码；全面对齐 `background.js`、`popup.js`、`settings.js` 的 `DEFAULTS`（补齐 `customNextSelector: ''`）与 `migrateSettings`（补齐 `Array.isArray(siteSettings)` 校验），消除跨端配置漂移。

---

## v1.2.1 (2026-09-21)

- **修复（多任务点识别）**：新增超星等平台同章节多任务点 Tab（`[id^="dct"]`、`.tabtags` 及未完成任务点图标）高权重识别规则，解决多视频同页播放完毕后停滞不跳转的问题。
- **修复（反向词误伤）**：重构测验/考试反向词过滤逻辑。引入 `isForwardNav`，智能放行通往“章节测验 / 单元测试”小节的合法“下一节”按钮；同时对测验页面内部的“提交测验 / 交卷 / 开始答题”及 submit 表单保持严格排除。
- **优化（跨 Frame 消息机制）**：修复 `frame-messenger.js` 在向相邻 frame 请求查找下一节时的回环弹跳，发送前标记本 frame 消息已记录，杜绝无效重试与报错。
- **增强（目录树兜底）**：补充章节目录树相邻小节（`.posCatalog_select + li/div`）选择器，在独立下一节按钮隐藏或改版时自动接管。
- **增强（自定义选择器实时生效）**：在 `settings.js` 中新增全局 `customNextSelector` 默认值与变更响应，并重构基于 `resolveEffective` 的配置重算逻辑，确保站点规则覆盖在全局变更时不被破坏。

---

## v1.2.0 (2026-09-20)

- **新增（自定义播放速率）**：支持 0.1x ~ 16.0x 任意倍速，增加 1.0x ~ 3.0x 快捷选档与输入框，增强平台限制检测与防互抢机制。
- **新增（站点独立规则）**：支持为特定域名单独配置连播开关、独立倍速与自定义下一节 CSS Selector。
- **新增（诊断面板与脱敏导出）**：3 Tab 面板布局，支持 50 条事件内存回放与脱敏诊断报告（JSON / 纯文本）一键导出。
- **增强（Shadow DOM 穿透）**：支持 open Shadow DOM 递归探测。
- **增强（SPA 路由感知）**：集成 popstate / hashchange 与 URL 轮询感知单页应用无刷新换节。
