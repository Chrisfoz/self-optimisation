#!/usr/bin/env node

/**
 * The write side of the themes review: read the generation history, ask one
 * model what pattern explains it, write the answer as
 * `<themesDir>/review-NNN.json`.
 *
 * `harness/lib/themes.mjs` has read this file into every suggestion prompt
 * since the harness was ported, and `harness/lib/generate-themes.mjs` has
 * held the prompt and the parser, fully unit-tested. Nothing called a model
 * with them, because the input a themes review needs is real generation
 * records, and those only exist once `run-generation.mjs` has produced some.
 * They do now, which is why this file exists at last.
 *
 * Same split as every other script here: everything decidable from plain
 * data — whether a review is due, what the prompts say, how a response
 * parses, what the output object looks like — lives in
 * `harness/lib/generate-themes.mjs` and is tested without a network call.
 * This file owns the parts that need the world: the adapter, the
 * filesystem, the API call, GITHUB_OUTPUT, and the exit code.
 *
 * Run from a target project's root, after a generation completes:
 *
 *   node harness/scripts/generate-themes-review.mjs
 *
 * Environment:
 *   GEN_NUMBER     the generation just completed — decides whether a review
 *                  is due. Defaults to the newest generation on record.
 *   THEMES_MODEL   optional; defaults to roles.review.model, then
 *                  claude-opus-5. The review seat is the natural default:
 *                  it is the pinned, project-chosen model whose job is
 *                  already to read work rather than produce it.
 *   FORCE_REVIEW   "true" to review regardless of the cadence boundary —
 *                  for a first review, or a backfill. It does NOT override
 *                  the "a review already covers this generation" check;
 *                  delete the file if you really mean to redo one.
 *
 * Outputs (GITHUB_OUTPUT): `ran`, and on a review: `path`, `themes`,
 * `through-generation`, `model`.
 *
 * Exit codes: 0 whether or not a review was due — "not due" is the normal
 * outcome and must not fail a workflow. Non-zero only when a review WAS due
 * and could not be produced (the model call failed, or the response did not
 * parse). Nothing is written in that case: a themes review is permanent
 * standing context for every future generation, so a bad one is worse than
 * none, and the next cadence boundary will pick it up.
 */

import fs from 'fs';
import path from 'path';
import '../providers/index.mjs';
import { setOutput } from '../lib/gh-output.mjs';
import { loadAdapter, memoryConfig, contextConfig, rolesConfig } from '../lib/adapter.mjs';
import { buildGenerationHistory, generationNumbers } from '../lib/context-pack.mjs';
import { reviewedGenerations, DEFAULT_THEMES_DIR } from '../lib/themes.mjs';
import {
  isThemesReviewDue, buildThemesSystemPrompt, buildThemesUserPrompt,
  parseThemesResponse, buildThemesReview, themesReviewFilename, padGeneration,
} from '../lib/generate-themes.mjs';
import { callModelWithHeadroom, resolveProvider } from '../lib/llm-provider.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--adapter') out.adapter = argv[++i];
    else if (argv[i] === '--force') out.force = true;
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

const memory = memoryConfig(adapter);
const ctxConfig = contextConfig(adapter);
const roles = rolesConfig(adapter);

const themesDir = memory.themesDir || DEFAULT_THEMES_DIR;
const generationsDir = ctxConfig.generationsDir || 'docs/generations';
const cadence = memory.themesCadence ?? 10;

const onRecord = generationNumbers({ repoRoot, generationsDir });
const genNumber = process.env.GEN_NUMBER || onRecord[onRecord.length - 1] || '';
const force = args.force || process.env.FORCE_REVIEW === 'true';

// --- is a review due? ---------------------------------------------------
const decision = isThemesReviewDue({
  genNumber,
  cadence,
  force,
  reviewed: reviewedGenerations({ repoRoot, themesDir }),
});

if (!decision.due) {
  // Exit 0. This script runs after every generation and stays quiet nine
  // times out of ten; a non-zero exit for the ordinary case would train
  // everyone to ignore the one that matters.
  console.error(`No themes review this run. ${decision.reason}`);
  setOutput('ran', 'false');
  process.exit(0);
}
console.error(decision.reason);

// --- assemble the window ------------------------------------------------
// The same builder the suggestion stage uses, deliberately: a second
// history formatter would drift from the first, and the whole point of a
// themes review is that it reads what the models read.
const historyText = buildGenerationHistory({ repoRoot, generationsDir, limit: cadence });
const windowSize = Math.min(cadence, onRecord.length);

if (windowSize === 0) {
  console.error('No generation records on disk yet — there is nothing to find a pattern in.');
  setOutput('ran', 'false');
  process.exit(0);
}

const model = process.env.THEMES_MODEL || roles.reviewModel || 'claude-opus-5';
let provider = null;
try {
  provider = resolveProvider(model);
} catch {
  // Not fatal here: callModelWithHeadroom() will resolve it too and fail
  // with a better message if it genuinely can't. This is only so the
  // written review can record which lab produced it.
}

const throughGeneration = padGeneration(genNumber);
const projectDescription = adapter.project?.description || adapter.project?.id || 'this project';

console.error(`🔎 Reviewing ${windowSize} generation(s) through ${throughGeneration} with ${model}...`);

// --- ask ----------------------------------------------------------------
let response;
try {
  response = await callModelWithHeadroom({
    model,
    provider,
    system: buildThemesSystemPrompt(projectDescription, windowSize),
    user: buildThemesUserPrompt(historyText, throughGeneration),
    maxTokens: 8000,
  });
} catch (err) {
  console.error(`\n❌ The themes review call failed: ${err.message}`);
  console.error('   Nothing was written. The next cadence boundary will try again.');
  setOutput('ran', 'false');
  process.exit(1);
}

// --- parse, fail closed -------------------------------------------------
let parsed;
try {
  parsed = parseThemesResponse(response.text);
} catch (err) {
  console.error(`\n❌ ${model} did not return a usable themes review: ${err.message}`);
  console.error('   Nothing was written — a themes review becomes permanent standing context');
  console.error('   for every future generation, so a bad one is worse than none.');
  setOutput('ran', 'false');
  process.exit(1);
}

// --- write --------------------------------------------------------------
const review = buildThemesReview({
  throughGeneration,
  windowSize,
  model: response.model || model,
  provider: response.provider || provider,
  themes: parsed.themes,
});

const relative = path.join(themesDir, themesReviewFilename(throughGeneration));
fs.mkdirSync(path.join(repoRoot, themesDir), { recursive: true });
fs.writeFileSync(path.join(repoRoot, relative), JSON.stringify(review, null, 2) + '\n', 'utf8');

console.error(`\n✅ Wrote ${relative} — ${review.themes.length} theme(s):`);
for (const [i, theme] of review.themes.entries()) {
  console.error(`   ${i + 1}. ${theme.means}`);
}
console.error('\nEvery future suggestion prompt reads this until the next review replaces it.');

setOutput('ran', 'true');
setOutput('path', relative);
setOutput('themes', String(review.themes.length));
setOutput('through-generation', review.throughGeneration);
setOutput('model', review.model);
process.exit(0);
