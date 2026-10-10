# 可重复的浏览器行为测试

需要 Node.js 20.19+（推荐 24）。首次在仓库目录运行：

```sh
npm ci
npm run test:setup
```

以后运行一条命令：

```sh
npm run test:real
```

该命令先运行隔离的 Chromium 测试页，全部通过才打开独立、持久化的真实学习通测试浏览器。模拟页面通过不会被报告成真实课程通过。

首次配置真实课程与登录：

```sh
npm run test:login -- --url "你的学习通课程学习页 URL"
```

只在打开的浏览器窗口手动登录一次，脚本识别播放器后自动保存测试报告并关闭窗口。课程地址保存在 `.local/real-test.json`，浏览器自行管理 `.local/chaoxing-profile` 的登录状态；测试不读取或导出密码、Cookie、Token。上述目录均被 Git 忽略。不要把它们提交或发给别人。若登录过期或平台要求验证，只在测试浏览器完成平台要求的操作。

只测试本地场景：`npm run test:real -- --fixtures-only`。
已验证本地场景、只重跑真实课程：`npm run test:real -- --live-only`。
重跑某个失败用例：`npm run test:browser -- --grep "nested:"`。

## 实际观察的行为

测试页涵盖普通视频、嵌套与跨域 iframe、动态加载、about:blank、srcdoc，以及先打开网页后加载扩展。加载真实本地扩展，使用实际媒体解码和自然播放结束事件，检查隔离执行环境初始化、2x、章节变化、新播放器身份与播放时间持续增长。测试不会调用播放器 play()、拖动进度或派发伪造 ended。短媒体由现有 sample.webm 通过 ffmpeg `-stream_loop 19 -c copy` 生成，保留超过默认 15 秒门槛的时长。

真实课程测试关闭“跳过非视频”，自然等待视频结束，要求浏览器原生可信 ended、课程激活项变化、新播放器身份与实际播放推进共同确认成功。最多允许两次导航点击（失败点击也计入），不自动提交测验、作业或处理平台验证。默认总等待上限 60 分钟；可在本地配置 `maxWaitMs` 和 `loginTimeoutMs`。如果章节没有 HTML5 视频或课程目录没有可观察的激活项，会明确阻塞，不能冒充成功。

为严格限制真实测试次数，真实测试加载从当前源码生成的 **带导航限额的测试副本**：仅在副本中增加跨 frame 共享、重启后仍有效的点击预算及控件过滤。生产 manifest 不包含该限额。报告标记 `instrumentedNavigationGuard: true`；真实结果证明这份受限测试副本的行为，生产扩展本身由独立场景验证。首次启动预算默认关闭，测试结束关闭预算并恢复扩展设置。

## 失败证据与修复

`test-results/fixtures/` 保存每个用例的页面截图、模块状态、事件类别、原生媒体结束事件与控制台错误；HTML 报告在 `playwright-report/index.html`，机器报告在 `test-results/playwright.json`。

`test-results/real-course/` 保存真实课程结果和诊断，`test-results/summary.json` 分列本地场景与真实课程状态；`.local/live-status.json` 是运行中的进度快照。真实课程不记录网络请求、HAR、trace 或登录页截图；日志只保留扩展事件类别，URL 删除查询串。课程截图仍可能包含课程内容，请只在本地保留。

定位失败后先将该轮证据复制到单独目录，再修改代码，重跑失败用例及必要回归。最多三轮针对性修复；仍失败则保留失败记录并报告具体阻塞。下一次 Playwright 运行会重建默认输出目录，保留证据必须先复制。

CI 只运行模拟页面 Chromium 行为，不访问真实课程，也不上传登录配置。
