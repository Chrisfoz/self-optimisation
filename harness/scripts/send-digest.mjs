#!/usr/bin/env node

/**
 * CLI entry point for harness/lib/notify.mjs's buildGenerationDigestEmail().
 * Sends a plain-language "what happened this generation" email, with a
 * reliable terse fallback if the plain-language call fails for any reason.
 *
 * Usage: node harness/scripts/send-digest.mjs [--adapter <path>]
 *
 * Required environment:
 *   GEN_NUMBER   e.g. "001"
 *   GATES        JSON array of this run's real CI results:
 *                `[{"name":"review","result":"success","note":"..."},...]`
 *                `note` is optional — a project-specific explanation of what
 *                that gate actually checks, shown as the reason merge was
 *                blocked when this is the first non-success gate. Left
 *                deliberately generic rather than named env vars per gate
 *                (R_IMPROVE/R_GUARD/...), since which gates exist is a
 *                per-project workflow decision, not a harness one.
 *   MERGED       "true" or "false"
 *
 * Optional environment (all default to sensible "not available" values):
 *   SCOPE, SUGGEST_MODEL, SUGGEST_PROVIDER, IMPLEMENT_MODEL,
 *   SELF_IMPLEMENTED, SUMMARY, BRIEF_FEEDBACK, ESC_OPENED, ESC_FLAGGED
 *
 * When GEN_NUMBER is ABSENT no generation ran, and this still sends an email
 * saying which of the four no-generation outcomes occurred. Read in this
 * order, first match wins:
 *   CHECK_RESULT      != "success"  -> the release check never completed
 *   PREFLIGHT_RESULT  != "success"  -> the project's own checks failed first
 *   RELEASE_DETECTED  == "true"     -> something shipped, nothing was reachable
 *   otherwise                        -> a genuinely quiet cycle
 * With RUN_URL, LABS_WATCHED (comma-separated) and NO_GENERATION_DETAIL as
 * optional context. Passing none of them yields the quiet-cycle email, which
 * is the correct default only when the cycle really was quiet — a workflow
 * that cannot distinguish these should pass CHECK_RESULT rather than let a
 * failure report as calm.
 *
 * Requires notify.recipient / notify.from in project-adapter.yml. The
 * sender is resolved from notify.provider (default "sendgrid") via
 * notify.mjs's registerSender()/getSender() — see that file's own doc
 * comment for how to register a different one. Its API key is read from
 * `${PROVIDER_NAME_UPPERCASE}_API_KEY` (e.g. SENDGRID_API_KEY for the
 * built-in sender).
 */

import fs from 'fs';
import path from 'path';
import { loadAdapter, notifyConfig, contextConfig, memoryConfig } from '../lib/adapter.mjs';
import { callModelWithHeadroom } from '../lib/llm-provider.mjs';
import { buildGenerationDigestEmail, buildNoGenerationEmail, NO_GENERATION_REASONS, getSender } from '../lib/notify.mjs';
import { loadLedger, minorityReport, renderMinorityReport } from '../lib/escalations.mjs';

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
const notify = notifyConfig(adapter);
const ctx = contextConfig(adapter);

const providerName = notify.provider || 'sendgrid';
const sender = getSender(providerName);
if (!sender) {
  console.error(`notify.provider "${providerName}" has no sender registered. Built in: sendgrid. See harness/lib/notify.mjs's registerSender() to add your own.`);
  process.exit(1);
}
if (!notify.recipient || !notify.from) {
  console.error('notify.recipient and notify.from must both be set in project-adapter.yml.');
  process.exit(1);
}
const apiKeyEnvVar = `${providerName.toUpperCase()}_API_KEY`;
const apiKey = process.env[apiKeyEnvVar];
if (!apiKey) {
  console.error(`${apiKeyEnvVar} is not set.`);
  process.exit(1);
}

