#!/usr/bin/env node

/**
 * Confirm the live product actually carries what was merged — the last
 * word in the campaign lifecycle, and the only check in this harness that
 * tests what's actually served rather than what's in a branch. Ported
 * from carrotgame's scripts/verify-production.mjs (the reference
 * implementation).
 *
 * ── Why this exists ────────────────────────────────────────────────────
 * The reference implementation's own incident: every gate passed, twenty-
 * three consecutive commits merged, tagged, and were emailed as
 * successes — for a deploy host that had silently stopped publishing
 * anything, for a reason (billing) that lives entirely outside the repo
 * and that no test inside it could see. Every other gate tests the agent
 * branch. Nothing tested the thing the project is actually for: a user
 * opening the real thing.
 *
 * Only the `url` verify strategy is ported here — the one with a complete,
 * battle-tested reference implementation. `registry` (did a package
 * registry actually publish the bumped version) and `artifact` (did a
 * build produce a runnable output) are named in the adapter schema
 * (`deployment.verify_strategy`) but not yet implemented — see
 * Portable-Harness-Design.md's Bucket B table. `none` is the honest
 * default for a project with no independently-verifiable deploy step.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);

/**
 * What is served is not always what is committed — a host can rewrite
 * HTML on the way out (attribute quoting, reordering, minification). A
 * byte comparison reports every page as permanently stale, which is worse
 * than no check at all: a signal that is always red gets muted, and then
 * real staleness goes unnoticed too.
 *
 * For HTML, two things typically survive a host's rewriting untouched,
 * and between them carry most of what a change can do to a page: the
 * contents of `<script>` blocks (where logic lives) and the visible text
 * (where a new control or label appears). A change invisible to both is a
 * change invisible to a user looking at the page.
 *
 * @param {string} source
 * @param {boolean} isHtml  False (e.g. for a .js file) compares the
 *   source verbatim, trailing whitespace aside.
 */
export function canonicalize(source, isHtml) {
  const s = source.replace(/\r\n/g, '\n');
  if (!isHtml) return s.trimEnd();

  const scripts = [...s.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1])
    .join('\n');

  const text = s
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return `${scripts}\n---\n${text}`;
}

/**
 * Compare one file's local (committed) content against what the live site
 * actually serves at the same relative path.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} opts.relative
 * @param {string} opts.siteUrl  No trailing slash.
 * @param {typeof fetch} [opts.fetchImpl]  Injectable for tests.
 */
export async function compareFile({ repoRoot, relative, siteUrl, fetchImpl = fetch }) {
  const isHtml = relative.endsWith('.html');
  const local = canonicalize(fs.readFileSync(path.join(repoRoot, relative), 'utf8'), isHtml);

  let remote;
  try {
    const res = await fetchImpl(`${siteUrl}/${relative}`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { relative, ok: false, detail: `HTTP ${res.status}` };
    remote = canonicalize(await res.text(), isHtml);
  } catch (err) {
    return { relative, ok: false, detail: `fetch failed: ${err.message}` };
  }

  const ok = local === remote;
  return { relative, ok, detail: ok ? sha(local) : `local ${sha(local)} vs live ${sha(remote)}` };
}

/**
 * Poll the live site until every watched file matches, or a timeout
 * elapses. A deploy is not instant — poll rather than assume — but bound
 * the wait so a permanently broken deploy fails the job instead of
 * hanging the runner.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string[]} opts.watchedFiles  The files a real visitor actually
 *   loads. A project's own `constitution.allowed_paths`, minus anything
 *   the host is known to mangle (the reference implementation excludes
 *   its stylesheet, since the host minifies CSS on the way out and a
 *   comparison that's permanently red teaches the loop to ignore it).
 * @param {string} opts.siteUrl
 * @param {number} [opts.timeoutMs]   Default 6 minutes.
 * @param {number} [opts.intervalMs]  Default 20 seconds.
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {(ms: number) => Promise<void>} [opts.sleep]  Injectable for tests.
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ok: boolean, attempts: number, results: Array}>}
 */
export async function verifyUrl({
  repoRoot,
  watchedFiles,
  siteUrl,
  timeoutMs = 6 * 60 * 1000,
  intervalMs = 20_000,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {},
}) {
  const site = siteUrl.replace(/\/$/, '');
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;

  while (true) {
    attempts++;
    const results = await Promise.all(watchedFiles.map((relative) => compareFile({ repoRoot, relative, siteUrl: site, fetchImpl })));
    const stale = results.filter((r) => !r.ok);

    for (const r of results) log(`   ${r.ok ? '✅' : '⏳'} ${r.relative.padEnd(24)} ${r.detail}`);

    if (stale.length === 0) {
      log(`\n✅ ${site} matches this commit, after ${attempts} check(s).`);
      return { ok: true, attempts, results };
    }

    if (Date.now() >= deadline) {
      log(
        `\n❌ ${site} is STALE after ${Math.round(timeoutMs / 60000)} minute(s). ` +
        `${stale.length} of ${watchedFiles.length} watched file(s) do not match this commit. ` +
        `The gates passed and the change merged, but it is not being served.`
      );
      return { ok: false, attempts, results };
    }

    log(`   …${stale.length} still stale, retrying in ${Math.round(intervalMs / 1000)}s\n`);
    await sleep(intervalMs);
  }
}

/**
 * Dispatch on a project's configured verify strategy. Only `url` is
 * implemented; `registry` and `artifact` are named but not yet built (see
 * this file's own doc comment); `none` is a deliberate, honest no-op for a
 * project with no independently-verifiable deploy step.
 */
export async function verifyDeployment(config, deps = {}) {
  const strategy = config.strategy ?? 'none';

  if (strategy === 'none') {
    return { ok: true, strategy, skipped: true, reason: 'deployment.verify_strategy is "none" — nothing to check' };
  }
  if (strategy === 'url') {
    const result = await verifyUrl({ ...config, ...deps });
    return { strategy, ...result };
  }
  throw new Error(`deployment.verify_strategy "${strategy}" is not implemented yet — only "url" and "none" are. See Portable-Harness-Design.md's Bucket B table.`);
}
