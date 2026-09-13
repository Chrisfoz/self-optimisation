import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createConsoleServer, renderPage, PAGES, PARTIALS, ARTIFACT_ROUTES } from '../../console/server.mjs';

let server;
let base;

before(async () => {
  server = createConsoleServer({ version: '9.9.9' });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('every routed page is served as a full UTF-8 document with security headers', async () => {
  for (const route of Object.keys(PAGES)) {
    const res = await fetch(base + route);
    assert.equal(res.status, 200, route);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    const html = await res.text();
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<meta charset="utf-8">/);
    assert.match(html, /<title>/, `${route} lost its title`);
  }
});

test('healthz reports ok and the harness version, uncached', async () => {
  const res = await fetch(base + '/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { ok: true, harness: '9.9.9' });
});

test('only the route table is served — console files, source and traversal are all 404', async () => {
  for (const p of ['/about.html', '/DESIGN.md', '/server.mjs', '/supabase/README.md',
    '/partials/nav.html', '/partials/footer.html',
    '/../package.json', '/%2e%2e/package.json', '/console/', '/nope']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 404, p);
    await res.body?.cancel();
  }
});

test('a query string does not change which page is served', async () => {
  const res = await fetch(base + '/privacy?utm_source=x');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Privacy/);
});

test('HEAD answers without a body, and anything but GET/HEAD is refused', async () => {
  const head = await fetch(base + '/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const post = await fetch(base + '/', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
});

test('served pages carry no claude.ai artifact links — each points at its local route', async () => {
  for (const route of Object.keys(PAGES)) {
    const html = await (await fetch(base + route)).text();
    assert.doesNotMatch(html, /claude\.ai\/code\/artifact\//, route);
  }
});

test('renderPage maps known artifact ids to routes and leaves unknown ones alone', () => {
  const [id, route] = Object.entries(ARTIFACT_ROUTES)[0];
  const unknown = 'https://claude.ai/code/artifact/00000000-0000-0000-0000-000000000000';
  const html = renderPage(`<a href="https://claude.ai/code/artifact/${id}">x</a><a href="${unknown}">y</a>`);
  assert.match(html, new RegExp(`href="${route}"`));
  assert.ok(html.includes(unknown));
});

test('every page gets the shared nav and footer exactly once, with no include marker left behind', async () => {
  for (const route of Object.keys(PAGES)) {
    const html = await (await fetch(base + route)).text();
    assert.equal(html.match(/<header class="topbar"/g)?.length, 1, `${route} header`);
    assert.equal(html.match(/<footer class="wrap footer"/g)?.length, 1, `${route} footer`);
    assert.doesNotMatch(html, /<!--\s*include:/, route);
  }
});

test('no page file carries its own nav or footer — each includes the shared partials', () => {
  for (const [route, file] of Object.entries(PAGES)) {
    const src = fs.readFileSync(new URL('../../console/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /<header class="topbar"|<footer[^>]*class="[^"]*footer/, `${file} embeds its own header or footer`);
    assert.match(src, /<!--\s*include:nav\s*-->/, `${route} is missing the nav include`);
    assert.match(src, /<!--\s*include:footer\s*-->/, `${route} is missing the footer include`);
  }
});

test('the nav marks exactly the page being served as current', async () => {
  for (const route of Object.keys(PAGES)) {
    const html = await (await fetch(base + route)).text();
    const start = html.indexOf('<nav aria-label="Site">');
    const nav = html.slice(start, html.indexOf('</nav>', start));
    const current = [...nav.matchAll(/href="([^"]*)" aria-current="page"/g)].map((m) => m[1]);
    assert.deepEqual(current, [route], route);
  }
});

test('every nav link to this site points at a real route', () => {
  const nav = fs.readFileSync(new URL('../../console/' + PARTIALS.nav, import.meta.url), 'utf8');
  for (const [, href] of nav.matchAll(/href="(\/[^"]*)"/g)) assert.ok(href in PAGES, href);
});

test('no page has an inline script, which the content security policy would block', async () => {
  for (const route of Object.keys(PAGES)) {
    const html = await (await fetch(base + route)).text();
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, route);
  }
  const res = await fetch(base + '/assets/how-to-run.mjs');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
  await res.body?.cancel();
});

test('renderPage refuses a page that includes a partial that does not exist', () => {
  assert.throws(() => renderPage('<!-- include:sidebar -->', { route: '/', partials: { nav: '' } }), /unknown partial "sidebar"/);
});

test('every route in ARTIFACT_ROUTES is a real page route', () => {
  for (const route of Object.values(ARTIFACT_ROUTES)) assert.ok(route in PAGES, route);
});

test('a missing page stops the server at construction, not on the first request', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'console-'));
  assert.throws(() => createConsoleServer({ dir: empty }), /ENOENT/);
});
