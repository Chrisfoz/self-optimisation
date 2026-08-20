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
 * Requires notify.recipient / notify.from in project-adapter.yml. The
 * sender is resolved from notify.provider (default "sendgrid") via
 * notify.mjs's registerSender()/getSender() — see that file's own doc
 * comment for how to register a different one. Its API key is read from
 * `${PROVIDER_NAME_UPPERCASE}_API_KEY` (e.g. SENDGRID_API_KEY for the
 * built-in sender).
 */

import fs from 'fs';
import path from 'path';
import { loadAdapter, notifyConfig, contextConfig } from '../lib/adapter.mjs';
import { callModelWithHeadroom } from '../lib/llm-provider.mjs';
import { buildGenerationDigestEmail, getSender } from '../lib/notify.mjs';

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

const genNumber = process.env.GEN_NUMBER;
if (!genNumber) {
  console.error('GEN_NUMBER is required.');
  process.exit(1);
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
