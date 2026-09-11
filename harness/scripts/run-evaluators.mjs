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
 * --baseline measures the UNTOUCHED tree, before the generation changes
 * anything, into baseline-metrics.json. The default run (after the change)
 * writes metrics.json and, when a baseline for the same generation exists,
 * comparison.json: every metric before and after, classified as a benefit,
 * a regression, or no change, with the cost of the generation beside it
 * (harness/lib/measure.mjs). Both runs record a fingerprint of exactly which
 * evaluators ran with which config; two that differ are not compared.
 *
 * Outputs (GITHUB_OUTPUT): `ran`, `metrics`, `artifacts`, `errors`, `path`,
 * and after a comparison `benefits`, `regressions`, `comparison`.
 */

import fs from 'fs';
import path from 'path';
import { setOutput } from '../lib/gh-output.mjs';
import { loadAdapter, contextConfig, evaluatorConfig } from '../lib/adapter.mjs';
import { generationNumbers } from '../lib/context-pack.mjs';
import { runEvaluators, buildMetricsRecord, loadEvaluatorPlugin, artifactsDirFor, DEFAULT_TIMEOUT_MS } from '../lib/evaluators.mjs';
import { evaluatorFingerprint, compareMeasurements, buildComparisonRecord, summarizeComparison } from '../lib/measure.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--adapter') out.adapter = argv[++i];
    else if (argv[i] === '--baseline') out.baseline = true;
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
// runEvaluators() itself still takes already-loaded plugins, so it stays
// testable with plain objects and no dynamic import; loadEvaluatorPlugin()
// is shared with run-generation.mjs, which loads the same interface for the
// visual-capture hook. A module that fails to load is recorded exactly like
// a plugin that throws — same rule, one step earlier.
const plugins = [];
const loadErrors = [];
for (const entry of configured) {
  try {
    plugins.push(await loadEvaluatorPlugin({ repoRoot, ...entry }));
  } catch (err) {
    loadErrors.push({ plugin: entry.name || entry.module, error: `could not be loaded: ${err.message}` });
    console.error(`   ⚠️  ${entry.module} could not be loaded: ${err.message} (not gating)`);
  }
}

// The one directory a plugin may write to (docs/Tool-Use-Design.md §4.1).
// Inside the generation's own record folder, so a render travels with the
// generation it describes and the workflow's existing `git add` of the
// generations directory picks it up with everything else.
// A baseline's artifacts go in their own folder: the next generation's
// prompt attaches images from metrics.json's artifacts, and those must show
// the state a change produced, never the state it started from.
const artifactsRelative = args.baseline ? `${generationsDir}/gen-${genNumber}/baseline-artifacts` : artifactsDirFor({ generationsDir, genNumber });
const artifactsAbsolute = path.join(repoRoot, generationsDir, `gen-${genNumber}`, args.baseline ? 'baseline-artifacts' : 'artifacts');
fs.mkdirSync(artifactsAbsolute, { recursive: true });

console.error(`📏 Running ${plugins.length} evaluator(s) against generation ${genNumber}${args.baseline ? ' — the BASELINE, before any change' : ''}...`);

const { metrics, artifacts, errors } = await runEvaluators({
  plugins,
  repoRoot,
  generation,
  artifactsDir: artifactsAbsolute,
  timeoutMs: Number(process.env.EVALUATOR_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  log: (msg) => console.error(msg),
});

const record = buildMetricsRecord({
  throughGeneration: genNumber,
  metrics,
  artifacts,
  errors: [...loadErrors, ...errors],
});
// Which evaluators, configured how — what makes a baseline and an after
// measurement comparable, or not. See harness/lib/measure.mjs.
record.fingerprint = evaluatorFingerprint(configured);
record.phase = args.baseline ? 'baseline' : 'after';

// An empty artifacts directory is noise in a diff a human reads. Removed
// only when nothing wrote to it, never when a plugin did.
try {
  if (fs.readdirSync(artifactsAbsolute).length === 0) fs.rmdirSync(artifactsAbsolute);
} catch { /* a directory that will not go quietly is not worth a failed run */ }

// Forward slashes, not path.join(), for the RECORDED path — the same
// convention orchestrator.mjs's writeAttemptRecord() and
// recordPullRequestUrl() already follow. A repo-relative path is a git
// path, and a value recorded as `docs\\generations\\gen-001\\metrics.json`
// because someone ran this on Windows is a different string from the one
// CI writes for the same file. path.join() is still what touches the
// filesystem, where the separator genuinely has to be the platform's.
const relative = `${generationsDir}/gen-${genNumber}/${args.baseline ? 'baseline-metrics.json' : 'metrics.json'}`;
fs.mkdirSync(path.join(repoRoot, generationsDir, `gen-${genNumber}`), { recursive: true });
fs.writeFileSync(path.join(repoRoot, relative), JSON.stringify(record, null, 2) + '\n', 'utf8');

console.error(`\nWrote ${relative}: ${record.metrics.length} metric(s), ${record.artifacts.length} artifact(s), ${record.errors.length} error(s).`);
for (const m of record.metrics) {
  console.error(`   ${m.name}: ${m.value}${m.unit ? ` ${m.unit}` : ''}`);
}
for (const a of record.artifacts) {
  console.error(`   ${a.kind}: ${a.label}${a.file ? ` (${artifactsRelative}/${a.file})` : ''}`);
}

setOutput('ran', 'true');
setOutput('path', relative);
setOutput('metrics', String(record.metrics.length));
setOutput('artifacts', String(record.artifacts.length));
setOutput('errors', String(record.errors.length));

// --- before and after -------------------------------------------------------
if (!args.baseline) {
  const baselinePath = path.join(repoRoot, generationsDir, `gen-${genNumber}`, 'baseline-metrics.json');
  let baseline = null;
  try { baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')); } catch { /* no baseline was taken */ }
  if (baseline) {
    const comparison = buildComparisonRecord({ genNumber, comparison: compareMeasurements(baseline, record), record: generation });
    const comparisonRelative = `${generationsDir}/gen-${genNumber}/comparison.json`;
    fs.writeFileSync(path.join(repoRoot, comparisonRelative), `${JSON.stringify(comparison, null, 2)}\n`, 'utf8');
    console.error(`\n⚖️  Before → after: ${summarizeComparison(comparison)}`);
    for (const r of comparison.rows.filter((row) => row.verdict !== 'unchanged')) {
      console.error(`   ${r.verdict.padEnd(12)} ${r.name}: ${r.before ?? '—'} → ${r.after ?? '—'}${r.unit ? ` ${r.unit}` : ''}`);
    }
    setOutput('comparison', comparisonRelative);
    setOutput('benefits', String(comparison.benefits.length));
    setOutput('regressions', String(comparison.regressions.length));
  } else {
    console.error('(no baseline-metrics.json for this generation — nothing to compare against)');
  }
}

// Always 0. These are measurements, and a measurement that can fail a
// workflow step is a gate — see harness/plugins/evaluators/README.md, rule 1.
process.exit(0);
