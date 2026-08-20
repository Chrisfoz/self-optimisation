#!/usr/bin/env node

/**
 * Model-release detector — the kernel component that decides whether a
 * campaign runs at all. Ported from carrotgame's scripts/check-model-releases.mjs
 * (the reference implementation). Genericised in the same way as the
 * provider router: this file used to hardcode nine labs' catalogue
 * endpoints directly; it now hardcodes none. Every lab's catalogue-listing
 * config (`listModels`) lives alongside its call-time config in
 * harness/providers/*.mjs — see getProvider() in llm-provider.mjs for why.
 *
 * This module is pure: no filesystem, no process.env reads beyond what a
 * caller explicitly passes in, no console output. A CLI wrapper
 * (harness/scripts/check-model-releases.mjs) owns the snapshot file, the
 * environment, and the stdout/stderr contract — this module just answers
 * "given this snapshot and these registered providers, what's new".
 *
 * Core principle, unchanged from the reference implementation: **nothing
 * runs unless a model id appears that the snapshot has never seen.** A
 * failed catalogue check reports `unknown`, never "no release" — silently
 * treating an outage as "nothing shipped" would mean a real release during
 * a bad week never triggers anything, and nobody would know why.
 */

import https from 'https';
import { getProvider } from './llm-provider.mjs';

// ---------------------------------------------------------------------------
// Chat-model filtering
// ---------------------------------------------------------------------------

/**
 * Default keyword filters for excluding non-chat models from a catalogue
 * listing: embeddings, speech, image and moderation endpoints all commonly
 * appear in the same /models listing as chat models. Without a filter like
 * this, a detector will happily select "text-embedding-3-large" as its next
 * suggestion-stage model.
 *
 * These are deliberately generic naming conventions across labs, not tied
 * to any one provider, and are the reference implementation's defaults —
 * override via `isChatModelOptions` on checkReleases() if a project's
 * observed catalogues need different exclusions.
 */
export const DEFAULT_NON_CHAT_SUBSTRINGS = [
  'embed', 'whisper', 'dall-e', 'moderation', 'realtime', 'transcribe',
  'similarity', 'davinci', 'babbage', 'curie', 'instruct', 'imagen', 'speech',
];

/**
 * Short tokens that would cause false negatives as bare substrings ('ada'
 * inside "kimi-k3-adaptive", 'edit' inside "credit"). Matched only as a
 * whole dash/dot/underscore-delimited segment. Biased toward letting a
 * model through on doubt: rejecting a real frontier model here silently
 * skips a whole cycle, whereas a real call fails loudly if it turns out not
 * to be a chat model after all.
 */
export const DEFAULT_NON_CHAT_SEGMENTS = [
  'tts', 'ada', 'edit', 'guard', 'aqa', 'veo', 'image', 'images',
  'audio', 'search', 'vision', 'ocr', 'rerank',
];

/** Does this model id look like a chat-capable model, by name? */
export function isChatModel(id, { nonChatSubstrings = DEFAULT_NON_CHAT_SUBSTRINGS, nonChatSegments = DEFAULT_NON_CHAT_SEGMENTS } = {}) {
  const lower = id.toLowerCase();
  if (nonChatSubstrings.some((token) => lower.includes(token))) return false;
  const segments = new Set(lower.split(/[-_.]/));
  return !nonChatSegments.some((token) => segments.has(token));
}

// ---------------------------------------------------------------------------
// Catalogue fetching
// ---------------------------------------------------------------------------

function getJson({ hostname, path, headers }) {
  return new Promise((resolve) => {
    https
      .get({ hostname, path, headers }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              const detail = (() => {
                try {
                  return JSON.parse(data).error?.message ?? data.slice(0, 160);
                } catch {
                  return data.slice(0, 160);
                }
              })();
              resolve({ status: 'error', models: [], reason: `HTTP ${res.statusCode}: ${detail}` });
              return;
            }
            resolve({ status: 'success', data: JSON.parse(data) });
          } catch (e) {
            resolve({ status: 'error', models: [], reason: `parse failed: ${e.message}` });
          }
        });
      })
      .on('error', (e) => resolve({ status: 'error', models: [], reason: `network: ${e.message}` }));
  });
}

/**
 * Fetch and parse one provider's model catalogue, using its registered
 * `listModels` config. Applies the generic chat-model name filter after the
 * provider's own parseModels — that split matters: a provider's parseModels
 * may apply a provider-specific capability filter (e.g. Google's
 * `generateContent` support check), which is about that catalogue's own
 * semantics and stays with the provider; the generic keyword filter is
 * applied uniformly here so it can't be forgotten by a new provider file.
 */
