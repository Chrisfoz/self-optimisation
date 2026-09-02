#!/usr/bin/env node

/**
 * Print a release-check-shaped JSON for models named by hand — campaign
 * mode. See harness/lib/campaign.mjs. The generated workflow writes this to
 * $RUNNER_TEMP/release-check.json in place of check-model-releases.mjs's
 * output when the "models" dispatch input is given.
 *
 * Usage: node harness/scripts/campaign-models.mjs "gpt-5,claude-opus-5"
 *
 * Exits 1 when any id cannot be resolved to a registered lab — a campaign
 * on a misspelt model should fail here, loudly, not five minutes in.
 */

import '../providers/index.mjs';
import { buildCampaignCheck } from '../lib/campaign.mjs';

const raw = process.argv.slice(2).join(',') || process.env.CAMPAIGN_MODELS || '';
const check = buildCampaignCheck(raw);
if (check.unresolved.length) {
  console.error(`Cannot resolve a lab for: ${check.unresolved.join(', ')}. Use full model ids from a registered provider.`);
  process.exit(1);
}
if (!check.selectedModels.length) {
  console.error('No model ids given.');
  process.exit(1);
}
console.error(`Campaign generation on: ${check.selectedModels.map((m) => `${m.id} (${m.provider})`).join(', ')}`);
console.log(JSON.stringify(check, null, 2));
