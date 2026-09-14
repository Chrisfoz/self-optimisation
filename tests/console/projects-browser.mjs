// Optional browser regression check for the console's projects list:
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node tests/console/projects-browser.mjs
// Uses a real console server and browser, with GitHub sign-in unconfigured.
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
  page.on('dialog', (dialog) => dialog.accept());
  const base = `http://127.0.0.1:${server.address().port}`;
  const names = () => page.locator('#project-list .project-name').allTextContents();
  const current = () => page.locator('#project-list .project[aria-current="true"] .project-name').textContent();
  const open = (name) => page.locator('#project-list li', { hasText: name }).locator('.project').click();
  // The fields live on steps that are hidden until reached, so set them the
  // way typing would: change the value, then let the form hear about it.
  const set = (id, value) => page.evaluate(([id, value]) => {
    const field = document.getElementById(id);
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }, [id, value]);
  const check = (selector) => page.evaluate((selector) => {
    const field = document.querySelector(selector);
    field.checked = true;
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }, selector);
  const value = (id) => page.evaluate((id) => document.getElementById(id).value, id);
  const checked = (name) => page.evaluate((name) =>
    [...document.querySelectorAll(`input[name=${name}]:checked`)].map((n) => n.value), name);
  const ready = () => page.waitForFunction(() =>
    document.querySelectorAll('#labs input').length > 0 && document.querySelector('#project-list .project'));

  // A draft saved before projects existed becomes the first project.
  await page.goto(base + '/console');
  await page.evaluate(() => sessionStorage.setItem('self-optimisation-draft', JSON.stringify({
    repository: 'owner/alpha', defaultBranch: 'main', labs: ['openai'], cadence: 'monthly',
    approvalClass: 'human-approval-required', maxAttempts: 3, maxFanout: 2, maxGenerationTokens: 500000,
  })));
  await page.reload();
  await ready();
  assert.deepEqual(await names(), ['owner/alpha']);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('self-optimisation-draft')), null);
  assert.equal(await page.locator('.project-remove').count(), 0, 'the only project cannot be removed');

  // Alpha's own choices, including the opt-in that must not travel.
  await check('input[name=lab][value=anthropic]');
  await set('implementModel', 'claude-opus-5');
  await set('reviewModel', 'gpt-5');
  await set('maxGenerationTokens', '750000');
  await check('input[name=cadence][value=weekly]');
  await check('input[name=approvalClass][value=autonomous-merge]');
  await set('deploymentUrl', 'https://alpha.example');
  await set('goal', 'Alpha goal');
  await set('testCommands', 'npm test');

  // A new project copies how the loop runs, not what the repository is.
  await page.locator('#new-project').click();
  assert.equal(await page.locator('#new-project-source').inputValue() !== '', true, 'defaults to the open project');
  await page.locator('#create-project').click();
  await page.waitForFunction(() => document.querySelectorAll('#project-list .project').length === 2);
  assert.deepEqual(await names(), ['owner/alpha', 'New project']);
  assert.equal(await current(), 'New project');
  assert.equal(await value('repository'), '');
  assert.deepEqual((await checked('lab')).sort(), ['anthropic', 'openai']);
  assert.equal(await value('implementModel'), 'claude-opus-5');
  assert.equal(await value('reviewModel'), 'gpt-5');
  assert.equal(await value('maxGenerationTokens'), '750000');
  assert.deepEqual(await checked('cadence'), ['weekly']);
  assert.deepEqual(await checked('approvalClass'), ['human-approval-required'], 'automatic merge is not copied');
  assert.equal(await value('deploymentUrl'), '');
  assert.equal(await value('goal'), '');
  assert.equal(await value('testCommands'), '');
  assert.equal(await page.locator('#new-project-form').isVisible(), false);

  // Each project keeps its own draft and its own place in the steps.
  await set('repository', 'owner/beta');
  await set('goal', 'Beta goal');
  await page.locator('#steps button').nth(3).click();
  await open('owner/alpha');
  assert.equal(await current(), 'owner/alpha');
  assert.equal(await value('goal'), 'Alpha goal');
  assert.deepEqual(await checked('approvalClass'), ['autonomous-merge']);
  assert.equal(await page.locator('#progress').textContent(), 'Step 1 of 10');
  await open('owner/beta');
  assert.equal(await value('goal'), 'Beta goal');
  assert.equal(await page.locator('#progress').textContent(), 'Step 4 of 10');
  assert.match(await page.locator('#project-list li', { hasText: 'owner/beta' }).textContent(), /Draft · step 4 of 10/);

  // Projects survive a reload, and the open one stays open.
  await page.reload();
  await ready();
  assert.deepEqual(await names(), ['owner/alpha', 'owner/beta']);
  assert.equal(await current(), 'owner/beta');
  assert.equal(await value('goal'), 'Beta goal');

  // Removing the open project opens another, and the last one stays.
  await page.locator('#project-list li', { hasText: 'owner/beta' }).locator('.project-remove').click();
  await page.waitForFunction(() => document.querySelectorAll('#project-list .project').length === 1);
  assert.deepEqual(await names(), ['owner/alpha']);
  assert.equal(await value('goal'), 'Alpha goal');

  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  console.log('PASS: legacy draft, new project from settings, opt-in not copied, per-project drafts and steps, reload, removal, mobile layout.');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
