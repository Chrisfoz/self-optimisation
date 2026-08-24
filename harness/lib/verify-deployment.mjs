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
 * `url` is the one ported from a complete, battle-tested reference
 * implementation (carrotgame's own `verify-production.mjs`). `registry`
 * (did a package registry actually publish the bumped version) and
 * `artifact` (did a build produce a runnable output) have no reference
 * implementation to port — carrotgame ships no package and no build step —
 * so they're real, new, per-ecosystem work instead: npm, PyPI, NuGet and
 * Maven Central each expose a differently-shaped API for "does this
 * version exist," and a build/smoke check is inherently project-specific
 * (the harness owns the mechanism — run a command, check a path, run
 * another command — the project supplies which commands and which path).
 * `none` is the honest default for a project with no independently-
 * verifiable deploy step.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'node:child_process';

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

// --- registry strategy ------------------------------------------------------
//
// "Did the package registry actually publish the version we just tagged" —
// the registry equivalent of `verifyUrl`'s "did the live site actually
// start serving what we merged." Every ecosystem below answers that with a
// different shaped API; each checker takes the same {package, groupId,
// artifactId, version, registryUrl, fetchImpl} bag and returns the same
// {ok, detail} shape so verifyRegistry() can poll any of them identically.

/** npm — `GET /{package}/{version}` 200s iff that exact version exists. */
export async function checkNpm({ package: pkg, version, registryUrl = 'https://registry.npmjs.org', fetchImpl = fetch }) {
  const url = `${registryUrl.replace(/\/$/, '')}/${encodeURIComponent(pkg)}/${encodeURIComponent(version)}`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
    return res.ok
      ? { ok: true, detail: `npm ${pkg}@${version} found` }
      : { ok: false, detail: `npm ${pkg}@${version}: HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: `npm ${pkg}@${version}: fetch failed: ${err.message}` };
  }
}

/** PyPI — `GET /pypi/{package}/{version}/json` 200s iff that exact version exists. */
export async function checkPypi({ package: pkg, version, registryUrl = 'https://pypi.org/pypi', fetchImpl = fetch }) {
  const url = `${registryUrl.replace(/\/$/, '')}/${encodeURIComponent(pkg)}/${encodeURIComponent(version)}/json`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
    return res.ok
      ? { ok: true, detail: `PyPI ${pkg}==${version} found` }
      : { ok: false, detail: `PyPI ${pkg}==${version}: HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: `PyPI ${pkg}==${version}: fetch failed: ${err.message}` };
  }
}

/**
 * NuGet — the flat-container index (`GET /{id-lower}/index.json`) lists
 * every published version for a package in one response; no per-version
 * endpoint exists on this API, so the check is "is version a member of the
 * list" rather than a single fetch that 404s or doesn't.
 */
export async function checkNuget({ package: pkg, version, registryUrl = 'https://api.nuget.org/v3-flatcontainer', fetchImpl = fetch }) {
  const url = `${registryUrl.replace(/\/$/, '')}/${encodeURIComponent(pkg.toLowerCase())}/index.json`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return { ok: false, detail: `NuGet ${pkg}: HTTP ${res.status}` };
    const body = await res.json();
    const versions = Array.isArray(body?.versions) ? body.versions : [];
    const found = versions.includes(version);
    return found
      ? { ok: true, detail: `NuGet ${pkg} ${version} found` }
      : { ok: false, detail: `NuGet ${pkg} has ${versions.length} version(s) published, ${version} not among them` };
  } catch (err) {
    return { ok: false, detail: `NuGet ${pkg} ${version}: fetch failed: ${err.message}` };
  }
}

/**
 * Maven Central — no per-artifact JSON API; `solrsearch` is Central's own
 * search index over published GAV (groupId:artifactId:version) coordinates,
 * the same one https://search.maven.org itself queries.
 */
export async function checkMaven({ groupId, artifactId, version, registryUrl = 'https://search.maven.org/solrsearch/select', fetchImpl = fetch }) {
  const q = `g:${groupId} AND a:${artifactId} AND v:${version}`;
  const url = `${registryUrl}?q=${encodeURIComponent(q)}&core=gav&rows=1&wt=json`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return { ok: false, detail: `Maven Central ${groupId}:${artifactId}:${version}: HTTP ${res.status}` };
    const body = await res.json();
    const found = (body?.response?.numFound ?? 0) > 0;
    return found
      ? { ok: true, detail: `Maven Central ${groupId}:${artifactId}:${version} found` }
      : { ok: false, detail: `Maven Central ${groupId}:${artifactId}:${version} not found` };
  } catch (err) {
    return { ok: false, detail: `Maven Central ${groupId}:${artifactId}:${version}: fetch failed: ${err.message}` };
  }
}

export const REGISTRY_CHECKERS = { npm: checkNpm, pypi: checkPypi, nuget: checkNuget, maven: checkMaven };

