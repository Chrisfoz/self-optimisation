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
 *   GEN_NUMBER       e.g. "007", as claimed by next-generation.mjs. Unset,
 *     a manual run takes the next free number. An existing record for the
 *     number is never overwritten (ALLOW_RECORD_OVERWRITE=true to force).
 *   RUN_ID / RUN_URL  Which run this is, recorded in attempts.json. Derived
 *     from GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT when unset (generation-id.mjs).
 *
 * Everything else is read from project-adapter.yml, with environment
 * overrides available for the same fields the workflow already sets
 * (IMPLEMENT_MODEL, REVIEW_MODEL, RANK_MODEL, SCOPE, MAX_ATTEMPTS) — same precedence
 * convention as check-model-releases.mjs: env var beats adapter, adapter
 * beats built-in default.
 */

import fs from 'fs';
import os from 'node:os';
import path from 'path';
import { execFileSync } from 'node:child_process';
import { nextGenerationNumber, runIdentity } from '../lib/generation-id.mjs';
import '../providers/index.mjs';
import { setOutput, oneLine } from '../lib/gh-output.mjs';
import { loadAdapter, constitutionAllowlist, guardConfig, memoryConfig, briefPaths, rolesConfig, contextConfig, budgetConfig, goalConfig, visualCaptureConfig, evaluationConfig, snapshotPath as adapterSnapshotPath } from '../lib/adapter.mjs';
import { getProvider, registeredProviders } from '../lib/llm-provider.mjs';
import { runProjectTests, scrubEnv } from '../lib/test-runner.mjs';
import { pickCrossFamilyRanker, describeSeats, promotionCandidate } from '../lib/seats.mjs';
import { loadRecords } from '../lib/report.mjs';
import { compileAllowlist } from '../lib/edit-format.mjs';
import { globToRegExp } from '../lib/glob.mjs';
import {
  buildSourceBundle, buildRepoManifest, buildTestIndex, buildArchitectureNotes,
  buildGenerationIndex, buildGenerationHistory, buildRuntimeEvidence, recommendScope, fenceUntrusted,
} from '../lib/context-pack.mjs';
import { loadLatestThemesReview, buildThemesBrief, buildOpenQuestionsBrief } from '../lib/themes.mjs';
import { buildMetricsBrief, loadLatestMetrics, loadVisualEvidence, loadEvaluatorPlugin, createVisualCapture } from '../lib/evaluators.mjs';
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

