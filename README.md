# 视频自动播放器

当前版本：`1.2.0`（Manifest V3）

一个用于 Chrome / Edge 的网页视频播放辅助扩展。它只在当前页面操作已有的 HTML5 `<video>` 播放器和页面原有的前进控件，适合需要连续播放多个网页视频的场景。

## 功能概览

| 功能 | 说明 |
| --- | --- |
| 自动播放与恢复 | 发现播放器（含 open Shadow DOM 内播放器）后尝试开始播放；页面切换或短暂暂停后，在有限次数和时间窗口内恢复。 |
| 连续页面导航 | 视频自然结束后，优先使用自定义 CSS Selector，未指定时启发式评分点击“下一节 / 下一个 / Next”控件。 |
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
├── manifest.json              # MV3 清单、权限和注入配置 (v1.2.0)
├── background.js              # Service Worker：设置初始化、旧版存储平滑迁移与消息通信
├── popup.html                 # 3 Tab 弹窗面板（播放控制、站点规则、诊断日志与脱敏导出）
├── popup.js                   # 原生 DOM 挂载、选项卡切换、规则持久化（0 innerHTML CSP 合规）
├── content/
│   ├── logger.js              # 日志出口与 50 条内存循环队列 (Ring Buffer)
│   ├── settings.js            # 开关状态、站点规则覆盖计算 (resolveEffective) 与存储监听
│   ├── dom-utils.js           # DOM 可见性判定、URL 敏感参数脱敏与 open Shadow DOM 穿透查找
│   ├── button-finder.js       # 自定义 CSS Selector 优先支持与前进控件多维度安全打分
│   ├── frame-messenger.js     # iframe 跨层消息协调与导航状态广播
│   ├── skip-controller.js     # 可选的无视频页面自动跳过控制器
│   ├── rate-controller.js     # 任意目标倍速控制、限频防互抢与平台限制自适应降级
│   ├── video-handler.js       # 播放器发现、状态看门狗、异常暂停取证与自然结束跳转
│   ├── ui.js                  # 页面内状态提示 UI
│   └── content.js             # 主控制器、SPA 路由增强 (pushState/popstate/hashchange) 与控制台 API
├── test/
│   ├── fake-dom.js            # 测试用轻量 DOM 桩（支持 open/closed Shadow DOM 与媒体元素事件）
│   ├── run-tests.js           # 内容脚本回归测试套件（117 项）
│   ├── popup-tests.js         # 弹窗面板交互与 CSP 安全测试（50 项）
│   └── v12-features-tests.js  # v1.2.0 新特性全量测试套件（75 项）
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
__AUTO_NEXT__.clickNext()      // 手动执行一次前进查找与点击
__AUTO_NEXT__.trySkip()        // 手动检查是否需要跳过无视频页面
```

## 本地测试

项目附带完整的 Node.js 测试套件，无需启动真实浏览器即可全真模拟 DOM 运行环境：

```bash
# 执行全部 242 项测试
npm test

# 分别执行各子套件
npm run test:content  # 117 项 content script 行为测试
npm run test:popup    # 50 项 popup 面板与 CSP 测试
npm run test:v12      # 75 项 v1.2.0 新特性与安全断言
```

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `storage` | 保存本地全局开关、倍速偏好及域名独立规则 |
| `scripting` + `activeTab` | 点击诊断按钮时，对当前标签页执行只读探测 |
| `webNavigation` | 列出当前标签页的 frame 结构，便于跨 frame 协调 |
| `<all_urls>` | 支持不同网页来源和嵌套 iframe 中的 HTML5 播放器 |

扩展不上传任何页面数据，亦不主动发起外部网络请求。

## 许可与贡献

本项目采用 MIT 许可证。提交 Issue 或 Pull Request 时，请提供复现步骤与已脱敏的诊断面板导出信息，严禁附带未经脱敏的个人凭证或敏感数据。

