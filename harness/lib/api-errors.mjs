#!/usr/bin/env node

/**
 * Classifying provider API failures that mean "the user needs to act on
 * their key or their billing" rather than "retry later" or "this model
 * genuinely can't do the task."
 *
 * Why this exists: every lab already gets an error message in front of a
 * human eventually — buried in a crashed run's `detail` string, in
 * `docs/generations/gen-NNN/attempts.json`. That's enough to debug from,
 * but not enough to build a UI flag from without regexing prose, and a
 * regex over "whatever text this lab's API happened to return today" is
 * exactly the kind of check that silently stops matching the day a lab
 * changes its error copy. This module gives the classification a stable,
 * testable home instead: one pure function from (statusCode, body) to a
 * `kind`, called at the two places (llm-provider.mjs's callModel, for the
 * missing-key case; and its own throw, for the API-rejected-it case) where
 * the real signal — an HTTP status code — is still in hand.
 */

/**
 * @typedef {'missing_key'|'invalid_key'|'billing'|'rate_limited'|'other'} ApiErrorKind
 */

/** Thrown by llm-provider.mjs. Carries the same fields consistently across
 *  the "key not set" and "key rejected" cases, so callers never need to
 *  parse `.message` to find out why. */
export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {object} opts
   * @param {ApiErrorKind} opts.kind
   * @param {string} [opts.provider]
   * @param {number} [opts.statusCode]  Absent for missing_key — there was no HTTP response.
   */
  constructor(message, { kind, provider = null, statusCode = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.provider = provider;
    this.statusCode = statusCode ?? null;
  }
}

/** Kinds worth a user-facing flag — "you need to do something," not "this
 *  run had a bad day." Used to filter attempts.json's noisier detail down
 *  to what the console's Runs view actually surfaces. */
export const ACTIONABLE_KINDS = new Set(['missing_key', 'invalid_key', 'billing']);

/**
 * Classify an HTTP response from a provider as a key/billing problem, a
 * plain rate limit, or nothing distinctive. Pure — no network, no state —
 * so it's testable against fixture bodies from real lab responses without
 * a live key.
 *
 * @param {number} statusCode
 * @param {string} [raw]  Response body, if any.
 * @returns {ApiErrorKind}
 */
export function classifyStatusCode(statusCode, raw = '') {
  if (statusCode === 401) return 'invalid_key';
  if (statusCode === 402) return 'billing';
  if (statusCode === 403) {
    return /credit|billing|quota|payment|insufficient/i.test(raw) ? 'billing' : 'invalid_key';
  }
  if (statusCode === 429) {
    return /credit|billing|quota|payment|insufficient/i.test(raw) ? 'billing' : 'rate_limited';
  }
  return 'other';
}

/**
 * Reduce a list of `{id, provider, kind, statusCode}`-shaped entries (a
 * generation's suggestion-stage failures, or its single crash cause) down
 * to the ones worth a console flag, deduplicated by provider+kind so nine
 * labs sharing one expired card don't produce nine rows.
 *
 * @param {Array<{id?: string, provider?: string, kind?: ApiErrorKind, statusCode?: number}>} entries
 * @returns {Array<{provider: string, kind: ApiErrorKind, statusCode: number|null, ids: string[]}>}
 */
export function summarizeApiIssues(entries) {
  const byKey = new Map();
  for (const entry of entries ?? []) {
    if (!entry || !ACTIONABLE_KINDS.has(entry.kind)) continue;
    const key = `${entry.provider ?? 'unknown'}:${entry.kind}`;
    if (!byKey.has(key)) {
      byKey.set(key, { provider: entry.provider ?? 'unknown', kind: entry.kind, statusCode: entry.statusCode ?? null, ids: [] });
    }
    if (entry.id) byKey.get(key).ids.push(entry.id);
  }
  return [...byKey.values()];
}
