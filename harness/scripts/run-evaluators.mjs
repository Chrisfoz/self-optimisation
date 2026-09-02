#!/usr/bin/env node

/**
 * CLI entry point for harness/lib/evaluators.mjs — run this project's
 * quality-dimension plugins against the tree a generation just produced, and
 * write down what they measured.
 *
 * See harness/plugins/evaluators/README.md for the interface a plugin
 * implements. The short version: these are the measurements that are NOT
 * gates. A plugin cannot fail a generation, cannot stop a merge, and cannot
 * block a pull request — which is why this script exits 0 even when every
 * plugin it loaded blew up. The one thing it will not do is stay silent
 * about that: the failures are recorded in metrics.json and printed.
 *
 * Run from a target project's root, after run-generation.mjs:
 *
 *   node harness/scripts/run-evaluators.mjs
 *
 * Environment:
 *   GEN_NUMBER   which generation's record to read and write beside.
 *                Defaults to the newest on record.
 *
 * Outputs (GITHUB_OUTPUT): `ran`, `metrics`, `errors`, `path`.
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { setOutput } from '../lib/gh-output.mjs';
import { loadAdapter, contextConfig, evaluatorConfig } from '../lib/adapter.mjs';
import { generationNumbers } from '../lib/context-pack.mjs';
import { runEvaluators, buildMetricsRecord, DEFAULT_TIMEOUT_MS } from '../lib/evaluators.mjs';

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

const configured = evaluatorConfig(adapter);
if (!configured.length) {
  // The normal state of most projects. Not a warning, not a failure: a
  // project with no quality dimensions configured has simply not asked for
  // any, and the next prompt is byte-identical to one from before this
  // script existed.
  console.error('No evaluators configured (evaluation.evaluators in project-adapter.yml). Nothing to measure.');
  setOutput('ran', 'false');
  process.exit(0);
}

const generationsDir = contextConfig(adapter).generationsDir || 'docs/generations';
const onRecord = generationNumbers({ repoRoot, generationsDir });
const genNumber = process.env.GEN_NUMBER || onRecord[onRecord.length - 1] || '';

if (!genNumber) {
  console.error('No generation to measure — no GEN_NUMBER set and no generation records on disk.');
  setOutput('ran', 'false');
  process.exit(0);
}

// The generation record, if there is one. Absent is fine: a plugin that only
// measures the tree never looks at it, and one that does gets null and can
// say so in its own detail line.
let generation = null;
const recordPath = path.join(repoRoot, generationsDir, `gen-${genNumber}`, 'attempts.json');
try {
  generation = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
} catch {
  console.error(`(no readable ${generationsDir}/gen-${genNumber}/attempts.json — plugins will be given null)`);
}

// --- load the plugins ---------------------------------------------------
// Loading is here rather than in lib/ so runEvaluators() stays testable with
// plain objects and no dynamic import. A module that fails to load is
// recorded exactly like a plugin that throws — same rule, one step earlier.
const plugins = [];
const loadErrors = [];
for (const entry of configured) {
  const modulePath = path.resolve(repoRoot, entry.module);
  try {
    const mod = await import(pathToFileURL(modulePath).href);
    const plugin = mod.default ?? mod;
    plugins.push({
      name: entry.name || plugin?.name || entry.module,
      evaluate: plugin?.evaluate,
      config: entry.config || {},
    });
  } catch (err) {
    loadErrors.push({ plugin: entry.name || entry.module, error: `could not be loaded: ${err.message}` });
    console.error(`   ⚠️  ${entry.module} could not be loaded: ${err.message} (not gating)`);
  }
}

console.error(`📏 Running ${plugins.length} evaluator(s) against generation ${genNumber}...`);

const { metrics, errors } = await runEvaluators({
  plugins,
  repoRoot,
  generation,
  timeoutMs: Number(process.env.EVALUATOR_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  log: (msg) => console.error(msg),
});

const record = buildMetricsRecord({
  throughGeneration: genNumber,
  metrics,
  errors: [...loadErrors, ...errors],
});

// Forward slashes, not path.join(), for the RECORDED path — the same
// convention orchestrator.mjs's writeAttemptRecord() and
// recordPullRequestUrl() already follow. A repo-relative path is a git
// path, and a value recorded as `docs\\generations\\gen-001\\metrics.json`
// because someone ran this on Windows is a different string from the one
// CI writes for the same file. path.join() is still what touches the
// filesystem, where the separator genuinely has to be the platform's.
const relative = `${generationsDir}/gen-${genNumber}/metrics.json`;
fs.mkdirSync(path.join(repoRoot, generationsDir, `gen-${genNumber}`), { recursive: true });
fs.writeFileSync(path.join(repoRoot, relative), JSON.stringify(record, null, 2) + '\n', 'utf8');

console.error(`\nWrote ${relative}: ${record.metrics.length} metric(s), ${record.errors.length} error(s).`);
for (const m of record.metrics) {
  console.error(`   ${m.name}: ${m.value}${m.unit ? ` ${m.unit}` : ''}`);
}

setOutput('ran', 'true');
setOutput('path', relative);
setOutput('metrics', String(record.metrics.length));
setOutput('errors', String(record.errors.length));

// Always 0. These are measurements, and a measurement that can fail a
// workflow step is a gate — see harness/plugins/evaluators/README.md, rule 1.
process.exit(0);
