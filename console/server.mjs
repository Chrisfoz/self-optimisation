#!/usr/bin/env node

/**
 * One Node service for the console, generator API and GitHub App user flow.
 * Explicit page/asset/API routes only: source, migrations and environment files
 * are never served. The console generates configuration; GitHub Actions runs it.
 *
 * Pages are body fragments (no <html>, no <head>). The site header and footer
 * are not in them: each lives once in console/partials/, and a page marks where
 * it goes with an `<!-- include:nav -->` or `<!-- include:footer -->` comment.
 * renderPage() inlines them and marks the link to the page being served.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApi } from "./api.mjs";
import { harnessVersion } from "../harness/lib/version.mjs";

const CONSOLE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Route → page fragment in console/. With PARTIALS, the only files this server will ever read. */
export const PAGES = {
  "/": "about.html",
  "/how-to-run": "how-to-run.html",
  "/console": "mockup.html",
  "/privacy": "privacy.html",
};

/** Markup every page shares, kept in one file each and pulled in by an include marker. Never served on its own. */
export const PARTIALS = {
  nav: "partials/nav.html",
  footer: "partials/footer.html",
};

const INCLUDE_MARKER = /<!--\s*include:([\w-]+)\s*-->/g;

/** The artifact each page is also published as, so its links can point here instead. */
export const ARTIFACT_ROUTES = {
  "34273fb4-75b4-4e09-af44-159ccc9677e7": "/",
  "00efd905-19bd-4d79-a613-e63182556742": "/console",
  "476e81da-9930-46fb-bfb8-08b0c5a4911d": "/privacy",
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://github.com",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
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
export function createConsoleServer({
  dir = CONSOLE_DIR,
  version = harnessVersion(),
  env = process.env,
  fetchImpl = fetch,
  sessions,
} = {}) {
  const read = (file) => fs.readFileSync(path.join(dir, file), "utf8");
  const partials = Object.fromEntries(
    Object.entries(PARTIALS).map(([name, file]) => [name, read(file)]),
  );
  const rendered = new Map(
    Object.entries(PAGES).map(([route, file]) => [
      route,
      renderPage(read(file), { route, partials }),
    ]),
  );
  const health = JSON.stringify({ ok: true, harness: version });

  const api = createApi({ env, fetchImpl, sessions });
  const assets = new Map(
    [
      ["/assets/console.css", ["text/css; charset=utf-8", "console.css"]],
      ["/assets/app.mjs", ["text/javascript; charset=utf-8", "app.mjs"]],
      ["/assets/how-to-run.mjs", ["text/javascript; charset=utf-8", "how-to-run.mjs"]],
    ].map(([route, [type, file]]) => [
      route,
      { type, body: fs.readFileSync(path.join(dir, file), "utf8") },
    ]),
  );
  return http.createServer(async (req, res) => {
    const send = (status, type, body, extra = {}) => {
      res.writeHead(status, {
        "content-type": type,
        ...SECURITY_HEADERS,
        ...extra,
      });
      res.end(req.method === "HEAD" ? undefined : body);
    };

    let url;
    try { url = new URL(req.url, "http://localhost"); }
    catch { return send(400, "text/plain; charset=utf-8", "Invalid request URL\n"); }
    if (await api(req, res, url, send)) return;
    if (req.method !== "GET" && req.method !== "HEAD") {
      return send(405, "text/plain; charset=utf-8", "Method not allowed\n", {
        allow: "GET, HEAD",
      });
    }
    const { pathname } = url;
    if (pathname === "/healthz") {
      return send(200, "application/json", health, {
        "cache-control": "no-store",
      });
    }
    const asset = assets.get(pathname);
    if (asset)
      return send(200, asset.type, asset.body, { "cache-control": "no-cache" });
    const page = rendered.get(pathname);
    if (page) {
      return send(200, "text/html; charset=utf-8", page, {
        "cache-control": "no-cache",
      });
    }
    return send(404, "text/plain; charset=utf-8", "Not found\n");
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.env.PORT) || 3000;
  const server = createConsoleServer().listen(port, () => {
    console.log(`console listening on :${port} (harness ${harnessVersion()})`);
  });
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}
