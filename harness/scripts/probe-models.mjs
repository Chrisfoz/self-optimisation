#!/usr/bin/env node

/**
 * CLI entry point for harness/lib/probe-models.mjs. Reads a release-check.json
 * (the shape harness/scripts/check-model-releases.mjs produces), probes
 * every candidate in `selectedModels` with a trivial request, and rewrites
 * the file in place so only reachable models survive.
 *
 * Run after check-model-releases.mjs and before anything that would spend
 * real budget on a candidate model — see the reference implementation's
 * .github/workflows/self-improvement.yml for where this sits in a real
 * pipeline (the `check-releases` job, before its fields are read into
 * GITHUB_OUTPUT).
 *
 * Logs go to stderr; the file is the only output that matters to callers.
 *
 * Context-window fit checking (`checkContextFit()` in probe-models.mjs) is
 * OPTIONAL here and deliberately not wired to a context-size estimator by
 * default: the reference implementation's estimateContextSize() lives in
 * context-pack.mjs, which hasn't been ported into this harness yet (see
 * Portable-Harness-Design.md §10 — it's real work, not a rename, because
 * carrotgame's version is tightly coupled to project-specific context
 * blocks). Pass `--estimated-tokens <n>` or set CONTEXT_ESTIMATE_TOKENS once
 * a project has its own estimator; without it, every candidate is treated
 * as "no evidence it won't fit" — the same conservative default
 * checkContextFit() already applies to any provider that reports no context
 * window at all.
 */

import fs from 'fs';
import '../providers/index.mjs';
import { callModel } from '../lib/llm-provider.mjs';
import { probeCandidates, PROBE_SYSTEM, PROBE_USER } from '../lib/probe-models.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--estimated-tokens') out.estimatedTokens = argv[++i];
    else if (!argv[i].startsWith('--') && !out.releasePath) out.releasePath = argv[i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (!args.releasePath) {
  console.error('Usage: node harness/scripts/probe-models.mjs <release-check.json> [--estimated-tokens <n>]');
  process.exit(1);
}

const release = JSON.parse(fs.readFileSync(args.releasePath, 'utf8'));
const candidates = release.selectedModels || [];

if (!candidates.length) {
  console.error('No candidates to probe.');
  process.exit(0);
}

const prober = ({ model, provider }) =>
  callModel({
    model,
    provider,
    system: PROBE_SYSTEM,
    user: PROBE_USER,
    // Generous relative to a one-word reply: reasoning models spend some of
    // this budget on hidden thinking tokens before the visible answer, and
    // a probe that truncates before any text reads identically to
    // "unreachable" unless given enough room not to. A real model in one
    // lab's family spent 350-425 tokens on hidden reasoning alone before a
    // one-word reply, confirmed live, and was wrongly dropped as
    // unreachable at a smaller budget.
    maxTokens: 600,
    // Short relative to callModel's 10-minute default — this only needs to
    // prove the endpoint answers at all, not to wait out a slow generation.
    timeoutMs: 60000,
  });

const estimatedTokens = Number(args.estimatedTokens ?? process.env.CONTEXT_ESTIMATE_TOKENS ?? NaN);

const { survivors, dropped } = await probeCandidates(
  candidates,
  prober,
  (msg) => console.error(msg),
  { estimatedTokens }
);

release.selectedModels = survivors;
release.selectedModel = survivors[0]?.id ?? '';
release.selectedProvider = survivors[0]?.provider ?? '';
release.hasNewReleases = survivors.length > 0;
release.probeDropped = dropped;

fs.writeFileSync(args.releasePath, JSON.stringify(release, null, 2));

if (dropped.length) {
  console.error(`\n⚠️  Dropped ${dropped.length} unreachable candidate(s): ${dropped.map((d) => d.id).join(', ')}`);
}
if (!survivors.length) {
  console.error('\nNo candidate model is reachable — the improvement cycle will be skipped.');
}
