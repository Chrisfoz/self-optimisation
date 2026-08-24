import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import { compileAllowlist } from '../../harness/lib/edit-format.mjs';
import { runGeneration } from '../../harness/lib/orchestrator.mjs';
import { checkGuardedPaths } from '../../harness/lib/guard.mjs';
import { promote } from '../../harness/lib/promote.mjs';
import { verifyDeployment } from '../../harness/lib/verify-deployment.mjs';
import { buildGenerationDigestEmail } from '../../harness/lib/notify.mjs';

/**
 * The one test in this repository that drives the harness the way a real
 * installation's generated workflow does: a real git repo (bare origin +
 * working clone, same pattern as promote.test.mjs and guard.test.mjs's
 * real-repo tests), a real test command actually executed, and the exact
 * step order harness/templates/workflow.yml.tmpl encodes — create branch ->
 * improve -> commit+push -> guard -> tests -> promote (autonomous merge,
 * per the harness's proven, intended default — see ARCHITECTURE.md and
 * README's "How the three pieces fit together") -> verify -> notify.
 *
 * Everything above the network boundary is real code exercising real git
 * and a real child process. Only the three LLM calls (suggest, implement,
 * review) are faked — the same boundary every other test file in this repo
 * draws, and the only boundary a repository working on itself can't cross
 * from the inside (see ARCHITECTURE.md's "one real end-to-end run" note).
 *
 * This is deliberately a *second* test surface from tests/lib/orchestrator.test.mjs
 * (which proves runGeneration()'s state machine in isolation) and
 * tests/lib/promote.test.mjs / guard.test.mjs (which prove those two against
 * real git in isolation) — this file's only job is proving the pieces
 * chain, in the real order, without silently disagreeing with each other at
 * the boundaries (e.g. genNumber -> branch/tag name, guard's baseRef,
 * result.implementedBy -> the digest's r.implementModel).
 */

function realRemoteSetup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-full-loop-'));
  const originDir = path.join(root, 'origin.git');
  const workDir = path.join(root, 'work');

  execFileSync('git', ['init', '-q', '--bare', originDir]);

  fs.mkdirSync(workDir);
  const git = (...args) => execFileSync('git', args, { cwd: workDir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'setup@example.com');
  git('config', 'user.name', 'Setup');
  git('remote', 'add', 'origin', originDir);

  fs.writeFileSync(path.join(workDir, 'index.html'), 'original content');
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');
  git('push', '-q', 'origin', 'main');

  return { root, workDir, git };
}

const VALID_SUGGESTION = `PILLAR: Feedback Loops
PROBLEM: no pause button exists
CHANGE: add a pause button to index.html
WHY THIS ONE: it is the highest-value gap
RISK: none, purely additive
ALSO UPDATE: nothing
VERIFICATION: the button should be visible
BRIEF FEEDBACK: the brief was clear
ESCALATION: none
ESCALATION TARGET: none
ESCALATION CASE: none
ESCALATION SUPPORT: none
ESCALATION DISSENT: none

<<<EDIT>>>
FILE: index.html
<<<SEARCH>>>
original content
<<<REPLACE>>>
original content with a pause button
<<<END>>>`;

