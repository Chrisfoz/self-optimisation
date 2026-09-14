import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { startMockLabs, suggestion, editBlock, MARKER, APPROVAL, REJECTION } from '../helpers/mock-labs.mjs';
import { createScratchProject } from '../helpers/scratch-project.mjs';

/**
 * The real chain, across the real HTTP boundary, against every lab this
 * harness ships — with only the labs' answers scripted.
 *
 * tests/e2e/full-loop.test.mjs drives runGeneration() with the three model
 * calls replaced one function above the transport. This file drives the
 * SCRIPTS — check-model-releases, probe-models, rehearse (which is
 * campaign-models → probe → run-evaluators → run-generation →
 * persist-records → check-guarded-paths → the project's tests),
 * record-runtime-evidence, generate-themes-review and report — as child
 * processes, exactly as a person or the generated workflow runs them, and
 * the labs are tests/helpers/mock-labs.mjs on a loopback port: nine
 * dialects, keys checked, catalogue listings, usage reported. So what this
 * proves that the fake-call tests cannot: each provider file's request
 * shape and auth header reach a server and come back through that
 * provider's parser; the detector's listing parsers work on each dialect;
 * the scripts agree with each other about env vars, files, exit codes and
 * git; and the curiosity mechanisms (escalation consensus, resurfacing,
 * work orders, runtime evidence, the themes review and its UNKNOWN)
 * actually change the next prompt.
 *
 * The first real campaigns (docs/campaigns/2026-09-11-first-real-campaigns.md)
 * found seven defects the fake-call suite had missed. This is the cheapest
 * way to find the next ones before a lab is paid to.
 */

const ALL_LABS = ['anthropic', 'openai', 'google', 'moonshot', 'deepseek', 'qwen', 'xai', 'meta', 'zai'];