// The number comes from the workflow's numbering step (or rehearse.mjs),
// which has already claimed it. A manual run with none set takes the next
// free one rather than defaulting to "001", which is how a hand-run used to
// overwrite the first generation's record.
const genNumber = process.env.GEN_NUMBER || (() => {
  try {
    return nextGenerationNumber((...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(), {
      generationsDir: contextConfig(adapter).generationsDir || 'docs/generations',
    });
  } catch {
    return '001';
  }
})();
const genLabel = `Generation #${genNumber}`;
const run = runIdentity();

// A generation's record is written once. Finding one already there means
// two runs were handed the same number, and the second would silently
// replace the first's history — so stop, before anything is spent.
{
  const existing = path.join(repoRoot, contextConfig(adapter).generationsDir || 'docs/generations', `gen-${genNumber}`, 'attempts.json');
  if (fs.existsSync(existing) && process.env.ALLOW_RECORD_OVERWRITE !== 'true') {
    console.error(`Generation ${genNumber} already has a record at ${path.relative(repoRoot, existing)}. Refusing to overwrite it — take the next number (unset GEN_NUMBER), or set ALLOW_RECORD_OVERWRITE=true if you really mean to replace it.`);
    setOutput('has-changes', 'false');
    process.exit(1);
  }
}

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
// Throws on a goal with no statement — a half-specified goal silently
// ignored is worse than none (docs/curiosity/C1).
const goal = goalConfig(adapter);

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

const generationsDir = ctxConfig.generationsDir || 'docs/generations';

// The implement seat: the env override, else a rotating model that EARNED
// it (roles.promotion — a model whose own edits were approved and kept N
// times), else the pinned model. The review seat is never promoted.
const pinnedImplement = roles.implementModel || 'claude-opus-5';
const promoted = process.env.IMPLEMENT_MODEL || !roles.promotionThreshold
  ? null
  : promotionCandidate({
      records: loadRecords({ repoRoot, generationsDir }).records,
      threshold: roles.promotionThreshold,
      hasKey: (provider) => Boolean(process.env[getProvider(provider)?.envKey ?? '']),
    });
const seatPromotion = promoted && promoted.model !== pinnedImplement
  ? { model: promoted.model, provider: promoted.provider, basis: `${promoted.kept} self-implemented change(s) approved and kept; threshold ${roles.promotionThreshold}` }
  : null;
if (seatPromotion) console.error(`🏅 Implement seat promoted to ${seatPromotion.model} — ${seatPromotion.basis}`);
const implementModel = process.env.IMPLEMENT_MODEL || seatPromotion?.model || pinnedImplement;
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
const campaign = process.env.CAMPAIGN === 'true';
if (campaign) console.error('🧪 Campaign generation — models named by hand; recorded as campaign: true');

// --- scope ---
// Precedence, highest first: SCOPE for this one run (the Actions tab's
// "Run workflow" input, or the console's per-run override), then the
// adapter's standing ambition dial, then the earned default. The dial is
// the owner's decision about how much each run may attempt; the gates
// (review, guard, tests, the pull request) are identical at every setting,
// and rollback exists because an ambitious change that passes them can
// still be one the owner wants gone — see docs/Ambition-Control.md.
const scopeEnv = (process.env.SCOPE || '').toLowerCase();
const scope = scopeEnv === 'focused' || scopeEnv === 'ambitious'
  ? { scope: scopeEnv, reason: 'set explicitly for this run' }
  : ctxConfig.ambition === 'focused'
    ? { scope: 'focused', reason: 'context.ambition is "focused": every generation is a small, localised change' }
    : ctxConfig.ambition === 'ambitious'
      ? { scope: 'ambitious', reason: 'context.ambition is "ambitious": every generation may attempt structural work' }
      : recommendScope({ repoRoot, generationsDir, required: ctxConfig.scopeRequired ?? 2 });
console.error(`🎚️  Scope: ${scope.scope} — ${scope.reason}`);

// --- context ---
const latestThemes = loadLatestThemesReview({ repoRoot, themesDir: memory.themesDir || 'docs/themes' });
const context = {
  // Fenced (context-pack.mjs's fenceUntrusted()): the source and the
  // architecture notes are the two blocks a stranger with commit access to
  // the project could have written into. Everything else in this object is
  // derived by the harness or written by the owner.
  sources: fenceUntrusted('SOURCE', buildSourceBundle(editableFiles, { repoRoot })) ?? '',
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
  architectureNotes: fenceUntrusted('ARCHITECTURE NOTES', buildArchitectureNotes({ repoRoot, docPath: ctxConfig.architectureNotesPath, appendOnlyMarker: ctxConfig.architectureNotesMarker })),
  themes: buildThemesBrief(latestThemes),
  // The UNKNOWN field of the same review — docs/curiosity/C2, phase A. Null
  // for every review written before the field existed, which drops it.
  openQuestions: buildOpenQuestionsBrief(latestThemes),
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
  `runtime evidence ${context.runtime ? 'included' : 'none recorded'}, ` +
  `committed goal ${goal ? 'set' : 'none'}\n`
);

const projectDescription = adapter.project?.description || adapter.project?.id || 'this project';

// --- what this project's own probes can show a model ----------------------
// Two sockets, both of which have existed since the port and been fed
// nothing (docs/Tool-Use-Design.md §3). They are deliberately fed from
// different places: the suggesting model sees what the LAST generation
// rendered (the state this change starts from), the reviewer sees what THIS
// change actually produced. A project with no plugins configured gets
// exactly what it got before — no images, and review.mjs's own "not
// available" line.
const screenshots = loadVisualEvidence({ repoRoot, generationsDir });
if (screenshots.images.length) {
  console.error(`🖼️  ${screenshots.images.length} render(s) from ${screenshots.source} attached to the suggestion prompt`);
}

const visualCapture = visualCaptureConfig(adapter);
let captureVisual = null;
if (visualCapture) {
  try {
    const plugin = await loadEvaluatorPlugin({ repoRoot, ...visualCapture });
    captureVisual = createVisualCapture({
      plugin,
      repoRoot,
      // Outside the working tree on purpose: this runs mid-generation, and a
      // renderer writing into the tree would corrupt the very diff under
      // review.
      artifactsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'visual-capture-')),
      log: (msg) => console.error(msg),
    });
    console.error(`🖼️  Visual capture: ${plugin.name} will render the change for the reviewer`);
  } catch (err) {
    // Fails safe, like every other helper here: a capture plugin that cannot
    // even be loaded costs the reviewer its pictures, never the generation.
    console.error(`⚠️  evaluation.visual_capture (${visualCapture.module}) could not be loaded: ${err.message} — the review will run on the diff alone.`);
  }
}

