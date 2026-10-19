#!/usr/bin/env node

/**
 * The replay bench (harness/lib/bench.mjs): every task × variant × trial in a
 * fresh clone at the task's pinned commit, one real generation each through
 * run-generation.mjs, then the task's held-out oracle commands. Writes
 * results.json and REPORT.md to --out. Never pushes, never opens a pull
 * request, never writes back to the task's repository.
 *
 *   node --env-file=harness/.env.harness.local harness/scripts/bench.mjs bench.json --out bench-out
 *
 * Spec (JSON):
 *   {
 *     "trials": 3,
 *     "budgetTokens": 600000,
 *     "tasks": [{
 *       "id": "planted-off-by-one",
 *       "repo": "../my-project",               // path or git URL
 *       "baseCommit": "4f2a9c1",               // pins source AND memory
 *       "suggestModels": [{"id": "gemini-3.8-flash", "provider": "google"}],
 *       "setupCommands": ["npm ci"],           // optional
 *       "oracleCommands": ["node --test $BENCH_ORACLE_DIR/hidden.test.mjs"]
 *     }],
 *     "variants": [
 *       {"id": "full-dump", "adapter": {"context": {"strategy": "full-dump"}}},
 *       {"id": "scoped",    "adapter": {"context": {"strategy": "scoped"}}}
 *     ]
 *   }
 *
 * The first variant is the baseline. Oracle files live outside the clone
 * (BENCH_ORACLE_DIR is the spec file's own directory), so no model can read
 * them. Lab keys reach the generation only; setup and oracle commands run
 * with every secret scrubbed, the same as the loop's own test runner.
 */

import fs from 'fs';
import os from 'node:os';
import path from 'path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import '../providers/index.mjs';
import { getProvider, registeredProviders } from '../lib/llm-provider.mjs';
import { loadAdapter, contextConfig } from '../lib/adapter.mjs';
import { nextGenerationNumber } from '../lib/generation-id.mjs';
import { runProjectTests, scrubEnv } from '../lib/test-runner.mjs';
import { validateSpec, mergeAdapter, scoreTrial, summarise, compare, renderReport, withOracleDir } from '../lib/bench.mjs';

const HARNESS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_GENERATION = path.join(HARNESS_DIR, 'scripts/run-generation.mjs');

const argv = process.argv.slice(2);
const specPath = argv.find((a) => !a.startsWith('--'));
const outIdx = argv.indexOf('--out');
const outDir = path.resolve(outIdx >= 0 ? argv[outIdx + 1] : 'bench-out');
const keep = argv.includes('--keep-workspaces');
if (!specPath) {
  console.error('Usage: node harness/scripts/bench.mjs <bench.json> [--out <dir>] [--keep-workspaces]');
  process.exit(1);
}

