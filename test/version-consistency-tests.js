'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const popupHtml = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
const popupJs = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

check(pkg.version === manifest.version,
  `package.json (${pkg.version}) 与 manifest.json (${manifest.version}) 版本不一致`);
check(!/v\d+\.\d+\.\d+/.test(popupHtml),
  'popup.html 不应硬编码可见版本号');
check(popupHtml.includes('id="extensionVersionBadge"'),
  'popup.html 缺少标题版本占位元素');
check(popupHtml.includes('id="extensionBuildInfo"'),
  'popup.html 缺少底部版本占位元素');
check(popupJs.includes('chrome.runtime.getManifest().version'),
  'popup.js 必须从 manifest 读取扩展版本');

if (failures.length) {
  console.error('版本一致性检查失败：');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`版本一致性检查通过：v${manifest.version}`);