// A cycle with no generation still sends an email, and WHICH email depends on
// why there was no generation. Requiring GEN_NUMBER here used to make that
// impossible: the four outcomes below all arrive with no generation number,
// and the script exited before it could say anything about any of them.
//
// That is not a cosmetic gap. The one case most needing a human — a lab
// shipped something and nothing could reach it — is inside this branch, and
// so is a crashed release check, which is indistinguishable from a quiet
// cycle unless something says otherwise. See notify.mjs's
// NO_GENERATION_REASONS for the three times these were collapsed.
const genNumber = process.env.GEN_NUMBER;

if (!genNumber) {
  const reason =
    process.env.CHECK_RESULT && process.env.CHECK_RESULT !== 'success'
      ? NO_GENERATION_REASONS.CHECK_FAILED
      : process.env.PREFLIGHT_RESULT && process.env.PREFLIGHT_RESULT !== 'success'
        ? NO_GENERATION_REASONS.PREFLIGHT_FAILED
        : process.env.RELEASE_DETECTED === 'true'
          ? NO_GENERATION_REASONS.ALL_UNREACHABLE
          : NO_GENERATION_REASONS.QUIET;

  const email = buildNoGenerationEmail({
    reason,
    runUrl: process.env.RUN_URL,
    labs: (process.env.LABS_WATCHED || '').split(',').map((s) => s.trim()).filter(Boolean),
    detail: process.env.NO_GENERATION_DETAIL || '',
    projectName: adapter?.project?.description || adapter?.project?.id || 'This project',
  });

  try {
    await sender(email, { apiKey, from: notify.from, to: notify.recipient });
    console.error(`Email sent (${reason}): "${email.subject}"`);
    process.exit(0);
  } catch (err) {
    console.error(`Digest email failed entirely: ${err.message}`);
    process.exit(1);
  }
}

let gates;
try {
  gates = JSON.parse(process.env.GATES || '[]');
} catch {
  console.error('GATES is not valid JSON.');
  process.exit(1);
}

const generationsDir = ctx.generationsDir || 'docs/generations';
const read = (relative) => {
  try {
    return fs.readFileSync(path.join(repoRoot, relative), 'utf8');
  } catch {
    return null;
  }
};

const calibrationExamples = notify.calibrationExamplesPaths.map(read).filter(Boolean);

// The minority report: open cases with a strong argument and no backing.
// Read straight from the ledger rather than passed through the workflow —
// it is a standing list, not a fact about this run, and the digest is the
// only place a human sees it at all.
const memory = memoryConfig(adapter);
const minority = renderMinorityReport(
  minorityReport(loadLedger({ repoRoot, ledgerPath: memory.ledgerPath || undefined }), {
    threshold: {
      models: memory.consensus.models ?? 3,
      labs: memory.consensus.labs ?? 2,
    },
  })
);

const email = await buildGenerationDigestEmail(
  {
    genLabel: `generation ${genNumber}`,
    scope: process.env.SCOPE || 'focused',
    merged: process.env.MERGED === 'true',
    suggestModel: process.env.SUGGEST_MODEL,
    suggestProvider: process.env.SUGGEST_PROVIDER,
    implementModel: process.env.IMPLEMENT_MODEL,
    selfImplemented: process.env.SELF_IMPLEMENTED === 'true',
    summary: process.env.SUMMARY,
    gates,
    briefFeedback: process.env.BRIEF_FEEDBACK,
    escalationsOpened: Number(process.env.ESC_OPENED || 0),
    escalationsFlagged: Number(process.env.ESC_FLAGGED || 0),
    minorityReport: minority,
    attemptsJson: read(`${generationsDir}/gen-${genNumber}/attempts.json`),
    proposalMd: read(`${generationsDir}/gen-${genNumber}/proposal.md`),
    recipientName: notify.recipientName || notify.recipient,
    projectDescription: adapter?.project?.description || adapter?.project?.id || 'this project',
    calibrationExamples,
    digestModel: notify.digestModel || 'claude-opus-5',
  },
  { call: callModelWithHeadroom, log: (msg) => console.error(msg) }
);

try {
  await sender(email, { apiKey, from: notify.from, to: notify.recipient });
  console.error(`Email sent: "${email.subject}"`);
} catch (err) {
  console.error(`Digest email failed entirely: ${err.message}`);
  process.exit(1);
}
