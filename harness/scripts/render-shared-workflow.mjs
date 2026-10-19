#!/usr/bin/env node

/**
 * Render the harness repository's shared workflow,
 * `.github/workflows/self-improve.yml`, from the same template every
 * copied-in installation's workflow comes from (see scaffold.mjs's
 * renderSharedWorkflow()). Projects call that file at a pinned commit
 * instead of carrying their own copy of the harness.
 *
 * Run in the self-optimisation repository itself. Paths are resolved from
 * this script's location, not the working directory, because the file being
 * written belongs to the repository this harness lives in.
 *
 * Usage:
 *   node harness/scripts/render-shared-workflow.mjs           write the file
 *   node harness/scripts/render-shared-workflow.mjs --check   exit 1 if it is out of date
 *
 * Never edit the rendered file by hand: a test fails when it and the
 * template disagree, the same way a copied-in workflow is regenerated with
 * `init --from-adapter` rather than patched.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../providers/index.mjs';
import { registeredProviders, getProvider } from '../lib/llm-provider.mjs';
import { renderSharedWorkflow, SHARED_WORKFLOW_PATH } from '../lib/scaffold.mjs';
import { shippedContextProviderEnv } from '../lib/context-providers.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const template = fs.readFileSync(path.join(repoRoot, 'harness/templates/workflow.yml.tmpl'), 'utf8');
const providers = registeredProviders().map((name) => ({ name, envKey: getProvider(name).envKey }));
const rendered = renderSharedWorkflow(template, { providers, contextProviderEnv: await shippedContextProviderEnv() });
const target = path.join(repoRoot, SHARED_WORKFLOW_PATH);

if (process.argv.includes('--check')) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : null;
  if (current !== rendered) {
    console.error(`${SHARED_WORKFLOW_PATH} is out of date with harness/templates/workflow.yml.tmpl. Run: node harness/scripts/render-shared-workflow.mjs`);
    process.exit(1);
  }
  console.log(`${SHARED_WORKFLOW_PATH} is up to date.`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, rendered);
console.log(`Wrote ${SHARED_WORKFLOW_PATH} (${providers.length} providers).`);
