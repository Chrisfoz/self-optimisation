#!/usr/bin/env node

/**
 * Local rehearsal of the whole chain the generated workflow runs — P0.2 of
 * docs/Review-10x-2026-09.md. Answers principle 2
 * (learning/01-principles.md, "give yourself a way to rehearse"): the
 * product loop triggers on real novelty, which makes it impossible to test
 * on demand, and the harness itself has had exactly the same problem —
 * every check in this repository fakes the three model calls, and the one
 * genuinely real run this harness has ever made had no API key
 * (docs/Review-10x-2026-09.md, F12). This is the door: run the real chain,
 * for real, on a local branch, on demand.
 *
 * Deliberately a thin sequencer over the same CLIs the generated workflow
 * calls — check-model-releases.mjs / campaign-models.mjs, probe-models.mjs,
 * run-generation.mjs, check-guarded-paths.mjs — rather than a
 * reimplementation of any of them, for the reason harness/lib/rehearse.mjs's
 * own doc comment gives: this can never drift from what the real workflow
 * does, because it IS the real workflow's steps, run as a human watches
 * rather than as YAML.
 *
 * What it never does: push anywhere, open a pull request, or merge. A
 * rehearsal ends with a local branch and a printed verdict about what the
 * real workflow would have done with it — inspecting and discarding it is
 * on the person who ran this, same as any other local branch.
 *
 * Usage:
 *   node harness/scripts/rehearse.mjs [--models id1,id2] [--scope focused|ambitious]
 *     [--adapter <path>] [--test-command "npm test"]... [--skip-preflight]
 *
 * --models runs a campaign generation on the named ids now, the same as the
 * workflow's `models` dispatch input. Without it, this checks for a real
 * new release the same way the scheduled run does — which, with no lab API
 * key configured, deterministically finds nothing and exits 0 having spent
 * and changed nothing (see checkReleases()'s own "no key -> skipped, never
 * a silent failure" rule).
 */

import fs from 'fs';
import os from 'node:os';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import '../providers/index.mjs';
import {
  loadAdapter, constitutionAllowlist, guardConfig, contextConfig,
  evaluationConfig, approvalClass, snapshotPath as adapterSnapshotPath,
} from '../lib/adapter.mjs';
import { validateAdapter } from '../lib/validate.mjs';
import { nextGenerationNumber } from '../lib/rehearse.mjs';
import { reserveGeneration } from '../lib/generation-id.mjs';

const harnessDir = path.dirname(fileURLToPath(import.meta.url));
const script = (name) => path.join(harnessDir, name);

function parseArgs(argv) {
  const out = { testCommands: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--models') out.models = argv[++i];
    else if (a === '--scope') out.scope = argv[++i];
    else if (a === '--adapter') out.adapter = argv[++i];
    else if (a === '--test-command') out.testCommands.push(argv[++i]);
    else if (a === '--skip-preflight') out.skipPreflight = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^\s*\* ?/gm, ''));
  process.exit(0);
}

const repoRoot = process.cwd();
const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd: repoRoot, encoding: 'utf8' }).trim();

function fail(message) {
  console.error(`\n❌ ${message}`);
  process.exit(1);
}

// Every child process gets PROJECT_ADAPTER_PATH explicitly, so a custom
// --adapter given to rehearse.mjs itself reaches check-model-releases.mjs,
// campaign-models.mjs and run-generation.mjs too — each of them otherwise
// defaults to project-adapter.yml in the current directory, which is only
// the same file by coincidence unless this is set.
function spawnEnv(extra = {}) {
  return { ...process.env, PROJECT_ADAPTER_PATH: adapterPath, ...extra };
}

function run(nodeArgs, opts = {}) {
  return spawnSync(process.execPath, nodeArgs, { cwd: repoRoot, env: spawnEnv(), ...opts });
}

// --- must be a real git repo, on a real branch, with nothing uncommitted ---
// A rehearsal creates a real local branch and, for the release-check path,
// a real commit to the base branch (the model snapshot) — both of those
// should start from a known baseline, the same reasoning preflight itself
// exists for.
try {
  git('rev-parse', '--git-dir');
} catch {
  fail('Not a git repository. Run this from your project root.');
}
if (git('status', '--porcelain')) {
  fail('Working tree is not clean. Commit or stash your changes first — a rehearsal branches from HEAD and should start from a known baseline.');
}
const baseBranch = git('branch', '--show-current');
if (!baseBranch) fail('Could not determine the current branch (detached HEAD?). Check out a real branch first.');

