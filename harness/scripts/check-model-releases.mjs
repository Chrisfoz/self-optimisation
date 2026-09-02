#!/usr/bin/env node

/**
 * CLI entry point for harness/lib/model-release-detector.mjs. Run from a
 * target project's root (not from inside this harness) — every path below
 * is resolved against `process.cwd()`, since a portable script cannot
 * assume the target project's layout the way the reference implementation's
 * original, repo-relative version could.
 *
 * Logs go to stderr; the JSON result goes to stdout — the same contract the
 * reference implementation's check-model-releases.mjs used, so a workflow
 * step can pipe this straight into `release-check.json` unchanged.
 *
 * Configuration, in order of precedence — most specific wins:
 *
 *   1. CLI flag              --providers / --snapshot / --max-fanout
 *   2. Environment variable  PROVIDERS_WATCHED / MODEL_SNAPSHOT_PATH / MAX_FANOUT
 *   3. project-adapter.yml   providers.watched / providers.snapshot_path / providers.max_fanout
 *   4. Built-in default      every registered provider / .agent/model-snapshot.json / 8
 *
 * The adapter file is read via harness/lib/adapter.mjs — the one file in
 * this harness that knows about YAML — and is entirely optional: a project
 * with no project-adapter.yml yet just falls through to env vars and
 * defaults, unchanged from before this file learned to read one.
 */

import fs from 'fs';
import path from 'path';
import '../providers/index.mjs'; // registers all 9 shipped labs; unwatched ones cost nothing beyond being registered
import { registeredProviders } from '../lib/llm-provider.mjs';
import { checkReleases } from '../lib/model-release-detector.mjs';
import { loadAdapter, watchedProviders, snapshotPath as adapterSnapshotPath, maxFanout as adapterMaxFanout } from '../lib/adapter.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--providers') out.providers = argv[++i];
    else if (argv[i] === '--snapshot') out.snapshot = argv[++i];
    else if (argv[i] === '--max-fanout') out.maxFanout = argv[++i];
    else if (argv[i] === '--adapter') out.adapter = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const adapterPath = args.adapter || process.env.PROJECT_ADAPTER_PATH || path.join(process.cwd(), 'project-adapter.yml');
// Only ever pulls in js-yaml (see adapter.mjs's loadAdapter doc) if this
// file actually exists — a project with no project-adapter.yml never pays
// for that dependency.
const adapter = await loadAdapter(adapterPath);
if (adapter) console.error(`Using ${adapterPath}`);

const providers = (
  args.providers ||
  process.env.PROVIDERS_WATCHED ||
  watchedProviders(adapter)?.join(',') ||
  registeredProviders().join(',')
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const snapshotPath = path.resolve(
  process.cwd(),
  args.snapshot || process.env.MODEL_SNAPSHOT_PATH || adapterSnapshotPath(adapter) || '.agent/model-snapshot.json'
);

const maxFanout = Number(args.maxFanout || process.env.MAX_FANOUT || adapterMaxFanout(adapter) || 8);

let snapshot = {};
if (fs.existsSync(snapshotPath)) {
  try {
    snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  } catch {
    console.error('Could not parse existing model snapshot, starting fresh');
  }
}

const result = await checkReleases({
  providers,
  snapshot,
  maxFanout,
  log: (msg) => console.error(msg),
});

fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
fs.writeFileSync(snapshotPath, JSON.stringify(result.newSnapshot, null, 2) + '\n');

console.log(
  JSON.stringify(
    {
      hasNewReleases: result.hasNewReleases,
      // Emitted separately from hasNewReleases and never overwritten by the
      // probe step — see model-release-detector.mjs. A workflow gating a
      // "quiet month" message must read THIS, or a month where every
      // candidate was unreachable reports as a month where nothing shipped.
      releaseDetected: result.releaseDetected,
      selectedModels: result.selectedModels,
      selectedModel: result.selectedModel,
      selectedProvider: result.selectedProvider,
      results: result.results,
    },
    null,
    2
  )
);

// Always exit 0 — the caller reads the output, not the exit code, so a
// detector that failed to reach one lab doesn't fail the whole workflow
// step; a failed check reports "unknown" for that lab within the JSON.
process.exit(0);