/**
 * Poll a package registry until the tagged version shows up, or a timeout
 * elapses — the same shape as verifyUrl(), for the same reason: a publish
 * step returning success doesn't guarantee the registry's own read path
 * (search index, CDN-fronted flat-container file) reflects it instantly.
 *
 * @param {object} opts
 * @param {'npm'|'pypi'|'nuget'|'maven'} opts.ecosystem
 * @param {string} [opts.package]    Required for npm/pypi/nuget.
 * @param {string} [opts.groupId]    Required for maven.
 * @param {string} [opts.artifactId] Required for maven.
 * @param {string} opts.version
 * @param {string} [opts.registryUrl]  Override the public registry — a
 *   private/mirrored registry with the same API shape, or a test double.
 * @param {number} [opts.timeoutMs]   Default 6 minutes, same as verifyUrl.
 * @param {number} [opts.intervalMs]  Default 20 seconds.
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {(msg: string) => void} [opts.log]
 */
export async function verifyRegistry({
  ecosystem,
  package: pkg,
  groupId,
  artifactId,
  version,
  registryUrl,
  timeoutMs = 6 * 60 * 1000,
  intervalMs = 20_000,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {},
}) {
  const checker = REGISTRY_CHECKERS[ecosystem];
  if (!checker) {
    throw new Error(`deployment.registry.ecosystem "${ecosystem}" is not supported. Known: ${Object.keys(REGISTRY_CHECKERS).join(', ')}.`);
  }
  if (!version) throw new Error('deployment.registry.version is required.');
  if (ecosystem === 'maven') {
    if (!groupId || !artifactId) throw new Error('deployment.registry.group_id and .artifact_id are both required for the "maven" ecosystem.');
  } else if (!pkg) {
    throw new Error(`deployment.registry.package is required for the "${ecosystem}" ecosystem.`);
  }

  const deadline = Date.now() + timeoutMs;
  let attempts = 0;

  while (true) {
    attempts++;
    const result = await checker({ package: pkg, groupId, artifactId, version, registryUrl, fetchImpl });
    log(`   ${result.ok ? '✅' : '⏳'} ${result.detail}`);

    if (result.ok) {
      log(`\n✅ ${ecosystem} registry carries this version, after ${attempts} check(s).`);
      return { ok: true, attempts, ecosystem, detail: result.detail };
    }

    if (Date.now() >= deadline) {
      log(`\n❌ ${ecosystem} registry does NOT carry this version after ${Math.round(timeoutMs / 60000)} minute(s). The gates passed, but the publish step's result isn't visible yet — or never landed.`);
      return { ok: false, attempts, ecosystem, detail: result.detail };
    }

    log(`   …retrying in ${Math.round(intervalMs / 1000)}s\n`);
    await sleep(intervalMs);
  }
}

// --- artifact strategy -------------------------------------------------------

/** Default command runner — shells out for real. Injectable, same convention as guard.mjs's `git` and promote.mjs's `gitFactory`. */
function defaultExec(cmd, { cwd }) {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

/**
 * Did a build produce a runnable output — the artifact equivalent of a
 * deploy check for a project with no live URL and no package registry
 * (a CLI, a library bundle, a compiled binary). Three independent, all-
 * optional checks, run in order, any one of which can fail the whole
 * strategy: build the project, confirm the expected output exists on disk,
 * then optionally run it (or a smoke-test wrapper around it) and require a
 * clean exit.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} [opts.buildCommand]  Shell command, run via the project's
 *   own shell — e.g. `npm run build`. Skipped if unset (a project whose
 *   test suite already builds as a side effect, say).
 * @param {string} [opts.path]  Path (relative to repoRoot) the build must
 *   have produced — a file or a directory. Skipped if unset.
 * @param {string} [opts.smokeCommand]  Shell command that must exit 0 —
 *   e.g. `node dist/cli.js --version`. Skipped if unset.
 * @param {(cmd: string, opts: {cwd: string}) => string} [opts.exec]
 *   Injectable command runner, for tests.
 * @param {(msg: string) => void} [opts.log]
 */
export async function verifyArtifact({ repoRoot, buildCommand, path: artifactPath, smokeCommand, exec = defaultExec, log = () => {} }) {
  if (buildCommand) {
    log(`   running build: ${buildCommand}`);
    try {
      exec(buildCommand, { cwd: repoRoot });
    } catch (err) {
      return { ok: false, detail: `build command failed: ${err.message}` };
    }
  }

  if (artifactPath) {
    const full = path.join(repoRoot, artifactPath);
    if (!fs.existsSync(full)) {
      return { ok: false, detail: `expected artifact at "${artifactPath}", not found after the build` };
    }
    log(`   ✅ artifact present: ${artifactPath}`);
  }

  if (smokeCommand) {
    log(`   running smoke check: ${smokeCommand}`);
    try {
      exec(smokeCommand, { cwd: repoRoot });
    } catch (err) {
      return { ok: false, detail: `smoke command failed: ${err.message}` };
    }
    log('   ✅ smoke check passed');
  }

  return { ok: true, detail: 'artifact build/path/smoke checks all passed' };
}

/**
 * Dispatch on a project's configured verify strategy. `none` is a
 * deliberate, honest no-op for a project with no independently-verifiable
 * deploy step; the other three each test a different notion of "did the
 * thing that was just merged actually ship."
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
  if (strategy === 'registry') {
    const result = await verifyRegistry({ ...config.registry, ...deps });
    return { strategy, ...result };
  }
  if (strategy === 'artifact') {
    const result = await verifyArtifact({ repoRoot: config.repoRoot, ...config.artifact, ...deps });
    return { strategy, ...result };
  }
  throw new Error(`deployment.verify_strategy "${strategy}" is not recognised. Known: url, registry, artifact, none.`);
}