test('the built loop, end to end: suggest -> implement -> review -> guard -> test -> autonomous merge -> verify -> notify, against a real git remote', async (t) => {
  const { root, workDir, git } = realRemoteSetup();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // --- "Create the agent branch" -------------------------------------------
  const branch = 'agent/gen-001';
  git('checkout', '-q', '-b', branch);

  // --- "Run the improvement loop" ------------------------------------------
  // Only the three model calls are faked; everything else below is real.
  const call = async ({ model }) => {
    if (model === 'suggest-model') {
      return { text: VALID_SUGGESTION, truncated: false, provider: 'anthropic', model, sentImages: 0 };
    }
    if (model === 'review-model') {
      return { text: 'VERDICT: APPROVED\n\nREASON: clean, minimal, matches the proposal.', model };
    }
    throw new Error('unexpected call: ' + model);
  };

  const result = await runGeneration({
    repoRoot: workDir,
    genNumber: '001',
    agentBrief: 'THE PROJECT BRIEF',
    reviewerBrief: 'THE REVIEWER BRIEF. Respond with VERDICT: APPROVED or VERDICT: REJECTED.',
    editableFiles: ['index.html'],
    allowlist: compileAllowlist({ allowedPaths: ['index.html'] }),
    suggestModels: [{ id: 'suggest-model', provider: 'anthropic' }],
    implementModel: 'implement-model',
    reviewModel: 'review-model',
    rankModel: 'rank-model',
    maxAttempts: 3,
    scope: { scope: 'focused', reason: 'default' },
    projectDescription: 'a test project',
    context: { manifest: 'MANIFEST', testIndex: null, sources: 'SOURCE BUNDLE' },
  }, { call });

  assert.equal(result.outcome, 'approved');
  assert.equal(result.hasChanges, true);
  assert.equal(result.selfImplemented, true, 'the suggester supplied direct edits; no fallback implementer call was needed');
  assert.match(fs.readFileSync(path.join(workDir, 'index.html'), 'utf8'), /pause button/);

  // --- "Commit and push the agent branch, if it has changes" --------------
  git('add', '-A');
  git('commit', '-q', '-m', `Generation 001: ${result.summary}`);
  git('push', '-q', 'origin', branch);
  git('fetch', '-q', 'origin', 'main'); // workflow.yml.tmpl's checkout@v4 has fetch-depth 0; a real clone would already have this

  // --- "Guard — enforce frozen/append-only paths on the agent branch" -----
  const guardResult = checkGuardedPaths({
    baseRef: 'origin/main',
    frozenPaths: [/^\.github\//],
    git,
  });
  assert.equal(guardResult.pass, true, `guard should pass: ${JSON.stringify(guardResult.violations)}`);

  // --- "Run this project's own tests, against the agent branch" -----------
  // A real child process actually runs, exit code actually checked — the
  // same gate mechanism as `evaluation.test_commands`, not asserted by fiat.
  let testsOutcome;
  try {
    execFileSync(process.execPath, ['-e', 'process.exit(0)'], { cwd: workDir });
    testsOutcome = 'success';
  } catch {
    testsOutcome = 'failure';
  }
  assert.equal(testsOutcome, 'success');

  // --- "Merge and tag, if every gate passed" (autonomous merge — the point) ---
  git('checkout', '-q', 'main');
  const promoteResult = promote({ repoRoot: workDir, branch, tag: 'gen-001' });
  assert.deepEqual(promoteResult, { merged: true, branch, tag: 'gen-001', baseBranch: 'main' });
  assert.equal(fs.readFileSync(path.join(workDir, 'index.html'), 'utf8'), 'original content with a pause button');

  // The remote actually received it — check via a fresh clone, not the
  // local working copy, the same discipline promote.test.mjs uses.
  const freshClone = path.join(root, 'fresh-clone');
  execFileSync('git', ['clone', '-q', '--no-checkout', path.join(root, 'origin.git'), freshClone]);
  const freshGit = (...args) => execFileSync('git', args, { cwd: freshClone, encoding: 'utf8' }).trim();
  freshGit('checkout', 'main');
  assert.equal(fs.readFileSync(path.join(freshClone, 'index.html'), 'utf8'), 'original content with a pause button');
  assert.doesNotThrow(() => freshGit('rev-parse', 'gen-001'));

  // --- "Verify the deployment" ---------------------------------------------
  const verifyResult = await verifyDeployment({ strategy: 'none' });
  assert.equal(verifyResult.ok, true);

  // --- "Build this run's gate results" + notify -----------------------------
  // Mirrors workflow.yml.tmpl's own `add()` step exactly: only gates that
  // actually ran are included.
  const gates = [
    { name: 'guard', result: guardResult.pass ? 'success' : 'failure' },
    { name: 'tests', result: testsOutcome },
    { name: 'promote', result: promoteResult.merged ? 'success' : 'failure' },
    { name: 'verify', result: verifyResult.ok ? 'success' : 'failure' },
  ];
  const merged = gates.find((g) => g.name === 'promote').result === 'success';
  assert.equal(merged, true);

  const digest = await buildGenerationDigestEmail({
    genLabel: 'Generation #001',
    scope: result.scope.scope,
    merged,
    suggestModel: result.suggestModel,
    suggestProvider: result.suggestProvider,
    implementModel: result.implementedBy,
    selfImplemented: result.selfImplemented,
    summary: result.summary,
    gates,
    briefFeedback: result.briefFeedback,
    escalationsOpened: result.escalations?.opened?.length ?? 0,
    escalationsFlagged: result.escalations?.flagged?.length ?? 0,
  }, {
    // Force the reliable terse fallback deterministically, rather than
    // attempting a real network call in a test — proves the gate-derived
    // facts reach the digest correctly, which is the property that matters
    // here (see notify.mjs's own note on the incident this guards against:
    // a digest-writing model once invented "the reviewer said no" despite
    // the true, computed verdict being APPROVED right there in its prompt).
    call: async () => { throw new Error('no digest model available in a test'); },
  });

  assert.match(digest.subject, /MERGED/);
  assert.match(digest.body, /✅ MERGED/);
  assert.doesNotMatch(digest.body, /⚠️ NOT MERGED/);
  assert.equal(result.suggestModel, 'suggest-model');
  assert.equal(result.suggestProvider, 'anthropic');
  assert.match(digest.body, /Suggested by:\s+suggest-model \(anthropic\)/);
  assert.match(digest.body, /✅ guard/);
  assert.match(digest.body, /✅ tests/);
  assert.match(digest.body, /✅ promote/);
  assert.match(digest.body, /✅ verify/);
});

test('the built loop, end to end: every attempt rejected -> abandoned, tree restored, nothing pushed, digest correctly reports NOT MERGED', async (t) => {
  const { root, workDir, git } = realRemoteSetup();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const branch = 'agent/gen-002';
  git('checkout', '-q', '-b', branch);

  const call = async ({ model }) => {
    if (model === 'suggest-model') {
      return { text: VALID_SUGGESTION, truncated: false, provider: 'anthropic', model, sentImages: 0 };
    }
    if (model === 'implement-model') {
      // Refine calls the fallback implementer for every retry after the
      // first rejection, even though attempt 1 was self-implemented — a
      // fresh edit incorporating rejection feedback needs a real call, not
      // a replay of the same suggestion.
      return {
        text: 'SUMMARY: Add a pause button\nRATIONALE: retry after rejection, long enough to pass the rationale bar.\n\n<<<EDIT>>>\nFILE: index.html\n<<<SEARCH>>>\noriginal content\n<<<REPLACE>>>\noriginal content with a pause button\n<<<END>>>',
        truncated: false,
        model,
      };
    }
    if (model === 'review-model') {
      return { text: 'VERDICT: REJECTED\n\nREASON: never good enough.', model };
    }
    throw new Error('unexpected call: ' + model);
  };

  const result = await runGeneration({
    repoRoot: workDir,
    genNumber: '002',
    agentBrief: 'THE PROJECT BRIEF',
    reviewerBrief: 'THE REVIEWER BRIEF. Respond with VERDICT: APPROVED or VERDICT: REJECTED.',
    editableFiles: ['index.html'],
    allowlist: compileAllowlist({ allowedPaths: ['index.html'] }),
    suggestModels: [{ id: 'suggest-model', provider: 'anthropic' }],
    implementModel: 'implement-model',
    reviewModel: 'review-model',
    rankModel: 'rank-model',
    maxAttempts: 2,
    scope: { scope: 'focused', reason: 'default' },
    projectDescription: 'a test project',
    context: { manifest: 'MANIFEST', testIndex: null, sources: 'SOURCE BUNDLE' },
  }, { call });

  assert.equal(result.outcome, 'abandoned');
  assert.equal(result.hasChanges, false);
  assert.equal(fs.readFileSync(path.join(workDir, 'index.html'), 'utf8'), 'original content');

  // Nothing to commit or push — the generated workflow's own `if:` on that
  // step (steps.improve.outputs.has-changes == 'true') would have skipped
  // it too, so guard/tests/promote/verify never run this generation.
  const gates = []; // matches workflow.yml.tmpl's add(): only gates that ran are included
  const merged = false;

  const digest = await buildGenerationDigestEmail({
    genLabel: 'Generation #002',
    scope: result.scope.scope,
    merged,
    suggestModel: result.suggestModel,
    suggestProvider: result.suggestProvider,
    implementModel: null,
    selfImplemented: false,
    summary: result.summary,
    gates,
    briefFeedback: result.briefFeedback,
    escalationsOpened: 0,
    escalationsFlagged: 0,
  }, {
    call: async () => { throw new Error('no digest model available in a test'); },
  });

  assert.match(digest.subject, /NOT MERGED/);
  assert.match(digest.body, /NOT MERGED/);
  assert.doesNotMatch(digest.body, /✅ MERGED/);
});
