#!/usr/bin/env node

/**
 * CLI entry point for harness/lib/orchestrator.mjs's runGeneration(). This
 * is the file a workflow's "improve" job actually invokes — it owns
 * everything runGeneration() itself stays free of: reading the adapter,
 * reading the two brief files, assembling context via context-pack.mjs's
 * builders, resolving which models to ask, and translating the result
 * into GITHUB_OUTPUT / an exit code.
 *
 * Run from a target project's root, same convention as every other harness
 * CLI (check-model-releases.mjs, check-guarded-paths.mjs).
 *
 * Required environment:
 *   SUGGEST_MODELS   JSON array `[{"id":"...","provider":"..."}]`, or
 *   SUGGEST_MODEL / SUGGEST_PROVIDER   a single fallback pair — matches
 *     check-model-releases.mjs's own output shape, so this script's input
 *     is that script's output, unchanged.
 *   GEN_NUMBER       e.g. "001". Defaults to "001" for a manual/local run.
 *
 * Everything else is read from project-adapter.yml, with environment
 * overrides available for the same fields the workflow already sets
 * (IMPLEMENT_MODEL, REVIEW_MODEL, RANK_MODEL, SCOPE, MAX_ATTEMPTS) — same precedence
 * convention as check-model-releases.mjs: env var beats adapter, adapter
 * beats built-in default.
 */

import fs from 'fs';
import path from 'path';
import '../providers/index.mjs';
import { setOutput, oneLine } from '../lib/gh-output.mjs';
import { loadAdapter, constitutionAllowlist, guardConfig, memoryConfig, briefPaths, rolesConfig, contextConfig, budgetConfig, snapshotPath as adapterSnapshotPath } from '../lib/adapter.mjs';
import { getProvider } from '../lib/llm-provider.mjs';
import { pickCrossFamilyRanker, describeSeats } from '../lib/seats.mjs';
import { compileAllowlist } from '../lib/edit-format.mjs';
import { globToRegExp } from '../lib/glob.mjs';
import {
  buildSourceBundle, buildRepoManifest, buildTestIndex, buildArchitectureNotes,
  buildGenerationIndex, buildGenerationHistory, buildRuntimeEvidence, recommendScope,
} from '../lib/context-pack.mjs';
import { loadLatestThemesReview, buildThemesBrief } from '../lib/themes.mjs';
import { buildMetricsBrief, loadLatestMetrics } from '../lib/evaluators.mjs';
import { buildEscalationBrief, loadLedger } from '../lib/escalations.mjs';
import { runGeneration } from '../lib/orchestrator.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--adapter') out.adapter = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = process.cwd();

const adapterPath = args.adapter || process.env.PROJECT_ADAPTER_PATH || path.join(repoRoot, 'project-adapter.yml');
const adapter = await loadAdapter(adapterPath);
if (!adapter) {
  console.error(`No project-adapter.yml found at ${adapterPath}. This script needs one — see harness/project-adapter.example.yml.`);
  process.exit(1);
}
console.error(`Using ${adapterPath}`);

const genNumber = process.env.GEN_NUMBER || '001';
const genLabel = `Generation #${genNumber}`;

// --- suggestModels: same shape check-model-releases.mjs emits ---
const suggestModels = (() => {
  const raw = process.env.SUGGEST_MODELS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        return parsed.filter((m) => m && typeof m.id === 'string' && m.id).map((m) => ({ id: m.id, provider: m.provider || null }));
      }
    } catch {
      console.error('⚠️  SUGGEST_MODELS is not valid JSON; falling back to SUGGEST_MODEL.');
    }
  }
  return process.env.SUGGEST_MODEL ? [{ id: process.env.SUGGEST_MODEL, provider: process.env.SUGGEST_PROVIDER || null }] : [];
})();

if (suggestModels.length === 0) {
  console.error('Neither SUGGEST_MODELS nor SUGGEST_MODEL is set. Run check-model-releases.mjs first.');
  process.exit(1);
}

// --- config, adapter first, env overrides where the workflow already sets them ---
const { allowedPaths: editableFiles, createOnlyPaths } = constitutionAllowlist(adapter);
const allowlist = compileAllowlist({ allowedPaths: editableFiles, createOnlyPaths });
const guard = guardConfig(adapter);
const memory = memoryConfig(adapter);
const briefs = briefPaths(adapter);
const roles = rolesConfig(adapter);
const ctxConfig = contextConfig(adapter);
const budget = budgetConfig(adapter);

if (editableFiles.length === 0) {
  console.error('project-adapter.yml has no constitution.allowed_paths — nothing for the agent to edit.');
  process.exit(1);
}

