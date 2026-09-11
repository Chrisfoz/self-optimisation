/**
 * Shared by the browser evaluators: serve the working tree on localhost and
 * open the game in headless Chromium with every non-local request blocked,
 * so a measurement never depends on (or writes to) anything off this
 * machine — the feedback widget's Supabase calls included.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.json': 'application/json', '.svg': 'image/svg+xml' };

export function serve(root) {
  const server = http.createServer((req, res) => {
    const clean = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(root, clean === '/' ? 'index.html' : clean);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

/** Open the game at a phone viewport. Returns {page, close}. */
export async function openGame(repoRoot, { page: pageName = 'germ_fighter.html', viewport = { width: 390, height: 844 }, cpuThrottle = 1 } = {}) {
  const { chromium } = await import('playwright');
  const { server, origin } = await serve(repoRoot);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.route('**/*', (route) => (route.request().url().startsWith(origin) ? route.continue() : route.abort()));
  if (cpuThrottle > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });
  }
  await page.goto(`${origin}/${pageName}`, { waitUntil: 'load' });
  await page.waitForTimeout(500);
  return {
    page,
    close: async () => { await browser.close(); server.close(); },
  };
}

/** Start a level the way the start screen would, by the game's own function. */
export async function startLevel(page, level = 'easy') {
  await page.evaluate((lvl) => { window.startGame?.(lvl); }, level);
  await page.waitForTimeout(800);
}
