#!/usr/bin/env node

/**
 * CLI entry point for harness/lib/notify.mjs's buildEscalationNoticeEmail().
 * Sends the separate "a decision is needed" email once one or more
 * escalations have reached consensus, with a reliable terse fallback if
 * the plain-language call fails for any reason. A no-op (exit 0, nothing
 * sent) when nothing was flagged this run — that is the common case for
 * almost every generation.
 *
 * Usage: node harness/scripts/send-escalation-notice.mjs [--adapter <path>]
 *
 * Required environment:
 *   GEN_NUMBER   e.g. "001"
 *   FLAGGED      JSON array of this run's newly-flagged escalations, the
 *                exact shape harness/scripts/run-generation.mjs's
 *                `escalations-flagged-json` output already produces:
 *                `[{"id":"esc-001","title":"...","target":"...","notification":"..."}]`
 *                — `notification` is escalations.mjs's renderForNotification()
 *                output, i.e. already rendered plain text, not something
 *                this script re-derives.
 *
 * Skipped entirely (exit 0) if notify.escalation_notice is false in
 * project-adapter.yml, or if FLAGGED is an empty array.
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
// Registers every lab, for the same reason as send-digest.mjs: without it the
// model call cannot resolve a provider and the notice always falls back.
import '../providers/index.mjs';
import { loadAdapter, notifyConfig } from '../lib/adapter.mjs';
import { callModelWithHeadroom } from '../lib/llm-provider.mjs';
import { buildEscalationNoticeEmail, getSender } from '../lib/notify.mjs';

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

if (!notify.escalationNotice) {
  console.error('notify.escalation_notice is false in project-adapter.yml — skipping.');
  process.exit(0);
}

let flagged;
try {
  flagged = JSON.parse(process.env.FLAGGED || '[]');
} catch {
  console.error('FLAGGED is not valid JSON.');
  process.exit(1);
}
if (!Array.isArray(flagged) || flagged.length === 0) {
  console.error('Nothing was flagged this run — no escalation notice to send.');
  process.exit(0);
}

const genNumber = process.env.GEN_NUMBER;
if (!genNumber) {
  console.error('GEN_NUMBER is required.');
  process.exit(1);
}

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

const read = (relative) => {
  try {
    return fs.readFileSync(path.join(repoRoot, relative), 'utf8');
  } catch {
    return null;
  }
};
const calibrationExamples = notify.calibrationExamplesPaths.map(read).filter(Boolean);

const email = await buildEscalationNoticeEmail(
  {
    genLabel: `generation ${genNumber}`,
    flagged,
    recipientName: notify.recipientName || notify.recipient,
    projectDescription: adapter?.project?.description || adapter?.project?.id || 'this project',
    calibrationExamples,
    digestModel: notify.digestModel || 'claude-opus-5',
  },
  { call: callModelWithHeadroom, log: (msg) => console.error(msg) }
);

// buildEscalationNoticeEmail() only returns null for an empty `flagged`,
// which the check above already ruled out — but a defensive check here
// costs nothing and keeps this script honest about its own contract.
if (!email) {
  console.error('No escalation email to send.');
  process.exit(0);
}

try {
  await sender(email, { apiKey, from: notify.from, to: notify.recipient });
  console.error(`Escalation notice sent: "${email.subject}"`);
} catch (err) {
  console.error(`Escalation notice failed entirely: ${err.message}`);
  process.exit(1);
}
