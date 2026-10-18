#!/usr/bin/env node

/**
 * The harness's own version, and the one comparison anyone needs on it.
 *
 * "Install" is copying one folder (README quickstart, docs/INSTALL.md), which means a
 * vendored copy has no package manifest to say where it came from. This
 * file reads `harness/VERSION` — a one-line file bumped once per release,
 * which tags it (`.github/workflows/release.yml`) — so that a generated `project-adapter.yml`, every
 * `attempts.json`, and `init --check-upgrade` can all say which harness
 * produced them. Without that, "your copy has a fix you need" is a sentence
 * nobody can say to an installer.
 *
 * Pure apart from one read of the harness's own file. Never throws: an
 * installation whose VERSION file went missing reports 'unknown' and keeps
 * running, because a version stamp is provenance, not a gate.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where upstream publishes the current version — the raw file on the default branch. */
export const UPSTREAM_VERSION_URL = 'https://raw.githubusercontent.com/Chrisfoz/self-optimisation/main/harness/VERSION';

const VERSION_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'VERSION');

/** @returns {string} e.g. "0.1.0", or "unknown" when the file is absent or unreadable. */
export function harnessVersion({ file = VERSION_FILE } = {}) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    return /^\d+\.\d+\.\d+$/.test(raw) ? raw : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Compare two dotted versions. Returns -1, 0 or 1; `null` when either side
 * is not a version at all, so a caller can say "could not compare" rather
 * than pretending 'unknown' is older than everything.
 */
export function compareVersions(a, b) {
  const parse = (v) => (typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v.trim()) ? v.trim().split('.').map(Number) : null);
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Fetch upstream's VERSION and say whether the local copy is behind.
 * `fetchText` is injectable so tests never touch the network.
 *
 * @returns {Promise<{local: string, upstream: string|null, behind: boolean|null, error?: string}>}
 */
export async function checkUpgrade({ local = harnessVersion(), url = UPSTREAM_VERSION_URL, fetchText = defaultFetchText } = {}) {
  let upstream = null;
  try {
    upstream = (await fetchText(url)).trim();
  } catch (err) {
    return { local, upstream: null, behind: null, error: err.message };
  }
  const cmp = compareVersions(local, upstream);
  return { local, upstream, behind: cmp === null ? null : cmp < 0 };
}

async function defaultFetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.text();
}