const readRequired = (relative, what) => {
  if (!relative) {
    console.error(`No ${what} configured (roles.${what === 'agent brief' ? 'agent_brief_path' : 'reviewer_brief_path'} in project-adapter.yml).`);
    process.exit(1);
  }
  const absolute = path.join(repoRoot, relative);
  if (!fs.existsSync(absolute)) {
    console.error(`${what} configured at ${relative}, but that file does not exist.`);
    process.exit(1);
  }
  return fs.readFileSync(absolute, 'utf8');
};

const agentBrief = readRequired(briefs.agentBriefPath, 'agent brief');
const reviewerBrief = readRequired(briefs.reviewerBriefPath, 'reviewer brief');

const implementModel = process.env.IMPLEMENT_MODEL || roles.implementModel || 'claude-opus-5';
const reviewModel = process.env.REVIEW_MODEL || roles.reviewModel || 'claude-opus-5';

// The rank seat: the adapter's choice if it made one, otherwise a model
// from a DIFFERENT family than the implementer, drawn from the detector's
// snapshot and limited to labs whose key is present — and only then the
// implementer itself. A judge prefers its own family's prose
// (learning/07-whats-actually-new.md §5); ranking fails safe, so a
// cross-family default costs at worst one ranking. The review seat is not
// auto-assigned the same way — it fails closed and must be a model someone
// chose — but a shared family there is warned about below every run.
const rankModel = process.env.RANK_MODEL || roles.rankModel || (() => {
  const snapshotFile = path.resolve(repoRoot, adapterSnapshotPath(adapter) || '.agent/model-snapshot.json');
  let snapshot = {};
  try { snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8')); } catch { /* no snapshot yet: no cross-family default */ }
  const pick = pickCrossFamilyRanker({
    implementModel,
    snapshot,
    hasKey: (provider) => Boolean(process.env[getProvider(provider)?.envKey ?? '']),
  });
  if (pick) console.error(`⚖️  Rank seat defaulted to ${pick.id} (${pick.provider}) — a different family than the implementer, from the model snapshot.`);
  return pick?.id ?? implementModel;
})();

const seats = describeSeats({ implementModel, reviewModel, rankModel });
console.error(`🪑 Seats: ${seats.line}`);
for (const warning of seats.warnings) console.error(`   ⚠️  ${warning}`);
const maxAttempts = Number(process.env.MAX_ATTEMPTS || roles.maxAttempts || 3);
const suggestMaxTokens = Number(process.env.SUGGEST_MAX_TOKENS || roles.suggestMaxTokens || 32000);

const generationsDir = ctxConfig.generationsDir || 'docs/generations';

// --- scope ---
const scopeEnv = (process.env.SCOPE || '').toLowerCase();
const scope = scopeEnv === 'focused' || scopeEnv === 'ambitious'
  ? { scope: scopeEnv, reason: 'set explicitly for this run' }
  : recommendScope({ repoRoot, generationsDir, required: ctxConfig.scopeRequired ?? 2 });

// --- context ---
const context = {
  sources: buildSourceBundle(editableFiles, { repoRoot }),
  manifest: buildRepoManifest({
    repoRoot,
    purposes: ctxConfig.purposes,
    allowlist,
    appendOnlyPaths: guard.appendOnlyPaths.map(globToRegExp),
    createOnlyDescription: createOnlyPaths.length ? createOnlyPaths.join(', ') : undefined,
  }),
  testIndex: buildTestIndex({ repoRoot, testFiles: ctxConfig.testFiles }),
  generationIndex: buildGenerationIndex({ repoRoot, generationsDir }),
  history: buildGenerationHistory({ repoRoot, generationsDir, limit: 3 }),
  architectureNotes: buildArchitectureNotes({ repoRoot, docPath: ctxConfig.architectureNotesPath, appendOnlyMarker: ctxConfig.architectureNotesMarker }),
  themes: buildThemesBrief(loadLatestThemesReview({ repoRoot, themesDir: memory.themesDir || 'docs/themes' })),
  escalations: buildEscalationBrief(
    loadLedger({ repoRoot, ledgerPath: memory.ledgerPath || undefined }),
    { threshold: { models: memory.consensus.models ?? 3, labs: memory.consensus.labs ?? 2 } }
  ),
  platform: ctxConfig.platformNotes,
  feedback: null, // player-feedback equivalent: not ported (project-specific, see Portable-Harness-Design.md)
  // The general form of carrotgame's readiness scorecard: whatever this
  // project's evaluator plugins measured after the LAST generation, read
  // back into this one. Null for a project with no evaluators configured,
  // which drops the section from the prompt entirely.
  qualityMetrics: buildMetricsBrief(loadLatestMetrics({ repoRoot, generationsDir })),
  // What the last few runs actually SAW — not a verdict and not a score.
  // Null for a project that has never written any, which is today's prompt.
  runtime: buildRuntimeEvidence({ repoRoot, evidenceDir: ctxConfig.runtimeEvidenceDir || undefined }),
};

console.error(
  `📚 Context: ${context.sources.length} chars of editable source, ` +
  `test index ${context.testIndex ? 'included' : 'unavailable'}, ` +
  `generation index ${context.generationIndex ? 'included' : 'unavailable'}, ` +
  `architecture notes ${context.architectureNotes ? 'included' : 'unavailable'}, ` +
  `themes review ${context.themes ? 'included' : 'none yet'}, ` +
  `measured quality dimensions ${context.qualityMetrics ? 'included' : 'none configured'}, ` +
  `runtime evidence ${context.runtime ? 'included' : 'none recorded'}\n`
);

const projectDescription = adapter.project?.description || adapter.project?.id || 'this project';

// --- run ---
let result;
try {
  result = await runGeneration(
    {
      repoRoot,
      genNumber,
      generationsDir,
      agentBrief,
      reviewerBrief,
      editableFiles,
      allowlist,
      createOnlyDescription: createOnlyPaths.length ? createOnlyPaths.join(', ') : undefined,
      suggestModels,
      implementModel,
      reviewModel,
      rankModel,
      maxAttempts,
      suggestMaxTokens,
      scope,
      projectDescription,
      testDescription: null, // a project with test_commands configured could join them into prose here
      context,
      screenshots: { images: [], source: null }, // visual capture: project-specific plugin, not wired by default
      ledgerPath: memory.ledgerPath || undefined,
      consensus: { models: memory.consensus.models ?? 3, labs: memory.consensus.labs ?? 2 },
      resurfaceAfter: memory.resurfaceAfter ?? undefined,
      budget,
    },
    { log: (msg) => console.error(msg) }
  );
} catch (err) {
  console.error(`\n❌ ${err.message}`);
  setOutput('has-changes', 'false');
  if (err.attemptRecordPath) setOutput('attempt-record', err.attemptRecordPath);
  process.exit(1);
}

setOutput('has-changes', String(result.hasChanges));
setOutput('scope', result.scope?.scope ?? '');
// Tokens, input plus output, across every call this generation made.
setOutput('spend-tokens', String(result.spend?.totalTokens ?? 0));
if (result.attemptRecordPath) setOutput('attempt-record', result.attemptRecordPath);

// Escalations, if any were recorded this run — feeds send-digest.mjs's
// ESC_OPENED/ESC_FLAGGED and send-escalation-notice.mjs's FLAGGED directly.
// Absent on the no-proposal outcome: with no proposals, there is nothing to
// fold into the ledger (see orchestrator.mjs's recordEscalations() call site).
setOutput('escalations-opened', String(result.escalations?.opened?.length ?? 0));
setOutput('escalations-flagged', String(result.escalations?.flagged?.length ?? 0));
setOutput('escalations-flagged-json', JSON.stringify(result.escalations?.flagged ?? []));

// The outcome label: did the thing three models agreed on, and a human
// accepted, actually work? Empty on every run that carried no work order.
setOutput('work-order-completed', result.workOrder ? `${result.workOrder.id}:${result.workOrder.outcome}` : '');

if (result.outcome === 'approved') {
  console.error(`\n✅ Approved on attempt ${result.attempts}`);
  console.error(`   implemented by ${result.implementedBy}`);
  setOutput('summary', result.summary);
  setOutput('suggest-model', result.suggestModel);
  setOutput('suggest-provider', result.suggestProvider);
  setOutput('implement-model', result.implementedBy);
  setOutput('self-implemented', String(result.selfImplemented));
  setOutput('files-changed', result.filesChanged.join(','));
  setOutput('proposal-path', result.proposalPath);
  setOutput('review-verdict', result.reviewVerdict);
  setOutput('attempts', String(result.attempts));
  setOutput('brief-feedback', oneLine(result.briefFeedback || '(none given)', 400));
  process.exit(0);
}

if (result.outcome === 'no-proposal') {
  console.error(`\n⚠️  No model produced a usable proposal.`);
  setOutput('summary', result.summary);
  setOutput('review-verdict', 'no-proposal');
  process.exit(1);
}

if (result.outcome === 'over-budget') {
  console.error(`\n💸 Refused before the fan-out: ${result.summary}`);
  setOutput('summary', result.summary);
  setOutput('review-verdict', 'over-budget');
  process.exit(1);
}

// abandoned
console.error(`\n❌ No change survived ${result.attempts} attempt(s). The working tree was restored.`);
setOutput('suggest-model', result.suggestModel);
setOutput('suggest-provider', result.suggestProvider);
setOutput('review-verdict', 'rejected');
setOutput('attempts', String(result.attempts));
setOutput('brief-feedback', oneLine(result.briefFeedback || '(none given)', 400));
process.exit(1);
