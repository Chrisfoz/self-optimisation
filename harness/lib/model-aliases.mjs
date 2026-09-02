/**
 * Collapses a reseller's vendor-namespaced model ids onto the bare id they
 * duplicate, so a lab re-listing a model the loop has already run cannot look
 * like a new release.
 *
 * This is not a hypothetical. The reference implementation lost a whole
 * generation to it: DashScope (Alibaba) re-listed Moonshot's Kimi K3 in its
 * own catalogue as `kimi/kimi-k3`, and the detector compared id strings —
 * `kimi/kimi-k3` is not the string `kimi-k3` — so a model that had already
 * been suggested, implemented, reviewed and merged four generations earlier
 * was selected as that month's new release.
 *
 * It then failed, because on DashScope only the namespaced form is gated
 * behind a separate product activation (verified live, same host and key:
 * bare `kimi-k3` answers, `kimi/kimi-k3` returns 400 "product is not
 * activated"). That failure sent the run down its unreachable-candidate path
 * and spent an expensive diagnostic pass on an endpoint that should never
 * have been called at all. The reachability error was real but incidental;
 * the defect was one layer up, and this module fixes that layer. **A
 * candidate that is not a new model does not need to be reachable.**
 *
 * Deliberately narrow. This is not a general "are these two ids the same
 * model?" matcher — no string rule could honestly be one. It handles exactly
 * the reseller-namespacing convention observed in real catalogues: a single
 * `vendor/` prefix. Everything else is returned untouched, because wrongly
 * dropping a genuinely new frontier model silently skips a cycle, which is a
 * far worse failure than occasionally running one twice.
 *
 * Scoped to a single provider's catalogue by design. The same model served by
 * two different labs stays two candidates, because it is two endpoints with
 * different behaviour, pricing and quirks — DashScope reselling Zhipu's GLM
 * line under identical bare ids is exactly this case, and a cross-provider
 * match would wrongly collapse it.
 */

/** Namespaced ids are `vendor/model`: exactly one slash, both halves non-empty. */
const NAMESPACED = /^[^/]+\/[^/]+$/;

/**
 * The bare id a namespaced id duplicates. Returns the input unchanged when it
 * is not vendor-namespaced, so this is safe to call on every id.
 *
 * @param {string} id
 * @returns {string}
 */
export function canonicalModelId(id) {
  if (typeof id !== 'string' || !NAMESPACED.test(id)) return id;
  return id.slice(id.indexOf('/') + 1);
}

/**
 * Comparison key: canonical form, case-folded.
 *
 * Case matters here for a real reason rather than a defensive one: DashScope
 * ships `ZHIPU/GLM-5.3` in the same listing as lowercase `glm-5.2`, so a
 * case-sensitive compare would miss a duplicate of an already-seen model.
 *
 * @param {string} id
 * @returns {string}
 */
export function aliasKey(id) {
  return String(canonicalModelId(id)).toLowerCase();
}

/**
 * True if `id` names a model already present in `knownIds` under either its
 * bare or its vendor-namespaced form.
 *
 * Both sides are canonicalised. A snapshot's seen-list can itself contain a
 * namespaced entry — real ones do — so normalising only the incoming id would
 * let the bare form through as "new" on a later run: the same bug, mirrored.
 *
 * @param {string} id
 * @param {string[]} knownIds
 * @returns {boolean}
 */
export function isKnownAlias(id, knownIds) {
  const key = aliasKey(id);
  return (knownIds || []).some((known) => aliasKey(known) === key);
}

/**
 * Collapses candidates naming the same model within a single run, keeping the
 * bare id wherever both forms appear.
 *
 * Preferring the bare form is grounded in observed API behaviour rather than
 * in a claim about which id a lab considers canonical: on the catalogue where
 * this was found, the bare id is the form that answers and the namespaced one
 * is the form gated behind a separate activation. Where only the namespaced
 * form is offered it is kept as-is — dropping it would silently lose a
 * candidate, which is the failure this module exists to prevent, not to
 * introduce.
 *
 * Input order is otherwise preserved, so ranking upstream is unaffected.
 *
 * @template {{id: string}} T
 * @param {T[]} candidates
 * @returns {T[]}
 */
export function dedupeAliases(candidates) {
  const byKey = new Map();

  for (const candidate of candidates || []) {
    const key = aliasKey(candidate.id);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, candidate);
      continue;
    }
    // Same model twice in one run — keep whichever is the bare form.
    if (NAMESPACED.test(existing.id) && !NAMESPACED.test(candidate.id)) {
      byKey.set(key, candidate);
    }
  }

  return [...byKey.values()];
}

/**
 * The duplicates `dedupeAliases()` would drop, as `{ id, duplicateOf }` pairs.
 *
 * Reported rather than dropped in silence, because a candidate vanishing
 * without explanation is precisely how the original bug stayed invisible for a
 * month: from outside, "we recognised a duplicate" and "the detector is
 * broken" look identical. Same reasoning as announcing what a fan-out ceiling
 * held back.
 *
 * @template {{id: string}} T
 * @param {T[]} candidates
 * @returns {Array<{id: string, duplicateOf: string|undefined}>}
 */
export function aliasDuplicates(candidates) {
  const kept = dedupeAliases(candidates);
  const keptIds = new Set(kept.map((m) => m.id));
  const keptByKey = new Map(kept.map((m) => [aliasKey(m.id), m.id]));

  return (candidates || [])
    .filter((m) => !keptIds.has(m.id))
    .map((m) => ({ id: m.id, duplicateOf: keptByKey.get(aliasKey(m.id)) }));
}