// --- adapter, then validate it before anything else runs ------------------
const adapterPath = args.adapter || process.env.PROJECT_ADAPTER_PATH || path.join(repoRoot, 'project-adapter.yml');
let adapter;
try {
  adapter = await loadAdapter(adapterPath);
} catch (err) {
  fail(`${adapterPath}: ${err.message}`);
}
if (!adapter) fail(`No project-adapter.yml found at ${adapterPath}. Run \`node harness/cli/init.mjs\` first.`);
console.log(`Using ${adapterPath}\n`);

console.log('Step 1/6 — Validating the adapter');
{
  const { errors, warnings } = validateAdapter(adapter, { repoRoot });
  for (const w of warnings) console.log(`   ⚠️  ${w}`);
  if (errors.length) {
    for (const e of errors) console.log(`   ❌ ${e}`);
    fail('Fix the error(s) above before rehearsing.');
  }
  console.log('   OK\n');
}

// --- preflight: prove the baseline before spending anything ---------------
const testCommands = args.testCommands.length ? args.testCommands : evaluationConfig(adapter).testCommands;
console.log('Step 2/6 — Preflight');
if (args.skipPreflight) {
  console.log('   Skipped (--skip-preflight)\n');
} else if (testCommands.length === 0) {
  console.log('   ⚠️  No test commands configured (evaluation.test_commands, or pass --test-command) — nothing to prove a baseline with.\n');
} else {
  for (const cmd of testCommands) {
    console.log(`   $ ${cmd}`);
    const result = spawnSync(cmd, { cwd: repoRoot, shell: true, stdio: 'inherit' });
    if (result.status !== 0) {
      fail(`Preflight failed on "${cmd}" (exit ${result.status}). A failure after this point would not be attributable to the agent — fix the baseline first.`);
    }
  }
  console.log('   All green\n');
}

