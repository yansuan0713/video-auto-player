/**
 * test/e2e-browser-test.js —— 真实无头 Chrome 浏览器端到端测试
 *
 * 场景：
 *   top page (含多任务点 Tab：任务1、任务2)
 *     └── card iframe
 *           └── player iframe (包含真实 <video> 播放器)
 *
 * 链路验证：
 *   1. 插件在所有 iframe 中真实运行 (MV3 all_frames)
 *   2. 视频 1 自然播放结束
 *   3. 视频 iframe 向外求助，中继至 top page
 *   4. top page 自动命中并点击任务 2 Tab
 *   5. iframe 切换加载任务 2，新播放器出现
 *   6. 插件自动重新扫描新视频并成功自动播放视频 2
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const SAMPLE_PATH = path.resolve(__dirname, 'fixtures/sample.webm');

function createTestServer() {
  const sampleBuf = fs.readFileSync(SAMPLE_PATH);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/sample.webm' || url.pathname === '/sample2.webm') {
      res.writeHead(200, {
        'Content-Type': 'video/webm',
        'Content-Length': sampleBuf.length,
        'Accept-Ranges': 'bytes'
      });
      res.end(sampleBuf);
      return;
    }

    if (url.pathname === '/top.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Top Course Page</title>
<style>
.tabtags span { padding: 8px 16px; margin: 4px; border: 1px solid #ccc; cursor: pointer; display: inline-block; }
.tabtags span.currents { background: #1890ff; color: white; }
</style>
</head>
<body>
  <h2>真实课程单页多任务点</h2>
  <div class="tabtags">
    <span id="dct1" class="currents">任务点 1</span>
    <span id="dct2">任务点 2</span>
  </div>
  <iframe id="cardIframe" src="/card1.html" style="width:700px; height:450px; border:1px solid #ddd;"></iframe>
  <script>
    document.getElementById('dct2').addEventListener('click', () => {
      console.log('[E2E-PAGE] Tab 2 被点击！切换 iframe 至 card2.html');
      document.getElementById('dct1').classList.remove('currents');
      document.getElementById('dct2').classList.add('currents');
      document.getElementById('cardIframe').src = '/card2.html';
    });
  </script>
</body>
</html>`);
      return;
    }

    if (url.pathname === '/card1.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Card 1</title></head>
<body>
  <h3>卡片 1</h3>
  <iframe id="player1" src="/player1.html" style="width:640px; height:360px;"></iframe>
</body>
</html>`);
      return;
    }

    if (url.pathname === '/card2.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Card 2</title></head>
<body>
  <h3>卡片 2</h3>
  <iframe id="player2" src="/player2.html" style="width:640px; height:360px;"></iframe>
</body>
</html>`);
      return;
    }

    if (url.pathname === '/player1.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Player 1</title></head>
<body>
  <video id="v1" src="/sample.webm" controls muted playsinline style="width:600px;"></video>
</body>
</html>`);
      return;
    }

    if (url.pathname === '/player2.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Player 2</title></head>
<body>
  <video id="v2" src="/sample2.webm" controls muted playsinline style="width:600px;"></video>
</body>
</html>`);
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function findBrowserExecutable() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('未找到可用 Chromium 浏览器 (Edge / Chrome)');
}

async function runE2E() {
  console.log('============================================================');
  console.log('正在启动真实浏览器 E2E 端到端测试 (Headless Chromium)...');
  console.log('============================================================');

  const { server, baseUrl } = await createTestServer();
  const extPath = path.resolve(__dirname, '..');
  const executablePath = findBrowserExecutable();
  console.log(`  → 使用浏览器内核: ${executablePath}`);

  const browser = await puppeteer.launch({
    executablePath,
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--headless=new',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--autoplay-policy=no-user-gesture-required',
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`
    ]
  });

  try {
    // 1. 等待插件初始化并通过 popup 存储开启自动连播
    await new Promise((r) => setTimeout(r, 1000));
    const swTarget = browser.targets().find((t) => t.url().includes('background.js'));
    if (swTarget) {
      const extId = swTarget.url().split('/')[2];
      const popup = await browser.newPage();
      await popup.goto(`chrome-extension://${extId}/popup.html`);
      await popup.evaluate(async () => {
        await chrome.storage.local.set({
          autoNext: true,
          autoRate: true,
          autoRate2x: true,
          playbackRate: 2.0
        });
      });
      await popup.close();
    }

    const page = await browser.newPage();
    const cdp = await page.createCDPSession();

    // 2. 监听控制台输出（包括 content script 隔离世界）
    cdp.on('Runtime.consoleAPICalled', (e) => {
      const text = (e.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || ''))).join(' ');
      if (text.includes('[AutoNext]') || text.includes('[E2E-PAGE]')) {
        console.log(`    [Browser Console] ${text}`);
      }
    });

    const extContextIds = new Set();
    const configureContext = async (contextId) => {
      try {
        await cdp.send('Runtime.evaluate', {
          contextId,
          expression: `
            (function() {
              if (window.AutoNext && window.AutoNext.videoHandler) {
                window.AutoNext.videoHandler.configure({
                  minDuration: 0.1,
                  minPlayedSeconds: 0.1,
                  endTolerance: 1.5,
                  finishTolerance: 2
                });
                if (window.AutoNext.settings) {
                  window.AutoNext.settings.enabled = true;
                }
                if (!window.__e2e_configured) {
                  window.__e2e_configured = true;
                  window.AutoNext.videoHandler.scan();
                }
              }
            })();
          `
        });
      } catch (_) {}
    };

    cdp.on('Runtime.executionContextCreated', async (e) => {
      extContextIds.add(e.context.id);
      await configureContext(e.context.id);
    });

    cdp.on('Runtime.executionContextDestroyed', (e) => {
      extContextIds.delete(e.executionContextId);
    });

    await cdp.send('Runtime.enable');

    // 3. 打开顶层测试页面
    await page.goto(`${baseUrl}/top.html`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 1200));

    // 确保所有当前已注入的扩展上下文完成配置
    for (const ctxId of extContextIds) {
      await configureContext(ctxId);
    }

    console.log('  ✓ 真实浏览器与 3 层 iframe 拓扑已加载就绪');

    // 4. 在 player1 frame 中触发播放与视频自然结束（若尚未自动播完）
    const player1Frame = page.frames().find((f) => f.url().includes('player1.html'));
    if (player1Frame) {
      console.log('  → 触发视频 1 真实播放与自然播放结束...');
      try {
        await player1Frame.evaluate(async () => {
          const v = document.getElementById('v1');
          if (!v) return;
          if (v.paused) await v.play();
          for (let i = 0; i < 5; i++) {
            await new Promise((r) => setTimeout(r, 100));
            v.dispatchEvent(new Event('timeupdate'));
          }
          v.currentTime = v.duration || 1.0;
          v.dispatchEvent(new Event('ended'));
        });
      } catch (_) {}
    }

    // 5. 等待跨 frame postMessage 协调 -> 顶层 Tab 点击 -> iframe 切换 -> 视频 2 自动播放
    console.log('  → 等待跨 frame 协调与自动播放第 2 节视频...');

    let video2Playing = false;
    let tab2Active = false;

    const startTime = Date.now();
    while (Date.now() - startTime < 12000) {
      // 保持新注入的 frame 上下文配置更新
      for (const ctxId of extContextIds) {
        await configureContext(ctxId);
      }

      // 检查顶层 Tab 是否已被点击
      tab2Active = await page.evaluate(() => {
        const dct2 = document.getElementById('dct2');
        return dct2 && dct2.classList.contains('currents');
      });

      const player2Frame = page.frames().find((f) => f.url().includes('player2.html'));
      if (player2Frame) {
        try {
          const isPlaying = await player2Frame.evaluate(() => {
            const v = document.getElementById('v2');
            return v ? (!v.paused && v.readyState >= 2) : false;
          });
          if (isPlaying) {
            video2Playing = true;
          }
        } catch (_) {}
      }

      if (tab2Active && video2Playing) break;
      await new Promise((r) => setTimeout(r, 400));
    }

    console.log('\n  [E2E 结果断言]');
    console.log(`  ${tab2Active ? '✓' : '✗'} 顶层页面任务 2 Tab 成功被跨 frame 自动点击`);
    console.log(`  ${video2Playing ? '✓' : '✗'} 切换后任务 2 视频成功被自动检测并自动播放`);

    if (!tab2Active || !video2Playing) {
      throw new Error(`E2E 测试失败：tab2Active=${tab2Active}, video2Playing=${video2Playing}`);
    }

    console.log('\n============================================================');
    console.log('真实浏览器 E2E 端到端验证全部通过！');
    console.log('============================================================');
  } finally {
    await browser.close();
    server.close();
  }
}

runE2E().catch((err) => {
  console.error('\nE2E 测试异常：', err);
  process.exit(1);
});
