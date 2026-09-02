#!/usr/bin/env node

/**
 * Write down what this run actually observed, so the NEXT generation can
 * read it.
 *
 * See docs/curiosity/C10-runtime-evidence.md. The gap this closes: every
 * signal in the suggestion prompt described what the project *is*, and
 * nothing described what it *did*. The improvement signal was "review
 * approved, tests green" — a judgement about code, made by reading code —
 * and the reference implementation's own history has the counter-example: a
 * defect 239 green checks never noticed, found on the first run of something
 * that actually looked at the running product.
 *
 * Run from a target project's root, after the tests and the deploy check:
 *
 *   node harness/scripts/record-runtime-evidence.mjs \
 *     --tap "$RUNNER_TEMP/tests.tap" \
 *     --fragment "$RUNNER_TEMP/deploy-evidence.json"
 *
 * Arguments (all repeatable, all optional):
 *   --tap <file>        a TAP 13 stream (what `node --test` emits) to read
 *                       suite counts and, more importantly, SKIPPED TEST
 *                       NAMES out of.
 *   --tap-name <name>   what to call the --tap file beside it. Either order:
 *                       `--tap f --tap-name x` and `--tap-name x --tap f`
 *                       name the same suite.
 *   --fragment <file>   a JSON fragment in the evidence shape. This is how
 *                       every non-TAP ecosystem, and every project-specific
 *                       probe, contributes: write a small file, pass it in.
 *   --timing <step>=<ms>  a wall-clock observation.
 *
 * Environment:
 *   GEN_NUMBER   which generation this evidence belongs to. Defaults to the
 *                newest generation on record.
 *
 * Exit code is always 0 when it has anything to say and when it has nothing.
 * This is a helper: a run with no evidence is exactly today's run, and a
 * step that fails a workflow because it could not find a log file would be
 * the tail wagging the dog.
 */

import fs from 'fs';
import path from 'path';
import { setOutput } from '../lib/gh-output.mjs';
import { loadAdapter, contextConfig } from '../lib/adapter.mjs';
import { generationNumbers, DEFAULT_EVIDENCE_DIR } from '../lib/context-pack.mjs';
import { parseTap, buildEvidenceRecord, isEmptyEvidence } from '../lib/runtime-evidence.mjs';

function parseArgs(argv) {
  const out = { taps: [], fragments: [], timing: [], adapter: null };
  let pendingName = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--adapter') out.adapter = argv[++i];
    else if (argv[i] === '--tap-name') {
      const name = argv[++i];
      // Either order. `--tap-name x --tap f` and `--tap f --tap-name x` both
      // name the same suite: a flag that silently applies to the wrong one
      // depending on argument order is the kind of thing nobody notices
      // until a record says "tests" where it should have said "e2e".
      const last = out.taps[out.taps.length - 1];
      if (last && !last.name) last.name = name;
      else pendingName = name;
    } else if (argv[i] === '--tap') {
      out.taps.push({ file: argv[++i], name: pendingName });
      pendingName = null;
    } else if (argv[i] === '--fragment') out.fragments.push(argv[++i]);
    else if (argv[i] === '--timing') out.timing.push(argv[++i]);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = process.cwd();

const adapterPath = args.adapter || process.env.PROJECT_ADAPTER_PATH || path.join(repoRoot, 'project-adapter.yml');
const adapter = await loadAdapter(adapterPath);
const ctx = contextConfig(adapter);
const evidenceDir = ctx.runtimeEvidenceDir || DEFAULT_EVIDENCE_DIR;
const generationsDir = ctx.generationsDir || 'docs/generations';

const onRecord = generationNumbers({ repoRoot, generationsDir });
const genNumber = process.env.GEN_NUMBER || onRecord[onRecord.length - 1] || '';

if (!genNumber) {
  console.error('No generation to record evidence against — no GEN_NUMBER and no generation records on disk.');
  setOutput('ran', 'false');
  process.exit(0);
}

const fragments = [];

for (const { file, name } of args.taps) {
  try {
    const suite = parseTap(fs.readFileSync(file, 'utf8'), name || path.basename(file, path.extname(file)));
    fragments.push({ tests: { suites: [suite] } });
    if (suite.skipped.length) {
      console.error(`   ⚠️  ${suite.name}: ${suite.skipped.length} skipped test(s) — recorded by name.`);
    }
  } catch (err) {
    // A missing log is a gap in the evidence, not a failure of the run.
    console.error(`   (no TAP at ${file}: ${err.message})`);
  }
}

for (const file of args.fragments) {
  try {
    fragments.push(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    console.error(`   (no usable fragment at ${file}: ${err.message})`);
  }
}

const slowest = args.timing
  .map((pair) => {
    const at = pair.lastIndexOf('=');
    return at === -1 ? null : { step: pair.slice(0, at), ms: Number(pair.slice(at + 1)) };
  })
  .filter((s) => s && Number.isFinite(s.ms));
if (slowest.length) fragments.push({ timing: { slowest } });

const record = buildEvidenceRecord({ generation: genNumber, fragments });

if (isEmptyEvidence(record)) {
  // An empty file would be worse than no file: buildRuntimeEvidence() would
  // count it as a run it had evidence for and render nothing about it.
  console.error('Nothing observed to record. Writing no file — an empty one would claim evidence that does not exist.');
  setOutput('ran', 'false');
  process.exit(0);
}

const relative = `${evidenceDir}/gen-${genNumber}.json`;
fs.mkdirSync(path.join(repoRoot, evidenceDir), { recursive: true });
fs.writeFileSync(path.join(repoRoot, relative), JSON.stringify(record, null, 2) + '\n', 'utf8');

console.error(`Wrote ${relative}:`);
for (const suite of record.tests?.suites ?? []) {
  console.error(`   ${suite.name}: ${suite.passed} passed, ${suite.failed} failed, ${suite.skipped.length} skipped`);
}
for (const check of record.deploy?.checks ?? []) console.error(`   deploy ${check.what}: ${check.observed}`);
for (const d of record.probe?.dimensions ?? []) console.error(`   ${d.name}: ${d.observed}`);

setOutput('ran', 'true');
setOutput('path', relative);
process.exit(0);