async function fetchModels(providerName, key, isChatModelOptions) {
  const provider = getProvider(providerName);
  if (!provider) {
    return { status: 'error', models: [], reason: `provider "${providerName}" is not registered` };
  }
  if (!provider.listModels) {
    return { status: 'error', models: [], reason: `provider "${providerName}" has no listModels config — it cannot be catalogue-checked` };
  }

  const result = await getJson({
    hostname: provider.hostname,
    path: provider.listModels.path(key),
    headers: provider.headers(key),
  });
  if (result.status === 'error') return result;

  let models;
  try {
    models = provider.listModels.parseModels(result.data);
  } catch (e) {
    return { status: 'error', models: [], reason: `parseModels failed: ${e.message}` };
  }

  return { status: 'success', models: models.filter((m) => isChatModel(m.id, isChatModelOptions)) };
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Rank newly released models, newest first. Providers with no creation
 * timestamp (their `created` ties at 0) fall through to a descending id
 * sort — arbitrary rather than chronological, which matters less now that a
 * run takes every new model rather than only the top one.
 */
export function rankCandidates(candidates) {
  return [...candidates].sort((a, b) => b.created - a.created || b.id.localeCompare(a.id));
}

// ---------------------------------------------------------------------------
// Core detection
// ---------------------------------------------------------------------------

/**
 * Compare each watched provider's current catalogue against a snapshot of
 * what was seen last time, and decide which newly-appeared models (if any)
 * the suggestion stage should run on.
 *
 * Pure with respect to the outside world: takes the previous snapshot and
 * the set of provider names to check as arguments, returns the new snapshot
 * as a value rather than writing it anywhere. The caller (a CLI wrapper)
 * owns persistence.
 *
 * @param {object} opts
 * @param {string[]} opts.providers  Names of registered providers to check
 *   (e.g. from a project's `providers.watched` adapter config). A provider
 *   without a corresponding env var is reported `skipped`, not silently
 *   dropped from the results — a lab whose models could trigger a run but
 *   whose key is missing should be visible, not invisible.
 * @param {object} [opts.snapshot]  Previous state: `{ [providerName]: string[] }`
 *   — the model ids seen last run. Pass `{}` (or omit) on the very first run.
 * @param {number} [opts.maxFanout]  Ceiling on how many newly-released
 *   models one run may fan out to — not a cost control (one call per model
 *   is cheap), a blast-radius limit for the pathological case where a
 *   catalogue rename or a revived dead key makes many ids look new on the
 *   same run. Default 8.
 * @param {object} [opts.isChatModelOptions]  Passed through to isChatModel().
 * @param {(msg: string) => void} [opts.log]  Progress lines; defaults to no-op.
 * @returns {Promise<{
 *   hasNewReleases: boolean,
 *   selectedModels: Array<{id: string, provider: string, contextWindow: number|null}>,
 *   selectedModel: string,
 *   selectedProvider: string,
 *   newSnapshot: object,
 *   results: object,
 * }>}
 */
export async function checkReleases({
  providers,
  snapshot = {},
  maxFanout = 8,
  isChatModelOptions,
  log = () => {},
}) {
  const results = {};
  const candidates = [];
  let anyNewReleases = false;

  for (const providerName of providers) {
    const provider = getProvider(providerName);
    const keyName = provider?.envKey ?? `${providerName.toUpperCase()}_API_KEY`;
    const key = process.env[keyName];

    if (!key) {
      results[providerName] = { status: 'skipped', reason: `no ${keyName}`, models: [], newModels: [] };
      log(`- ${providerName}: skipped (no ${keyName})`);
      continue;
    }

    const { status, models = [], reason } = await fetchModels(providerName, key, isChatModelOptions);
    const previousModels = snapshot[providerName] || [];

    // "New" only means anything relative to a known baseline. The first
    // time a provider is reached successfully, record what exists and
    // trigger nothing — otherwise fixing a broken API key would make that
    // lab's entire back catalogue look like a same-day release.
    const isBaseline = status === 'success' && !Object.prototype.hasOwnProperty.call(snapshot, providerName);
    const newModels = isBaseline ? [] : models.filter((m) => !previousModels.includes(m.id));

    results[providerName] = {
      status: status === 'error' ? 'unknown' : 'success',
      models: models.map((m) => m.id).sort(),
      newModels: newModels.map((m) => m.id).sort(),
      totalCount: models.length,
      ...(isBaseline ? { baseline: true } : {}),
      ...(reason ? { reason } : {}),
    };

    if (isBaseline) {
      log(`📋 ${providerName}: baseline recorded (${models.length} models). Nothing triggered — future additions will count as new.`);
    } else if (newModels.length > 0) {
      anyNewReleases = true;
      candidates.push(...newModels.map((m) => ({ ...m, provider: providerName })));
      log(`🆕 ${providerName.toUpperCase()}: ${newModels.map((m) => m.id).join(', ')}`);
    } else if (status === 'success') {
      log(`✓ ${providerName}: no new models`);
    } else {
      log(`⚠️  ${providerName}: check failed — ${reason || 'unknown state'}`);
    }
  }

  const ranked = rankCandidates(candidates);
  const selected = ranked.slice(0, maxFanout);
  const heldBack = ranked.slice(maxFanout);

  if (heldBack.length) {
    log(
      `\n⚠️  ${ranked.length} new models exceeds maxFanout=${maxFanout}. ` +
      `Skipping and marking as seen: ${heldBack.map((m) => m.id).join(', ')}`
    );
  }

  // New snapshot: successful checks overwrite, failed ones keep whatever was
  // there before, so a transient outage can't make every model look new
  // next run.
  const newSnapshot = {};
  for (const [provider, result] of Object.entries(results)) {
    if (result.status === 'success') {
      newSnapshot[provider] = result.models;
    } else if (snapshot[provider]) {
      newSnapshot[provider] = snapshot[provider];
    }
  }

  if (selected.length === 1) {
    log(`\n🎯 Suggestion stage will run on: ${selected[0].id} (${selected[0].provider})`);
  } else if (selected.length > 1) {
    log(`\n🎯 Suggestion stage fans out to ${selected.length} models:\n` + selected.map((m) => `     - ${m.id} (${m.provider})`).join('\n'));
  } else {
    log('\nNo new models — the improvement cycle will be skipped.');
  }

  return {
    hasNewReleases: anyNewReleases,
    selectedModels: selected.map((m) => ({ id: m.id, provider: m.provider, contextWindow: m.contextWindow ?? null })),
    selectedModel: selected[0]?.id ?? '',
    selectedProvider: selected[0]?.provider ?? '',
    newSnapshot,
    results,
  };
}
