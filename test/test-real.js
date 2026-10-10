'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const fixturesOnly = process.argv.includes('--fixtures-only');
const liveOnly = process.argv.includes('--live-only');
const output = path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
const summary = { fixtures: { status: liveOnly ? 'not_run' : 'running' }, chaoxing: { status: 'not_run' } };
function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' });
  return result.status === null ? 1 : result.status;
}
if (!liveOnly) {
  const code = run(require.resolve('@playwright/test/cli'), ['test']);
  summary.fixtures.status = code === 0 ? 'passed' : 'failed';
  if (code !== 0) {
    fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log('本地浏览器行为失败，已保存证据；真实课程未启动。');
    process.exit(code);
  }
}
let code = 0;
if (!fixturesOnly) {
  const started = Date.now();
  code = run(path.join(__dirname, 'real-course.js'), []);
  const report = path.join(output, 'real-course/report.json');
  summary.chaoxing = fs.existsSync(report) && fs.statSync(report).mtimeMs >= started ? JSON.parse(fs.readFileSync(report, 'utf8')) : { status: 'blocked' };
}
fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`模拟页面真实浏览器：${summary.fixtures.status}；真实学习通：${summary.chaoxing.status}`);
process.exitCode = code;