let spec;
try {
  spec = validateSpec(JSON.parse(fs.readFileSync(specPath, 'utf8')));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const specDir = path.dirname(path.resolve(specPath));
fs.mkdirSync(outDir, { recursive: true });

const secretNames = registeredProviders().map((n) => getProvider(n)?.envKey).filter(Boolean);
const quietEnv = scrubEnv(process.env, { extraSecretNames: secretNames });

function prepareWorkspace(task, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bench-${label}-`));
  const repo = /^[\w+.-]+:\/\//.test(task.repo) || task.repo.startsWith('git@') ? task.repo : path.resolve(specDir, task.repo);
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['clone', '--quiet', '--no-local', repo, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('checkout', '--quiet', '--detach', task.baseCommit);
  git('config', 'user.email', 'bench@localhost');
  git('config', 'user.name', 'bench');
  // A project that symlinks or ignores harness/ (rather than committing a
  // copy) still names paths under it in its adapter, e.g. evaluator plugins.
  if (!fs.existsSync(path.join(dir, 'harness'))) fs.symlinkSync(HARNESS_DIR, path.join(dir, 'harness'));
  return dir;
}

async function runTrial(task, variant, trial) {
  const started = Date.now();
  const label = `${task.id}-${variant.id}-${trial}`.replace(/[^\w.-]+/g, '_');
  let dir = null;
  try {
    dir = prepareWorkspace(task, label);
    const adapterPath = path.join(dir, 'project-adapter.yml');
    const base = await loadAdapter(adapterPath);
    if (!base) throw new Error(`no project-adapter.yml at ${task.baseCommit}`);
    let adapter = mergeAdapter(base, variant.adapter ?? {});
    if (spec.budgetTokens) adapter = mergeAdapter(adapter, { budget: { max_generation_tokens: spec.budgetTokens } });
    // YAML is a superset of JSON, so the merged adapter is written as JSON
    // and read back by the same loader: no YAML emitter needed here.
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2));

    if (task.setupCommands?.length) {
      const setup = await runProjectTests({ repoRoot: dir, commands: task.setupCommands, env: quietEnv });
      if (!setup.passed) throw new Error(`setup failed: ${setup.results.find((r) => !r.passed)?.command}`);
    }

    const generationsDir = contextConfig(adapter).generationsDir || 'docs/generations';
    // The next number the project itself would take, so everything that
    // reads the sequence (the index, resurfacing, scope) sees a normal run.
    const genNumber = nextGenerationNumber((...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(), { generationsDir });
    const gen = spawnSync(process.execPath, [RUN_GENERATION], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        ...(variant.env ?? {}),
        GEN_NUMBER: genNumber,
        SUGGEST_MODELS: JSON.stringify(task.suggestModels),
        CAMPAIGN: 'true',
        RUN_ID: `bench-${label}`,
        GITHUB_OUTPUT: '',
      },
    });
    fs.writeFileSync(path.join(outDir, `${label}.log`), gen.stderr ?? '');
    const recordFile = path.join(dir, generationsDir, `gen-${genNumber}`, 'attempts.json');
    const record = fs.existsSync(recordFile) ? JSON.parse(fs.readFileSync(recordFile, 'utf8')) : null;
    if (!record) throw new Error(`run-generation wrote no record (exit ${gen.status}); see ${label}.log`);
    fs.copyFileSync(recordFile, path.join(outDir, `${label}.attempts.json`));

    const oracle = await runProjectTests({
      repoRoot: dir,
      commands: task.oracleCommands.map((c) => withOracleDir(c, specDir)),
      env: { ...quietEnv, BENCH_ORACLE_DIR: specDir },
    });
    return scoreTrial({ task, variant, trial, record, oracle: oracle.results, durationMs: Date.now() - started });
  } catch (err) {
    return scoreTrial({ task, variant, trial, record: null, oracle: [], durationMs: Date.now() - started, error: err.message });
  } finally {
    if (dir && !keep) fs.rmSync(dir, { recursive: true, force: true });
  }
}

const startedAt = new Date().toISOString();
const results = [];
// Variants interleave within each trial, so drift over the run (a lab having
// a bad hour) lands on every variant rather than on whichever ran last.
for (const task of spec.tasks) {
  for (let trial = 1; trial <= spec.trials; trial++) {
    for (const variant of spec.variants) {
      console.error(`▶ ${task.id} · ${variant.id} · trial ${trial}`);
      const r = await runTrial(task, variant, trial);
      console.error(`  ${r.outcome}, oracle ${r.oraclePassed ? 'pass' : 'fail'}, ${r.totalTokens.toLocaleString()} tokens${r.error ? ` — ${r.error}` : ''}`);
      results.push(r);
    }
  }
}

const summary = summarise(results);
const baseline = summary.find((s) => s.variant === spec.variants[0].id);
const comparisons = summary.filter((s) => s !== baseline).map((s) => ({ variant: s.variant, ...compare(baseline, s) }));
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ startedAt, spec, results, summary, comparisons }, null, 2) + '\n');
fs.writeFileSync(path.join(outDir, 'REPORT.md'), renderReport({ spec, results, summary, comparisons, startedAt }));
console.error(`\nWrote ${path.relative(process.cwd(), path.join(outDir, 'REPORT.md'))}`);
for (const c of comparisons) console.error(`  ${c.variant}: ${c.decision} — ${c.reasons.join('; ')}`);