// --- detect a release, or run the campaign the caller named ---------------
console.log('Step 3/6 — Checking for a model to run on');
const releaseCheckPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rehearse-')), 'release-check.json');
let releaseCheck;
let campaign = false;
if (args.models) {
  campaign = true;
  const result = run([script('campaign-models.mjs'), args.models], { stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.status !== 0) fail(`campaign-models.mjs: ${(result.stdout || '').toString().trim() || 'could not resolve the named models'}`);
  fs.writeFileSync(releaseCheckPath, result.stdout);
  releaseCheck = JSON.parse(result.stdout.toString());
  console.log(`   Campaign: ${releaseCheck.selectedModels.map((m) => `${m.id} (${m.provider})`).join(', ')}\n`);
} else {
  const result = run([script('check-model-releases.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
  fs.writeFileSync(releaseCheckPath, result.stdout);
  releaseCheck = JSON.parse(result.stdout.toString());

  // Mirrors the workflow's own "Commit the updated model snapshot" step:
  // check-model-releases.mjs already wrote the file as a side effect of
  // running; this just records that on the base branch the same way the
  // real workflow does, so a model tried once isn't offered again forever.
  const snapshotAbs = path.resolve(repoRoot, adapterSnapshotPath(adapter) || '.agent/model-snapshot.json');
  const snapshotRel = path.relative(repoRoot, snapshotAbs);
  if (fs.existsSync(snapshotAbs) && git('status', '--porcelain', '--', snapshotRel)) {
    git('add', '--', snapshotRel);
    git('commit', '-q', '-m', 'Update model snapshot');
    console.log(`   Committed ${snapshotRel} to ${baseBranch}`);
  }

  if (!releaseCheck.hasNewReleases) {
    fs.rmSync(path.dirname(releaseCheckPath), { recursive: true, force: true });
    console.log('\nNothing to rehearse — no new model release, and no --models given for a campaign run.');
    process.exit(0);
  }
}

// --- probe reachability -----------------------------------------------------
console.log('\nStep 4/6 — Probing reachability');
run([script('probe-models.mjs'), releaseCheckPath], { stdio: 'inherit' });
releaseCheck = JSON.parse(fs.readFileSync(releaseCheckPath, 'utf8'));
fs.rmSync(path.dirname(releaseCheckPath), { recursive: true, force: true });

if (!releaseCheck.selectedModels.length) {
  console.log('\nNothing to rehearse — no candidate model was reachable (check your API keys).');
  process.exit(0);
}
console.log(`   ${releaseCheck.selectedModels.length} reachable: ${releaseCheck.selectedModels.map((m) => m.id).join(', ')}\n`);

// --- the agent branch --------------------------------------------------------
// Numbered and claimed exactly as the workflow does (generation-id.mjs):
// one past the highest tag, agent branch or record on the base branch, and
// never a branch that already exists. It used to read tags alone, so every
// rehearsal on the pull-request path was generation 001.
const generationsDir = contextConfig(adapter).generationsDir || 'docs/generations';
const { number: genNumber, branch } = reserveGeneration(git, {
  start: nextGenerationNumber(git, { generationsDir, baseRef: baseBranch }),
  remote: null,
});
console.log(`Step 5/6 — Generation ${genNumber} on branch ${branch}`);
git('checkout', '-q', branch);

const improveResult = run([script('run-generation.mjs')], {
  stdio: 'inherit',
  env: spawnEnv({
    SUGGEST_MODELS: JSON.stringify(releaseCheck.selectedModels),
    GEN_NUMBER: genNumber,
    SCOPE: args.scope || '',
    CAMPAIGN: campaign ? 'true' : '',
    // The same commands preflight used, run inside the loop against each
    // attempt; --skip-preflight means no tests at all, here as elsewhere.
    TEST_COMMANDS: JSON.stringify(testCommands),
    TEST_IN_LOOP: args.skipPreflight ? 'false' : '',
  }),
});

const genDirRel = `${generationsDir}/gen-${genNumber}`;

// The record goes to the base branch on EVERY outcome, as persist-records.mjs
// does in the workflow — locally here, never pushed. A failed rehearsal is
// the one whose record is most worth keeping.
function persistLocally() {
  const result = spawnSync(process.execPath, [script('persist-records.mjs'), '--base', baseBranch, '--no-push'], {
    cwd: repoRoot, env: spawnEnv({ GEN_NUMBER: genNumber }), stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.status !== 0) console.log(`   ⚠️  Could not commit the record to ${baseBranch}; it is still in ${genDirRel}.`);
  else console.log(`   Record committed to ${baseBranch} (not pushed).`);
}

if (improveResult.status !== 0) {
  console.log(`\nNo change shipped this cycle — see ${genDirRel}/attempts.json for what was tried.`);
  persistLocally();
  console.log(`You are still on ${branch}, with no code change committed.`);
  console.log(`   Back to ${baseBranch}:  git checkout ${baseBranch} && git branch -D ${branch}`);
  process.exit(1);
}

// --- commit, guard, test, the same order and gates the workflow uses -------
console.log('\nStep 6/6 — Committing, guarding, and testing the change');
const { allowedPaths, createOnlyPaths } = constitutionAllowlist(adapter);

let summary = `Generation ${genNumber}`;
try {
  const record = JSON.parse(fs.readFileSync(path.join(repoRoot, genDirRel, 'attempts.json'), 'utf8'));
  if (record.proposalSummary) summary = `Generation ${genNumber}: ${record.proposalSummary}`;
} catch { /* the generic message is fine */ }

// The code change only — edited and newly created files — one pathspec at a
// time, since `git add` on a glob that matches nothing is an error.
for (const p of [...new Set([...allowedPaths, ...createOnlyPaths])]) {
  if (git('status', '--porcelain', '--', p)) git('add', '-A', '--', p);
}
git('commit', '-q', '-m', summary);
persistLocally();

const guardResult = run([script('check-guarded-paths.mjs'), baseBranch], { stdio: 'inherit' });
console.log(guardResult.status === 0 ? '   Guard: PASS' : '   Guard: FAIL');

let testsOk = true;
if (testCommands.length && !args.skipPreflight) {
  for (const cmd of testCommands) {
    const result = spawnSync(cmd, { cwd: repoRoot, shell: true, stdio: 'inherit' });
    if (result.status !== 0) { testsOk = false; break; }
  }
}
console.log(testsOk ? '   Tests: PASS' : '   Tests: FAIL');

// --- summary ---------------------------------------------------------------
const wouldShip = guardResult.status === 0 && testsOk;
console.log(`\n${summary}`);
console.log(wouldShip ? '   Every gate passed.' : '   Held for inspection — not every gate passed.');
if (wouldShip) {
  console.log(
    approvalClass(adapter) === 'autonomous-merge'
      ? '   The real workflow would merge and tag this automatically.'
      : '   The real workflow would open a pull request for you to merge.'
  );
}
console.log(`\n   Inspect:  git diff ${baseBranch}..${branch}`);
console.log(`   Discard:  git checkout ${baseBranch} && git branch -D ${branch}`);
process.exit(wouldShip ? 0 : 1);