function harness(dir, env) {
  // Children are spawned asynchronously on purpose: the mock server runs in
  // THIS process's event loop, and a spawnSync would block the very server
  // the child is talking to.
  return (args, extra = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: dir, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function childEnv(labs) {
  const env = { ...process.env, ...labs.env() };
  // A CI runner's GitHub identity must not leak into a rehearsal that is
  // meant to be local, and must not make generation-id.mjs think it is in
  // Actions.
  for (const k of Object.keys(env)) if (/^(GITHUB_|GH_|CI$|RUNNER_)/.test(k)) delete env[k];
  // The scratch project's own suite is `node --test`, run by the harness as
  // a child of this test. Node marks a test runner's children with
  // NODE_TEST_CONTEXT, and a nested `node --test` that sees it refuses to
  // run its files ("run() is being called recursively") — which would make
  // every in-loop test run pass vacuously. Real installs never have it set.
  for (const k of Object.keys(env)) if (/^NODE_TEST_/.test(k)) delete env[k];
  return env;
}

test('detector: nine labs baseline, then a release at each, held to max_fanout, then every candidate probed', async (t) => {
  const labs = await startMockLabs();
  const { dir } = createScratchProject({});
  t.after(async () => { await labs.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const run = harness(dir, childEnv(labs));

  const first = await run(['harness/scripts/check-model-releases.mjs']);
  assert.equal(first.status, 0, first.stderr);
  const baseline = JSON.parse(first.stdout);
  assert.equal(baseline.hasNewReleases, false);
  for (const lab of ALL_LABS) {
    assert.equal(baseline.results[lab].status, 'success', lab);
    assert.equal(baseline.results[lab].baseline, true, lab);
    assert.ok(baseline.results[lab].models.length >= 1, `${lab} listed no models`);
  }
  assert.equal(labs.listings.length, ALL_LABS.length, 'one catalogue listing per lab');
  assert.ok(labs.listings.every((l) => l.key === `mock-${l.lab}-key`), 'each listing carried that lab\'s own key');
  const snapshot = JSON.parse(fs.readFileSync(path.join(dir, '.agent/model-snapshot.json'), 'utf8'));
  assert.deepEqual(Object.keys(snapshot).sort(), [...ALL_LABS].sort());

  const quiet = await run(['harness/scripts/check-model-releases.mjs']);
  assert.equal(JSON.parse(quiet.stdout).hasNewReleases, false, 'a second run finds nothing new');

  for (const lab of ALL_LABS) labs.models[lab].push(`${labs.models[lab][0]}-next`);
  const release = await run(['harness/scripts/check-model-releases.mjs']);
  const check = JSON.parse(release.stdout);
  assert.equal(check.hasNewReleases, true);
  assert.equal(check.releaseDetected, true);
  assert.equal(check.selectedModels.length, 8, 'max_fanout 8 of 9 new models');
  assert.match(release.stderr, /9 new models exceeds maxFanout=8/);
  assert.equal(new Set(check.selectedModels.map((m) => m.provider)).size, 8, 'eight different labs');

  const checkPath = path.join(dir, 'release-check.json');
  fs.writeFileSync(checkPath, release.stdout);
  const probe = await run(['harness/scripts/probe-models.mjs', 'release-check.json']);
  assert.equal(probe.status, 0, probe.stderr);
  const probed = JSON.parse(fs.readFileSync(checkPath, 'utf8'));
  assert.equal(probed.selectedModels.length, 8, 'every candidate reachable');
  assert.deepEqual(probed.probeDropped, []);
  const probes = labs.requests.filter((r) => r.stage === 'probe');
  assert.equal(probes.length, 8);
  assert.ok(probes.every((r) => r.model.endsWith('-next')), 'the probe called the NEW ids');
});

test('a model the lab does not serve is dropped by the probe, not discovered mid-run', async (t) => {
  const labs = await startMockLabs();
  const { dir } = createScratchProject({});
  t.after(async () => { await labs.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const run = harness(dir, childEnv(labs));

  const checkPath = path.join(dir, 'release-check.json');
  fs.writeFileSync(checkPath, JSON.stringify({
    hasNewReleases: true, releaseDetected: true,
    selectedModels: [{ id: 'gpt-5.5', provider: 'openai' }, { id: 'gpt-99-imaginary', provider: 'openai' }],
  }));
  const probe = await run(['harness/scripts/probe-models.mjs', 'release-check.json']);
  assert.equal(probe.status, 0);
  const probed = JSON.parse(fs.readFileSync(checkPath, 'utf8'));
  assert.deepEqual(probed.selectedModels.map((m) => m.id), ['gpt-5.5']);
  assert.equal(probed.probeDropped.length, 1);
  assert.match(probed.probeDropped[0].reason ?? JSON.stringify(probed.probeDropped[0]), /404|not exist|not served/i);
});

test('the chain, three generations, every lab, with the curiosity mechanisms changing the next prompt', async (t) => {
  const state = { gen: 0, reviews: 0 };
  const ESC1 = 'Allow adding a coverage test under tests/ for the generation paragraphs';
  const ESC2 = 'Unfreeze project-adapter.yml so a model can widen the editable surface';

  const labs = await startMockLabs({
    respond(ctx, fallback) {
      // The suggest and review prompts carry the generation label; rank and
      // implement do not, so the last one seen is the current generation.
      const seen = ctx.user.match(/Generation #(\d+)/)?.[1];
      if (seen) state.gen = Number(seen);
      const gen = state.gen;

      if (ctx.stage === 'suggest') {
        const review = ctx.user.includes('ESCALATION REVIEW:')
          ? { 'ESCALATION REVIEW': 'esc-002: IRRELEVANT — the adapter is the owner\'s to change, and nothing in the goal needs it.' }
          : {};
        if (gen === 1) {
          if (ctx.lab === 'anthropic') return suggestion({ model: ctx.model, fields: { ESCALATION: ESC1, 'ESCALATION TARGET': 'hard-constraint', 'ESCALATION CASE': 'tests/ is frozen, so no generation can add a test that pins the paragraph format; a regression there would ship green.' } });
          if (ctx.lab === 'openai') return suggestion({
            model: ctx.model,
            fields: { ESCALATION: ESC1, 'ESCALATION TARGET': 'hard-constraint', 'ESCALATION CASE': 'The paragraph format is untested and cannot be tested from inside the loop.', 'ESCALATION SUPPORT': 'esc-001 — independently reached the same conclusion' },
            // Breaks the project's own tests on purpose: replaces the marker instead of appending under it.
            edits: [editBlock('index.html', MARKER, `<p data-generation="${ctx.model}">Improved by ${ctx.model}</p>`)],
          });
          if (ctx.lab === 'google') return suggestion({ model: ctx.model, fields: { 'ESCALATION SUPPORT': 'esc-001 — a third lab agrees the frozen tests are the gap' } });
          if (ctx.lab === 'zai') return suggestion({ model: ctx.model, fields: { ESCALATION: ESC2, 'ESCALATION TARGET': 'pipeline', 'ESCALATION CASE': 'One editable file is too narrow to do anything structural.' } });
        }
        return suggestion({ model: ctx.model, fields: review });
      }
      if (ctx.stage === 'rank') return gen === 1 ? 'CHOICE: 2\nREASON: The second proposal also names the missing test.' : fallback(ctx);
      if (ctx.stage === 'implement') {
        if (/FAILED THIS PROJECT'S OWN TESTS|WAS REJECTED BY REVIEW/.test(ctx.user)) {
          const author = ctx.user.match(/^# The proposed improvement, from (.+)$/m)?.[1] ?? 'unknown';
          return editBlock('index.html', MARKER, `${MARKER}\n<p data-generation="${author}">Improved by ${author}, repaired by ${ctx.model}</p>`);
        }
        return fallback(ctx);
      }
      if (ctx.stage === 'review') {
        state.reviews += 1;
        return gen === 1 && state.reviews === 1 ? REJECTION('The paragraph should say who repaired it, not only who proposed it.') : APPROVAL;
      }
      return fallback(ctx);
    },
  });
  const { dir, git } = createScratchProject({ cadence: 2, resurfaceAfter: 1 });
  t.after(async () => { await labs.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const run = harness(dir, childEnv(labs));
  const read = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
  const json = (rel) => JSON.parse(read(rel));
  const suggestPrompt = (gen) => labs.requests.find((r) => r.stage === 'suggest' && r.user.startsWith(`Generation #${gen}`))?.user ?? '';
  const discardBranch = (n) => { git('checkout', '-q', 'main'); git('branch', '-D', `agent/gen-${n}`); };

  // A snapshot first, so the rank seat can be auto-picked from a different
  // family than the implementer (seats.mjs) rather than falling back.
  await run(['harness/scripts/check-model-releases.mjs']);
  git('add', '-A'); git('commit', '-q', '-m', 'Model snapshot');

  // --- Generation 001: all nine labs asked; escalations; repair; refine ------
  const nine = ALL_LABS.map((lab) => labs.models[lab][0]).join(',');
  const g1 = await run(['harness/scripts/rehearse.mjs', '--models', nine]);
  assert.equal(g1.status, 0, g1.stdout + g1.stderr);
  assert.match(g1.stdout, /9 reachable/);
  assert.match(g1.stdout, /Guard: PASS/);
  assert.match(g1.stdout, /Tests: PASS/);
  assert.match(g1.stdout, /Every gate passed/);
  assert.match(g1.stdout, /would open a pull request/);
  assert.match(g1.stderr, /Rank seat defaulted to \S+ \((?!anthropic)\w+\)/, 'ranker from a different family than the implementer');
  assert.match(g1.stderr, /proposal 2 from gpt-6-astra/);
  assert.match(g1.stderr, /Attempt 1 \(gpt-6-astra \(openai\)\): tests failed/);
  assert.match(g1.stderr, /Attempt 2 \(claude-opus-5\): rejected — The paragraph should say who repaired it/);
  assert.match(g1.stderr, /Approved on attempt 3/);
  assert.match(g1.stderr, /escalations-opened=2/);
  assert.match(g1.stderr, /escalations-flagged=1/);

  const suggests1 = labs.requests.filter((r) => r.stage === 'suggest');
  assert.equal(suggests1.length, 9, 'every lab was asked');
  assert.deepEqual(new Set(suggests1.map((r) => r.lab)), new Set(ALL_LABS));
  assert.ok(suggests1.every((r) => r.system.includes('Become a page where a first-time visitor')), 'the committed goal is in every suggest prompt');
  assert.ok(suggests1.every((r) => r.user.includes('# Frozen test invariants')), 'the test index reached the prompt');
  const reviews1 = labs.requests.filter((r) => r.stage === 'review');
  assert.equal(reviews1.length, 2);
  assert.ok(reviews1.every((r) => r.lab === 'openai' && r.model === 'gpt-5.5'), 'the pinned review seat, on its own lab');
  assert.equal(labs.requests.filter((r) => r.stage === 'implement').length, 2, 'the implementer repaired once and refined once');

  // The code change is on the agent branch; the record was committed to
  // main and cleared from the branch's tree, so read it from main.
  assert.match(git('show', 'agent/gen-001:index.html'), /repaired by claude-opus-5/);
  git('checkout', '-q', 'main');
  const record1 = json('docs/generations/gen-001/attempts.json');
  assert.equal(record1.outcome, 'approved');
  assert.equal(record1.campaign, true);
  assert.deepEqual(record1.attempts.map((a) => a.outcome), ['tests-failed', 'rejected-by-review', 'approved']);
  assert.ok(record1.spend.totalTokens > 0, 'spend recorded from provider-reported usage');
  assert.ok(fs.existsSync(path.join(dir, 'docs/generations/gen-001/proposals/glm-5.3.md')), 'losing proposals kept');
  assert.ok(fs.existsSync(path.join(dir, 'docs/generations/gen-001/comparison.json')), 'evaluator before/after compared');
  assert.doesNotMatch(read('index.html'), /Improved by/, 'the code change is on the agent branch, not main');

  const ledger1 = json('docs/escalations/ledger.json');
  const esc1 = ledger1.escalations.find((e) => e.id === 'esc-001');
  assert.equal(esc1.status, 'flagged');
  assert.deepEqual(esc1.flagged.labs, ['anthropic', 'openai', 'google']);
  assert.equal(ledger1.escalations.find((e) => e.id === 'esc-002').status, 'open');
  git('branch', '-D', 'agent/gen-001');

  // --- The owner accepts esc-001; runtime evidence for 001 -----------------
  esc1.status = 'accepted';
  esc1.decision = { date: '2026-09-14', by: 'owner', note: 'Yes — add the test file.' };
  fs.writeFileSync(path.join(dir, 'docs/escalations/ledger.json'), JSON.stringify(ledger1, null, 2) + '\n');
  // The reporter is named explicitly: from Node 24 `node --test` no longer
  // emits TAP by default when its output is a pipe, and a spec-format stream
  // parses as zero tests. The generated workflow's comment says the same.
  const tap = await run(['--test', '--test-reporter=tap', 'tests/page.test.mjs']);
  fs.writeFileSync(path.join(dir, 'tests.tap'), tap.stdout);
  const evidence = await run(['harness/scripts/record-runtime-evidence.mjs', '--tap', 'tests.tap', '--tap-name', 'page tests', '--timing', 'tests=200'], { GEN_NUMBER: '001' });
  assert.equal(evidence.status, 0, evidence.stderr);
  fs.rmSync(path.join(dir, 'tests.tap'));
  assert.equal(json('docs/runtime/gen-001.json').tests.suites[0].passed, 3);
  git('add', '-A'); git('commit', '-q', '-m', 'Accept esc-001; runtime evidence');

  // --- Generation 002: focused; esc-002 resurfaced and retired ---------------
  const g2 = await run(['harness/scripts/rehearse.mjs', '--models', 'kimi-k3,deepseek-v4-pro,grok-4.6']);
  assert.equal(g2.status, 0, g2.stdout + g2.stderr);
  assert.match(g2.stderr, /Asking about 1 escalation\(s\) nobody has engaged with: esc-002/);
  const p2 = suggestPrompt('002');
  assert.ok(p2.includes('What the last runs actually observed at runtime'), 'runtime evidence in the prompt');
  assert.ok(p2.includes('ESCALATION REVIEW:'), 'the resurfaced entry is put to the models');
  assert.ok(p2.includes('Most recent generations, in full detail'), 'history in the prompt');
  assert.ok(!p2.includes('THIS GENERATION HAS BEEN ASSIGNED A DECIDED CHANGE'), 'a focused run takes no work order');
  discardBranch('002');
  const ledger2 = json('docs/escalations/ledger.json');
  const esc2 = ledger2.escalations.find((e) => e.id === 'esc-002');
  assert.equal(esc2.status, 'retired');
  assert.equal(esc2.irrelevant.length, 3);
  assert.ok(ledger2.escalations.find((e) => e.id === 'esc-001').work.queued, 'the accepted entry is a queued work order');

  // --- The themes review at the cadence boundary -----------------------------
  const themes = await run(['harness/scripts/generate-themes-review.mjs'], { GEN_NUMBER: '002' });
  assert.equal(themes.status, 0, themes.stderr);
  assert.match(themes.stderr, /cadence boundary/);
  const review = json('docs/themes/review-002.json');
  assert.equal(review.throughGeneration, '002');
  assert.equal(review.model, 'gpt-5.5');
  assert.equal(review.themes.length, 2);
  assert.ok(review.themes[0].unknown, 'the UNKNOWN field was kept');
  const themesCall = labs.requests.find((r) => r.stage === 'themes');
  assert.ok(themesCall.user.includes('Generation history through 002'));
  git('add', '-A'); git('commit', '-q', '-m', 'Themes review');
  const notDue = await run(['harness/scripts/generate-themes-review.mjs'], { GEN_NUMBER: '002' });
  assert.equal(notDue.status, 0);
  assert.match(notDue.stderr, /already covers generation 002/);

  // --- Generation 003: ambitious; carries the work order; sees the review ----
  const g3 = await run(['harness/scripts/rehearse.mjs', '--models', 'muse-spark-1.3,qwen3.5-max', '--scope', 'ambitious']);
  assert.equal(g3.status, 0, g3.stdout + g3.stderr);
  assert.match(g3.stderr, /Carrying work order esc-001/);
  assert.match(g3.stderr, /Work order esc-001 completed: approved/);
  assert.match(g3.stderr, /work-order-completed=esc-001:approved/);
  const p3 = suggestPrompt('003');
  assert.ok(p3.includes('THIS GENERATION HAS BEEN ASSIGNED A DECIDED CHANGE'));
  assert.ok(p3.includes('Recurring themes from the last review'));
  assert.ok(p3.includes('Open questions this project has not answered'));
  assert.ok(p3.includes(review.themes[0].unknown), 'the review\'s open question, verbatim');
  assert.ok(p3.includes('Every generation on record'));
  const rank3 = labs.requests.filter((r) => r.stage === 'rank').at(-1);
  assert.match(rank3.system, /explicitly AMBITIOUS/, 'the ambitious rubric');
  discardBranch('003');
  const work = json('docs/escalations/ledger.json').escalations.find((e) => e.id === 'esc-001').work;
  assert.equal(work.assigned.generation, '003');
  assert.equal(work.completed.outcome, 'approved');

  // --- The report ------------------------------------------------------------
  const report = await run(['harness/scripts/report.mjs']);
  assert.equal(report.status, 0, report.stderr);
  const page = read('docs/generations/REPORT.md');
  assert.match(page, /Generations on record \| 3 \(3 in campaign mode\)/);
  assert.match(page, /3 approved only in a local rehearsal and never put to a person/);
  for (const lab of ALL_LABS) assert.match(page, new RegExp(`^\\| ${lab} \\| [1-9]\\d* \\|`, 'm'), `${lab} was asked`);
  assert.match(page, /^\| anthropic \| 1 \| 0 \| 0 \| 0 \| 0 \|/m, 'anthropic proposed once and did not win');
  assert.match(page, /^\| openai \| 1 \| 1 \| 1 \| 0 \| 0 \|/m, 'openai won 001 but its own edits did not ship');

  // Nothing above ever touched a real host: every request went to the mock.
  assert.ok(labs.requests.length > 20);
  assert.ok(labs.requests.every((r) => ALL_LABS.includes(r.lab)));
});
