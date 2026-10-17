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
 * Context-window fit checking (`checkContextFit()` in probe-models.mjs): the
 * estimate is `--estimated-tokens <n>` or CONTEXT_ESTIMATE_TOKENS when given,
 * and otherwise measured from the project's own adapter — the same context
 * run-generation.mjs will send (harness/lib/assemble-context.mjs), plus the
 * agent brief and any renders. A candidate is only dropped when its lab
 * reports a context window and the estimate does not fit it; an unknown
 * window is "no evidence it won't fit", never a reason to drop.
 */

import fs from 'fs';
import '../providers/index.mjs';
import { callModel } from '../lib/llm-provider.mjs';
import { probeCandidates, probePinnedSeats, pinnedSeats, PROBE_SYSTEM, PROBE_USER } from '../lib/probe-models.mjs';
import path from 'path';
import { loadAdapter, rolesConfig, notifyConfig, briefPaths } from '../lib/adapter.mjs';
import { assembleContext, measureContext } from '../lib/assemble-context.mjs';
import { loadVisualEvidence } from '../lib/evaluators.mjs';

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

const adapter = await loadAdapter(process.env.PROJECT_ADAPTER_PATH || undefined).catch(() => null);

// Measured from the adapter when nobody supplied a number, so the fit check
// actually runs in the generated workflow instead of waiting for a variable
// nothing set. A failure to measure costs the check, never the probe.
let estimatedTokens = Number(args.estimatedTokens ?? process.env.CONTEXT_ESTIMATE_TOKENS ?? NaN);
if (!Number.isFinite(estimatedTokens) && adapter) {
  try {
    const repoRoot = process.cwd();
    const assembled = assembleContext({ repoRoot, adapter });
    const briefPath = briefPaths(adapter).agentBriefPath;
    const agentBrief = briefPath && fs.existsSync(path.join(repoRoot, briefPath)) ? fs.readFileSync(path.join(repoRoot, briefPath), 'utf8') : '';
    const images = loadVisualEvidence({ repoRoot, generationsDir: assembled.generationsDir }).images.length;
    estimatedTokens = measureContext({ context: assembled.context, agentBrief, imageCount: images }).estimatedTokens;
    console.error(`📏 Suggestion prompt estimated at ~${estimatedTokens.toLocaleString()} tokens (from project-adapter.yml)`);
  } catch (err) {
    console.error(`⚠️  Could not estimate the prompt size (${err.message}); no candidate is dropped for its context window.`);
  }
}

const { survivors, dropped } = await probeCandidates(
  candidates,
  prober,
  (msg) => console.error(msg),
  { estimatedTokens }
);

// The pinned seats, probed only when there is a suggester to spend on. A
// generation calls them whichever candidate wins, so one that cannot answer
// (in practice: an account with no credit) stops the cycle here, before the
// fan-out's full-context calls rather than after them. Skipped when there is
// no adapter to read, as in a bare test of this script.
let pinnedBlocked = [];
if (survivors.length) {
  if (adapter) {
    const seats = pinnedSeats({ roles: rolesConfig(adapter), notify: adapter.notify ? notifyConfig(adapter) : null, env: process.env });
    pinnedBlocked = await probePinnedSeats(seats, prober, (msg) => console.error(msg));
  }
}
if (pinnedBlocked.length) {
  for (const b of pinnedBlocked) {
    dropped.push({ id: `${b.model} (${b.seats.join(', ')} seat)`, provider: b.provider, reason: b.reason });
  }
  survivors.length = 0;
}
release.pinnedUnreachable = pinnedBlocked;

release.selectedModels = survivors;
release.selectedModel = survivors[0]?.id ?? '';
release.selectedProvider = survivors[0]?.provider ?? '';
// Only hasNewReleases moves. `releaseDetected` was set by the detector
// before this step ran and is deliberately left alone: it records that a lab
// shipped something, which stays true even when nothing here could reach it.
// Collapsing the two is how "a lab moved its endpoint" ends up looking
// exactly like "a quiet month" to everything downstream.
release.hasNewReleases = survivors.length > 0;
release.probeDropped = dropped;

fs.writeFileSync(args.releasePath, JSON.stringify(release, null, 2));

if (dropped.length) {
  console.error(`\n⚠️  Dropped ${dropped.length} unreachable candidate(s): ${dropped.map((d) => d.id).join(', ')}`);
}
if (pinnedBlocked.length) {
  console.error(`\n❌ ${pinnedBlocked.length} pinned seat(s) unreachable: ${pinnedBlocked.map((b) => `${b.model} (${b.seats.join(', ')})`).join('; ')}. The improvement cycle will be skipped, before anything is spent on a suggester.`);
} else if (!survivors.length) {
  console.error('\nNo candidate model is reachable — the improvement cycle will be skipped.');
}
