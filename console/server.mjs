#!/usr/bin/env node

/**
 * The console's server — step 1 of console/DESIGN.md §11: one small Node
 * service that anyone can deploy (Railway via the repo's railway.json, or
 * anywhere that runs `npm start`), serving the console's pages today and
 * growing the GitHub App endpoints §8.5 describes next.
 *
 * Zero dependencies, like the harness it fronts: node:http and node:fs only.
 *
 * What it serves is an explicit route table, not a directory. The console
 * folder also holds DESIGN.md and the Supabase migrations; a static-file
 * server pointed at it would publish them, and a path-traversal bug would
 * publish the rest of the repository. A table cannot do either — a path it
 * doesn't name is a 404.
 *
 * The pages are authored as body fragments (no <html>, no <head>), the shape
 * a claude.ai artifact takes. The site nav and footer are not in them: each
 * lives once in console/partials/, and a page says where it goes with an
 * `<!-- include:nav -->` marker. renderPage() inlines those, marks the nav
 * link for the page being served, gives the result the same skeleton the
 * artifact host does — charset, viewport, and its small reset — and rewrites
 * any remaining claude.ai cross-links to this server's own routes, since an
 * artifact link is private to its owner and would dead-end every visitor.
 * A page's raw file is therefore no longer a complete artifact on its own;
 * publish the served page instead.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessVersion } from '../harness/lib/version.mjs';

const CONSOLE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Route → page fragment in console/. With PARTIALS, the only files this server will ever read. */
export const PAGES = {
  '/': 'about.html',
  '/how-to-run': 'how-to-run.html',
  '/console': 'mockup.html',
  '/privacy': 'privacy.html',
};

/** Markup every page shares, kept in one file each and pulled in by an include marker. Never served on its own. */
export const PARTIALS = {
  nav: 'partials/nav.html',
  footer: 'partials/footer.html',
};

const INCLUDE_MARKER = /<!--\s*include:([\w-]+)\s*-->/g;

/** The artifact each page is also published as, so its links can point here instead. */
export const ARTIFACT_ROUTES = {
  '34273fb4-75b4-4e09-af44-159ccc9677e7': '/',
  '00efd905-19bd-4d79-a613-e63182556742': '/console',
  '476e81da-9930-46fb-bfb8-08b0c5a4911d': '/privacy',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
};

/**
 * Assemble a page: inline its partials, mark the link to `route` as the
 * current page, wrap it in the artifact host's skeleton, and localise links.
 * An include naming a partial that doesn't exist throws — at boot, since
 * createConsoleServer() renders every page up front.
 */
export function renderPage(fragment, { route, partials = {} } = {}) {
  const assembled = fragment.replace(INCLUDE_MARKER, (marker, name) => {
    if (!Object.hasOwn(partials, name)) throw new Error(`page includes unknown partial "${name}"`);
    return route ? partials[name].replaceAll(`href="${route}"`, `href="${route}" aria-current="page"`) : partials[name];
  });
  const body = assembled.replace(
    /https:\/\/claude\.ai\/code\/artifact\/([0-9a-f-]{36})/g,
    (url, id) => ARTIFACT_ROUTES[id] ?? url,
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>:root{color-scheme:light}body{margin:0;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#fafaf8}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

/**
 * Build the server. Pages are read and rendered once, up front: a deploy's
 * files never change under it, and a missing page should stop the service
 * at boot rather than 500 on the first visitor.
 */
export function createConsoleServer({ dir = CONSOLE_DIR, version = harnessVersion() } = {}) {
  const read = (file) => fs.readFileSync(path.join(dir, file), 'utf8');
  const partials = Object.fromEntries(Object.entries(PARTIALS).map(([name, file]) => [name, read(file)]));
  const rendered = new Map(
    Object.entries(PAGES).map(([route, file]) => [route, renderPage(read(file), { route, partials })]),
  );
  const health = JSON.stringify({ ok: true, harness: version });

  return http.createServer((req, res) => {
    const send = (status, type, body, extra = {}) => {
      res.writeHead(status, { 'content-type': type, ...SECURITY_HEADERS, ...extra });
      res.end(req.method === 'HEAD' ? undefined : body);
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(405, 'text/plain; charset=utf-8', 'Method not allowed\n', { allow: 'GET, HEAD' });
    }
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/healthz') {
      return send(200, 'application/json', health, { 'cache-control': 'no-store' });
    }
    const page = rendered.get(pathname);
    if (page) {
      return send(200, 'text/html; charset=utf-8', page, { 'cache-control': 'no-cache' });
    }
    return send(404, 'text/plain; charset=utf-8', 'Not found\n');
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const server = createConsoleServer().listen(port, () => {
    console.log(`console listening on :${port} (harness ${harnessVersion()})`);
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
