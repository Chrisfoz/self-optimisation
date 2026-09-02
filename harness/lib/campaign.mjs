#!/usr/bin/env node

/**
 * Campaign mode — a generation on models named by hand, for accumulating
 * evidence on purpose.
 *
 * The product loop triggers on a model release, not the calendar
 * (learning/01-principles.md, 1). Evaluating the HARNESS needs a faster
 * clock: the curiosity go/no-go (docs/curiosity/C9, WORKPLAN 4.3) wants
 * twenty-odd generations, which at release cadence on one project is
 * years. A campaign generation is the ordinary loop — same gates, same
 * record — run on whichever models the owner names from the Actions tab,
 * and stamped `campaign: true` so release-driven history stays
 * distinguishable in the index and the report.
 *
 * This file builds the release-check-shaped object the rest of the
 * workflow already consumes, so probe, preflight and improve run unchanged.
 */

import { resolveProvider } from './llm-provider.mjs';

/**
 * @param {string|string[]} raw  Comma-separated model ids, or a list.
 * @returns {{hasNewReleases: boolean, releaseDetected: boolean, campaign: true, selectedModels: Array<{id: string, provider: string, contextWindow: null}>, selectedModel: string, selectedProvider: string, results: {}, unresolved: string[]}}
 */
export function buildCampaignCheck(raw) {
  const ids = (Array.isArray(raw) ? raw : String(raw ?? '').split(','))
    .map((s) => String(s).trim())
    .filter(Boolean);
  const selectedModels = [];
  const unresolved = [];
  for (const id of ids) {
    try {
      selectedModels.push({ id, provider: resolveProvider(id), contextWindow: null });
    } catch {
      unresolved.push(id);
    }
  }
  return {
    hasNewReleases: selectedModels.length > 0,
    releaseDetected: selectedModels.length > 0,
    campaign: true,
    selectedModels,
    selectedModel: selectedModels[0]?.id ?? '',
    selectedProvider: selectedModels[0]?.provider ?? '',
    results: {},
    unresolved,
  };
}
