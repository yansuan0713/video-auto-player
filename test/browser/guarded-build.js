'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { root } = require('./session');
function guardedBuild(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const files = new Set([...manifest.content_scripts[0].js, 'background.js', 'popup.js', 'popup.html']);
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(directory, file));
  }
  const workerSource = fs.readFileSync(path.join(__dirname, 'guard-worker.js'));
  const workerName = 'qa-worker-' + createHash('sha256').update(workerSource).digest('hex').slice(0, 12) + '.js';
  fs.writeFileSync(path.join(directory, workerName), workerSource);
  fs.copyFileSync(path.join(__dirname, 'navigation-guard.js'), path.join(directory, 'content/qa-navigation-guard.js'));
  manifest.background.service_worker = workerName;
  manifest.content_scripts[0].js.splice(manifest.content_scripts[0].js.indexOf('content/dom-utils.js') + 1, 0, 'content/qa-navigation-guard.js');
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return directory;
}
module.exports = { guardedBuild };