// --- the project's own tests, inside the loop ------------------------------
// After each attempt's edits apply and before the review (orchestrator.mjs,
// Stage 2b). TEST_COMMANDS (a JSON array) overrides the adapter's list, so
// rehearse.mjs --test-command reaches here too; TEST_IN_LOOP=false turns it
// off for one run. The child never sees a credential: scrubEnv() removes
// every secret-shaped variable and every lab key the registry knows.
const evaluation = evaluationConfig(adapter);
const loopTestCommands = (() => {
  if (process.env.TEST_COMMANDS) {
    try {
      const parsed = JSON.parse(process.env.TEST_COMMANDS);
      if (Array.isArray(parsed)) return parsed.filter((c) => typeof c === 'string' && c.trim());
    } catch { console.error('⚠️  TEST_COMMANDS is not a JSON array; using evaluation.test_commands.'); }
  }
  return evaluation.testCommands;
})();
const testsInLoop = evaluation.testInLoop && process.env.TEST_IN_LOOP !== 'false' && loopTestCommands.length > 0;
const runTests = testsInLoop
  ? () => runProjectTests({
      repoRoot,
      commands: loopTestCommands,
      timeoutMs: evaluation.testTimeoutSeconds * 1000,
      env: scrubEnv(process.env, {
        keep: evaluation.testEnvPassthrough,
        extraSecretNames: registeredProviders().map((name) => getProvider(name)?.envKey).filter(Boolean),
      }),
    })
  : null;
console.error(testsInLoop
  ? `🧪 In-loop tests: ${loopTestCommands.join(' && ')} (credentials scrubbed; ${evaluation.testTimeoutSeconds}s per command)`
  : `🧪 In-loop tests: off (${loopTestCommands.length ? 'evaluation.test_in_loop is false' : 'no evaluation.test_commands configured'})`);

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
      // What this project's own probes rendered last generation — the
      // suggestion prompt's screenshots socket, fed for the first time (see
      // docs/Tool-Use-Design.md §3). `{images: [], source: null}` for a
      // project whose plugins render nothing, which is the value this line
      // was hardcoded to before.
      screenshots,
      // The review seat's own eyes, rendered from the tree the edits
      // produced rather than from last generation's record. Absent unless
      // the project configured evaluation.visual_capture, in which case
      // review.mjs keeps its existing "not available" line.
      ...(captureVisual ? { captureVisual } : {}),
      ledgerPath: memory.ledgerPath || undefined,
      consensus: { models: memory.consensus.models ?? 3, labs: memory.consensus.labs ?? 2 },
      resurfaceAfter: memory.resurfaceAfter ?? undefined,
      budget,
      campaign,
      seatPromotion,
      goal,
      run,
      runTests,
    },
    {
      log: (msg) => console.error(msg),
      // A cancelled workflow run (GitHub sends SIGINT, then SIGTERM) or a
      // Ctrl+C during a local rehearsal would otherwise leave half-reviewed
      // edits in the tree. runGeneration hands over its restore function and
      // takes the handlers back off when it finishes.
      onCleanup: (restore) => {
        const handler = (signal) => {
          try {
            restore();
            console.error(`\n⚠️  ${signal} received — the working tree was restored to how this run found it.`);
          } catch (e) {
            console.error(`\n⚠️  ${signal} received — and the working tree could NOT be restored: ${e.message}`);
          }
          process.exit(130);
        };
        process.once('SIGINT', handler);
        process.once('SIGTERM', handler);
        return () => { process.off('SIGINT', handler); process.off('SIGTERM', handler); };
      },
    }
  );
} catch (err) {
  console.error(`\n❌ ${err.message}`);
  if (err.treeRestored === false) console.error('   ⚠️  The working tree could NOT be restored — inspect it before committing anything.');
  else if (err.treeRestored) console.error('   The working tree was restored to how this run found it.');
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
