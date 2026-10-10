'use strict';
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './test/browser', testMatch: '**/*.spec.js', timeout: 90000, workers: 1,
  retries: 0, fullyParallel: false,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }], ['json', { outputFile: 'test-results/playwright.json' }]],
  outputDir: 'test-results/fixtures',
  expect: { timeout: 45000 }
});
