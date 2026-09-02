/**
 * Tracks candidates diagnosed as unreachable for a reason no code change
 * fixes — an account or billing block, a deprecated product, a key without
 * access to that model.
 *
 * Stored under the `_unfixable` key of the model snapshot, deliberately
 * separate from the normal per-provider "models we have seen" lists. That
 * separation is the whole point:
 *
 *   - The normal seen-lists grow on every successful catalogue read, so a
 *     candidate that failed transiently stays eligible to be tried again.
 *     This matters more than it sounds. In the reference implementation's own
 *     history, one model failed twice with a TCP-level `ECONNRESET` before
 *     shipping a merged generation on the third attempt, and another failed
 *     the same way before shipping nine cycles later. Folding every failure
 *     into "seen" would have silently killed both.
 *
 *   - `_unfixable` is for the other kind: a candidate something has actually
 *     DIAGNOSED as permanently blocked, not merely observed to fail once.
 *     Without it, such a candidate is re-selected and re-probed every single
 *     cycle, forever, and each cycle spends real budget rediscovering the
 *     same dead end.
 *
 * The distinction is load-bearing, so guard it: nothing should write here on
 * the strength of a failed probe alone. A probe knows a call did not succeed;
 * it does not know why, and "why" is the entire difference between these two
 * lists. Writing must be a deliberate act — a diagnostic step that checked, or
 * a human who did.
 *
 * Matching is on the (provider, id) PAIR, never the bare id. The same id
 * string can legitimately exist under two providers — a lab's own `kimi-k3`
 * versus a reseller's `kimi/kimi-k3` listing are exactly this — and a bare-id
 * match would wrongly suppress a genuinely different candidate elsewhere.
 */

/**
 * True if this exact (provider, id) pair has been diagnosed as unfixable.
 *
 * @param {object} snapshot   The model snapshot, possibly carrying `_unfixable`.
 * @param {string} provider
 * @param {string} id
 * @returns {boolean}
 */
export function isUnfixable(snapshot, provider, id) {
  const list = Array.isArray(snapshot?._unfixable) ? snapshot._unfixable : [];
  return list.some((entry) => entry.provider === provider && entry.id === id);
}

/**
 * Folds newly diagnosed candidates into an existing `_unfixable` list.
 *
 * Keyed on provider+id, so a later, different diagnosis for the same
 * candidate replaces the old entry rather than accumulating duplicates.
 *
 * @param {object} snapshot                The current snapshot.
 * @param {Array<{id: string, provider?: string|null, reason: string}>} diagnosed
 *   Candidates a diagnostic step has confirmed are permanently blocked — NOT
 *   the raw dropped list from a reachability probe. See this file's header.
 * @param {string} [generation]            Label for when this was diagnosed.
 * @param {() => Date} [now]               Injectable clock, for tests.
 * @returns {Array<object>}                The merged list.
 */
export function mergeUnfixable(snapshot, diagnosed, generation, now = () => new Date()) {
  const existing = Array.isArray(snapshot?._unfixable) ? snapshot._unfixable : [];
  const byKey = new Map(existing.map((entry) => [`${entry.provider || ''}::${entry.id}`, entry]));
  const date = now().toISOString().slice(0, 10);

  for (const candidate of diagnosed || []) {
    byKey.set(`${candidate.provider || ''}::${candidate.id}`, {
      id: candidate.id,
      provider: candidate.provider || null,
      reason: candidate.reason,
      diagnosedGeneration: generation ?? null,
      diagnosedDate: date,
    });
  }

  return [...byKey.values()];
}
