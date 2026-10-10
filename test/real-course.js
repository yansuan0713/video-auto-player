'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { root, openSession, collectConsole, evidence, redact } = require('./browser/session');
const { guardedBuild } = require('./browser/guarded-build');
const { observe, mediaState } = require('./browser/observe');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const local = path.join(root, '.local');
const output = path.join(root, 'test-results/real-course');
const statusFile = path.join(local, 'live-status.json');
const coursePage = page => {
  try { const url = new URL(page.url()); return url.hostname === 'mooc1.chaoxing.com' && url.pathname.startsWith('/mycourse/studentstudy'); }
  catch (_) { return false; }
};
function status(value) { fs.writeFileSync(statusFile, JSON.stringify(value, null, 2)); console.log(value.message || value.status); }

async function chapter(page) {
  return page.evaluate(() => {
    const active = document.querySelector('.posCatalog_active, .posCatalog_select_item.current, .tabtags .currents');
    return active ? String(active.id || active.textContent).trim().slice(0, 80) : '';
  }).catch(() => '');
}

async function budget(session, type, values = {}) {
  return session.popup.evaluate(({ type, values }) => Promise.race([
    chrome.runtime.sendMessage({ type, ...values }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Test navigation worker did not respond within 5 seconds')), 5000))
  ]), { type, values });
}

async function run() {
  fs.mkdirSync(local, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const configPath = path.join(local, 'real-test.json');
  if (!fs.existsSync(configPath)) {
    const unavailable = { kind: 'real-chaoxing', status: 'blocked', reason: '真实课程尚未配置。运行 npm run test:login -- --url <课程学习页URL> 一次。' };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(unavailable, null, 2));
    status({ status: 'blocked', message: unavailable.reason });
    return 2;
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const url = new URL(config.courseUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'mooc1.chaoxing.com' || !url.pathname.startsWith('/mycourse/studentstudy')) throw new Error('Expected a Chaoxing course study URL');
  let session;
  let nativeEvents = [];
  let consoleEvents = [];
  let previousSettings;
  const report = { kind: 'real-chaoxing', status: 'blocked', instrumentedNavigationGuard: true,
    limit: 2, behavior: { injected: false, playerDetected: false, nextFound: false, navigated: false, nextPlaying: false }, transitions: [] };
  try {
    session = await openSession({ profile: path.join(local, 'chaoxing-profile'), headed: true,
      late: true, extensionPath: guardedBuild(path.join(local, 'guarded-extension')) });
    await session.install();
    nativeEvents = await observe(session.context);
    consoleEvents = collectConsole(session.context, { real: true });
    const page = await session.context.newPage();
    session.page = page;
    await page.bringToFront();
    status({ status: 'opening', message: '正在独立测试浏览器中打开指定课程。' });
    await page.goto(config.courseUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    status({ status: 'awaiting_login', message: '若出现登录页，请在独立 Chromium 窗口手动登录；测试会自动识别课程播放器。' });
    const loginDeadline = Date.now() + (config.loginTimeoutMs || 10 * 60 * 1000);
    let detected = false;
    while (Date.now() < loginDeadline) {
      if (page.isClosed()) throw new Error('Test browser closed before course access');
      if (coursePage(page)) {
        const videos = await mediaState(page);
        if (videos.length) { detected = true; break; }
      }
      await pause(1000);
    }
    if (!detected) throw new Error('Login/course access requires user action, or selected chapter has no HTML5 player');
    await session.bind(page);
    const initial = await session.probe();
    report.behavior.injected = initial.some(row => row.frameId === 0 && row.status === 'ready')
      && initial.filter(row => row.videos.length).every(row => row.status === 'ready' && row.version === '1.2.6');
    report.behavior.playerDetected = initial.some(row => row.videos.length);
    report.behavior.nextFound = initial.some(row => row.candidates.some(candidate => candidate.score >= 40));
    if (!report.behavior.injected) throw new Error('Declarative extension startup is not ready in course/player frames');
    status({ status: 'ready', message: '登录及课程播放器已就绪，v1.2.6 已注入。' });
    if (process.argv.includes('--login')) {
      report.status = 'login_ready';
      await evidence(session, output, report, { real: true });
      return 0;
    }
    previousSettings = await session.popup.evaluate(() => chrome.storage.local.get(null));
    await session.settings({ autoNext: false, autoSkipNonVideo: false });
    const armed = await budget(session, 'QA_ARM', { limit: 2, hosts: ['mooc1.chaoxing.com'] });
    if (armed.remaining !== 2) throw new Error('Navigation budget could not be armed: ' + JSON.stringify(armed));
    const metadataDeadline = Date.now() + 45000;
    while (!(await mediaState(page)).some(video => video.readyState >= 1) && Date.now() < metadataDeadline) await pause(250);
    if (!(await mediaState(page)).some(video => video.readyState >= 1)) throw new Error('Player metadata unavailable');
    let previousChapter = await chapter(page);
    if (!previousChapter) throw new Error('Course chapter identity cannot be observed');
    let eventStart = nativeEvents.length;
    let priorMedia = await mediaState(page);
    await session.settings({ autoNext: true, autoRate: true, autoRate2x: true, playbackRate: 2,
      autoSkipNonVideo: false, siteSettings: {} });
    const deadline = Date.now() + (config.maxWaitMs || 60 * 60 * 1000);
    report.status = 'running';
    status({ status: 'running', message: '正在观察真实视频自然结束；最多允许两次导航点击。' });
    let awaiting = null;
    let lastHeartbeat = 0;
    while (Date.now() < deadline && report.transitions.length < 2) {
      if (!coursePage(page)) throw new Error('Course page left or platform verification requires user action');
      const currentChapter = await chapter(page);
      const currentMedia = await mediaState(page);
      if (Date.now() - lastHeartbeat > 15000) {
        lastHeartbeat = Date.now();
        fs.writeFileSync(statusFile, JSON.stringify({ status: 'running', transitions: report.transitions.length,
          behavior: report.behavior, media: currentMedia.map(video => ({ position: video.position, duration: video.duration, paused: video.paused, rate: video.rate })) }, null, 2));
      }
      const ended = nativeEvents.slice(eventStart).filter(event => event.kind === 'ended' && event.trusted
        && priorMedia.some(old => old.doc === event.doc && old.id === event.id && old.epoch === event.epoch && old.seeks === event.seeks));
      if (!awaiting && ended.length && currentChapter && currentChapter !== previousChapter) {
        report.behavior.navigated = true;
        const natural = ended[0];
        awaiting = { from: previousChapter, to: currentChapter, naturalEnd: true,
          endedAt: natural.at, navigationAt: Date.now(), first: currentMedia, firstAt: Date.now() };
      }
      if (awaiting) {
        if (!currentMedia.some(video => awaiting.first.some(before => before.doc === video.doc && before.id === video.id && before.epoch === video.epoch))) {
          awaiting.first = currentMedia;
        }
        const playing = currentMedia.find(video => !priorMedia.some(old => old.doc === video.doc && old.id === video.id && old.epoch === video.epoch)
          && !video.paused && !video.ended && video.readyState >= 2
          && awaiting.first.some(before => before.doc === video.doc && before.id === video.id
            && before.epoch === video.epoch && video.position > before.position + 0.05));
        const newPlayer = currentMedia.some(video => !priorMedia.some(old => old.doc === video.doc && old.id === video.id && old.epoch === video.epoch));
        if (playing && newPlayer) {
          report.transitions.push({ naturalEnd: true, chapterChanged: true, newPlayer: true, playbackAdvanced: true, rate: playing.rate });
          report.behavior.navigated = report.behavior.nextPlaying = true;
          previousChapter = currentChapter;
          priorMedia = [playing];
          eventStart = nativeEvents.length;
          awaiting = null;
          status({ status: 'running', message: `已独立确认第 ${report.transitions.length} 次章节切换及下一视频播放。` });
        } else if (Date.now() - awaiting.navigationAt > 45000) throw new Error('Chapter changed but new video playback was not independently confirmed');
      }
      const budgetState = await budget(session, 'QA_STATE');
      if (!awaiting && budgetState.remaining === 0 && report.transitions.length < 2 && ended.length && Date.now() - ended[0].at > 45000) throw new Error('Navigation click budget exhausted without two confirmed video transitions');
      if (ended.length && !awaiting && Date.now() - ended[0].at > 45000) throw new Error('Natural video ended without independently confirmed next chapter');
      await pause(1000);
    }
    if (report.transitions.length < 2) throw new Error('Natural-playback time limit reached before two confirmed transitions');
    report.status = 'passed';
    status({ status: 'passed', message: '真实学习通两次自然结束、章节切换及下一视频播放均已确认。' });
    await evidence(session, output, { ...report, nativeEvents, consoleEvents }, { real: true });
    return 0;
  } catch (error) {
    report.status = 'blocked';
    report.reason = redact(error.message);
    status({ status: 'blocked', message: report.reason });
    if (session) await evidence(session, output, { ...report, nativeEvents, consoleEvents }, { real: true });
    else fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    return 2;
  } finally {
    if (session?.popup) {
      await budget(session, 'QA_STOP').catch(() => {});
      if (previousSettings) await session.settings(previousSettings).catch(() => {});
    }
    if (session) await session.close().catch(() => {});
  }
}

const urlIndex = process.argv.indexOf('--url');
if (urlIndex >= 0) {
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, 'real-test.json'), JSON.stringify({ courseUrl: process.argv[urlIndex + 1] }, null, 2));
}
run().then(code => { process.exitCode = code; }).catch(error => { console.error(error.name + ': ' + redact(error.message));
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ kind: 'real-chaoxing', status: 'blocked', reason: redact(error.message), behavior: { injected: false, playerDetected: false, nextFound: false, navigated: false, nextPlaying: false } }, null, 2)); process.exitCode = 2; });
