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

import { resolveProvider, isProviderRegistered } from './llm-provider.mjs';

/**
 * An entry may name its lab explicitly as `lab:model-id`.
 *
 * Without this, a campaign can only run models whose id names their own lab,
 * because `resolveProvider()` has nothing else to go on. That rules out
 * exactly the models a reseller serves under someone else's bare id — real
 * and current: DashScope (`qwen`) serves `deepseek-v4.1-flash`, which
 * deepseek.com does not, while the `/^deepseek/i` pattern sends it to
 * deepseek.com. The run then spends a reachability probe finding that out.
 *
 * `roles.<seat>.provider` already solves this for the three pinned seats, and
 * `resolveProvider()`'s own error message tells the reader to "name its lab
 * explicitly" — but a campaign model is named per run, from the Actions tab,
 * and never passes through the adapter at all. This is that same escape
 * hatch, in the one place it was missing.
 *
 * A colon, not the `vendor/model` slash: `harness/lib/model-aliases.mjs`
 * gives a slash a different meaning already (a reseller's namespaced id,
 * which is part of the id), and one separator cannot mean both.
 */
function splitNamedLab(entry) {
  const at = entry.indexOf(':');
  if (at < 1) return { id: entry, named: null };
  return { id: entry.slice(at + 1).trim(), named: entry.slice(0, at).trim() };
}

/**
 * @param {string|string[]} raw  Comma-separated model ids, or a list. Each may
 *   be `model-id`, or `lab:model-id` to name the lab that serves it.
 * @returns {{hasNewReleases: boolean, releaseDetected: boolean, campaign: true, selectedModels: Array<{id: string, provider: string, contextWindow: null}>, selectedModel: string, selectedProvider: string, results: {}, unresolved: string[]}}
 */
export function buildCampaignCheck(raw) {
  const ids = (Array.isArray(raw) ? raw : String(raw ?? '').split(','))
    .map((s) => String(s).trim())
    .filter(Boolean);
  const selectedModels = [];
  const unresolved = [];
  for (const entry of ids) {
    const { id, named } = splitNamedLab(entry);
    // An unregistered lab, or a bare `lab:` with nothing after it, is
    // unresolved — reported by name and exited on, the same as a misspelt
    // model. Falling back to the pattern table here would send the run to
    // the endpoint the caller just said was the wrong one.
    if (named !== null) {
      if (id && isProviderRegistered(named)) {
        selectedModels.push({ id, provider: named, contextWindow: null });
      } else {
        unresolved.push(entry);
      }
      continue;
    }
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
