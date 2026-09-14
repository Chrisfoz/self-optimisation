// Optional browser regression check: PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node tests/console/github-browser.mjs
// Uses a real console server and browser, with GitHub-facing API results simulated.
import assert from 'node:assert/strict';
import { createConsoleServer } from '../../console/server.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = createConsoleServer({ env: {} });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  let revoked = false;
  let fail = false;
  let releaseSlow;
  const slow = new Promise((resolve) => { releaseSlow = resolve; });
  const repos = [
    { name: 'owner/alpha', owner: 'owner', private: true, description: 'Calculator' },
    { name: 'team/beta', owner: 'team', private: false, description: 'Research' },
    { name: 'team/slow', owner: 'team', private: true, description: 'Slow response' },
  ];
  await page.route('**/api/session', (route) => route.fulfill({ json: {
    configured: true, connected: true, login: 'owner', csrf: 'test-only',
    installUrl: 'https://github.com/apps/example/installations/new',
  } }));
  await page.route('**/api/repositories', (route) => route.fulfill({
    status: revoked ? 401 : 200,
    json: revoked ? { error: 'GitHub sign-in expired. Sign in again.' } : { repositories: repos },
  }));
  await page.route('**/api/repository?*', async (route) => {
    const name = new URL(route.request().url()).searchParams.get('repository');
    if (name === 'team/slow') await slow;
    await route.fulfill({ status: fail ? 403 : 200, json: fail ? { error: 'Access removed.' } : {
      name, defaultBranch: name === 'owner/alpha' ? 'develop' : 'main',
      tree: [{ path: `${name.split('/')[1]}.js`, type: 'blob' }], existingSetup: false,
    } });
  });
  await page.route('**/api/setup?*', (route) => route.fulfill({ json: { setup: null } }));
  // Connecting a repository also reads its live model list. Unmocked, that
  // request reaches the real server with no session cookie, gets a 401, and
  // signs this simulated session out a moment after it connects.
  await page.route('**/api/models*', (route) => route.fulfill({ json: {
    labs: [], counts: { bundled: 0, repository: 0, unseen: 0 }, fetchedAt: null,
    repository: null, snapshotPath: null, snapshotReason: null,
  } }));
  await page.goto(base + '/console');
  await page.waitForFunction(() => document.querySelector('#repo-count').textContent.includes('3 of 3'));
  await page.locator('#repo-search').fill('Calculator');
  assert.equal(await page.locator('#repo-picker option').count(), 2);
  await page.locator('#repo-search').fill('');
  await page.locator('#repo-owner').selectOption('team');
  assert.equal(await page.locator('#repo-picker option').count(), 3);
  await page.locator('#repo-owner').selectOption('');
  await page.locator('#repo-picker').selectOption('owner/alpha');
  await page.waitForFunction(() => document.querySelector('#repo-state').textContent.startsWith('Connected to owner/alpha'));
  assert.equal(await page.locator('#defaultBranch').inputValue(), 'develop');
  await page.locator('#repo-picker').selectOption('team/slow');
  assert.equal(await page.locator('#tree').textContent(), '');
  assert.equal(await page.locator('#open-pr').isDisabled(), true);
  await page.locator('#repo-picker').selectOption('team/beta');
  await page.waitForFunction(() => document.querySelector('#repo-state').textContent.startsWith('Connected to team/beta'));
  const slowFinished = page.waitForResponse((r) => r.url().includes('repository=team%2Fslow'));
  releaseSlow();
  await slowFinished;
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#repository').inputValue(), 'team/beta');
  fail = true;
  await page.locator('#repo-picker').selectOption('owner/alpha');
  await page.waitForFunction(() => document.querySelector('#global-status').textContent === 'Access removed.');
  assert.equal(await page.locator('#tree').textContent(), '');
  assert.equal(await page.locator('#open-pr').isDisabled(), true);
  fail = false;
  await page.locator('#repo-picker').selectOption('team/beta');
  await page.waitForFunction(() => document.querySelector('#repo-state').textContent.startsWith('Connected to team/beta'));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  revoked = true;
  await page.locator('#refresh-repos').click();
  await page.waitForFunction(() => !document.querySelector('#sign-in').hidden);
  assert.equal(await page.locator('#repo-picker-field').isVisible(), false);
  assert.equal(await page.locator('#open-pr').isDisabled(), true);
  await page.goto(base + '/');
  assert.ok((await page.locator('body').innerText()).length > 100);
  assert.deepEqual(errors, []);
  console.log('PASS: search, accounts, connection, stale responses, access removal, expired session, mobile layout and home navigation.');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
