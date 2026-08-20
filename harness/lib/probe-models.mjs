#!/usr/bin/env node

/**
 * Cheap reachability check for candidate models, run after selection and
 * before the expensive preflight/improve stages spend anything on a model
 * that turns out not to speak the endpoint this harness expects. Ported
 * from the reference implementation's scripts/lib/probe-models.mjs
 * essentially unchanged — this file was already fully generic (it only
 * imports resolveProvider() from llm-provider.mjs, now genericised too).
 *
 * The incident this exists to prevent: a real run was forced onto a
 * reasoning-tier model id that its lab served only through a different API
 * shape than every sibling model in the same family. It 404'd with "this is
 * not a chat model" — but only inside the real suggestion call, after a
 * full preflight test run had already spent its budget. A keyword filter on
 * the model id (see model-release-detector.mjs's isChatModel) catches whole
 * non-chat families by name; it has no way to know a differently-suffixed
 * sibling id needs a different endpoint. This does: it sends the exact
 * request shape the real call will use, and drops anything that doesn't
 * answer.
 *
 * This is a fast filter, not a guarantee: a model that returns a few tokens
 * for a trivial prompt can still fail later on the real structured prompt
 * (unsupported system role, context length, content policy, ...). It only
 * catches the class of failure described above — a model id that exists but
 * cannot answer at all through the shape this harness sends.
 */

import { resolveProvider } from './llm-provider.mjs';

export const PROBE_SYSTEM = 'Reply with exactly one word.';
export const PROBE_USER = 'Reply with the single word OK.';

// Headroom left for the model's actual response (analysis prose, optionally
// edit blocks) on top of the prompt itself. Deliberately a fixed number of
// tokens rather than a fraction of the window: a small context window needs
// this reserved just as much as a huge one does, since the response length
// this harness asks for does not scale with the model's window size.
const OUTPUT_RESERVE_TOKENS = 8000;

/**
 * Does this candidate's advertised context window fit the estimated prompt?
 *
 * Deliberately conservative in the direction of NOT dropping: most
 * providers' /models listings do not expose a context window at all (see
 * each provider's `listModels.parseModels` — currently only Google's
 * response carries one), and this project's explicit policy is to never
 * guess a model's capability from a lookup table that goes stale the moment
 * a lab ships something new. So this only ever fires when contextWindow is
 * a real number reported by the provider itself; an unknown window is
 * treated as "no evidence it won't fit", not as a reason to drop.
 *
 * @param {{contextWindow?: number|null}} candidate
 * @param {number|undefined} estimatedTokens
 * @returns {string|null} a drop reason, or null if it fits (or is unknown)
 */
export function checkContextFit(candidate, estimatedTokens) {
  const window = candidate?.contextWindow;
  if (!Number.isFinite(window) || window <= 0) return null;
  if (!Number.isFinite(estimatedTokens) || estimatedTokens <= 0) return null;

  const needed = estimatedTokens + OUTPUT_RESERVE_TOKENS;
  if (needed <= window) return null;

  return (
    `context window ~${Math.round(window / 1000)}k tokens is smaller than the ` +
    `~${Math.round(needed / 1000)}k tokens this harness's prompt (plus response ` +
    `headroom) would need`
  );
}

/**
 * @param {Array<{id: string, provider?: string|null, contextWindow?: number|null}>} candidates
 * @param {(opts: {model: string, provider: string}) => Promise<unknown>} prober
 *   Injected so tests can exercise the survivor/dropped bookkeeping without
 *   a live API call. Production callers pass one built on callModel().
 * @param {(msg: string) => void} [log] Progress lines; defaults to no-op so
 *   tests stay quiet.
 * @param {{estimatedTokens?: number}} [options] estimatedTokens enables the
 *   context-window fit check (see checkContextFit); omitted or non-numeric
 *   skips it entirely, same as a candidate with no known contextWindow.
 * @returns {Promise<{survivors: Array<{id:string,provider:string}>, dropped: Array<{id:string,provider:string|null,reason:string}>}>}
 */
export async function probeCandidates(candidates, prober, log = () => {}, { estimatedTokens } = {}) {
  const survivors = [];
  const dropped = [];

  for (const candidate of candidates) {
    const id = candidate.id;
    let provider = candidate.provider;

    if (!provider) {
      try {
        provider = resolveProvider(id);
      } catch (err) {
        dropped.push({ id, provider: null, reason: err.message });
        log(`❌ ${id}: ${err.message}`);
        continue;
      }
    }

    // Cheaper than a network call, and catches a class of failure a trivial
    // "reply OK" probe cannot: that probe succeeds even for a model whose
    // window is too small for the REAL prompt, because the probe payload is
    // a few dozen tokens. Checked here, before spending the network round
    // trip.
    const fitReason = checkContextFit(candidate, estimatedTokens);
    if (fitReason) {
      dropped.push({ id, provider, reason: fitReason });
      log(`❌ ${id} (${provider}): ${fitReason}`);
      continue;
    }

    try {
      await prober({ model: id, provider });
      survivors.push({ id, provider });
      log(`✓ ${id} (${provider}): reachable`);
    } catch (err) {
      dropped.push({ id, provider, reason: err.message });
      log(`❌ ${id} (${provider}): ${err.message}`);
    }
  }

  return { survivors, dropped };
}
