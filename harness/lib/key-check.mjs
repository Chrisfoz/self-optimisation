/**
 * Does each key actually work?
 *
 * `validate.mjs` already reports a key that is absent. This answers the
 * different question a person asks before switching a schedule on: the key is
 * *there* — does the lab accept it, and is there money behind it?
 *
 * Two real failures motivate it, both silent:
 *
 *   1. A key can be valid on an account with no payment method. The run finds
 *      out at the reachability probe, mid-generation, after the fan-out has
 *      been priced (`402 billing_not_configured`, recorded in
 *      docs/campaigns/2026-09-11-first-real-campaigns.md).
 *   2. A key can be present and empty. `--env-file` takes the LAST assignment
 *      of a name, so a duplicate line with nothing after the `=` blanks a real
 *      key set above it — verified against Node directly. A blank
 *      SENDGRID_API_KEY does not fail a run: the digest step is
 *      `continue-on-error` and the email simply never arrives, which is the
 *      one outcome nobody notices.
 *
 * Everything here is pure: no network, no env, no stdio. The transport is
 * injected, so every branch below is tested without a key or a lab.
 * `harness/scripts/check-keys.mjs` owns the world.
 */

/**
 * Labs that return a balance to an ORDINARY key. Anthropic and OpenAI expose
 * spend only to an admin key, which a harness installation has no business
 * holding, so they are deliberately absent rather than half-supported.
 *
 * `parse` returns a short display string, or null when the shape is not what
 * was expected — a balance endpoint that changes should degrade to "no
 * balance reported", never to a crash or an invented number.
 */
export const BALANCE_CHECKS = {
  deepseek: {
    path: '/user/balance',
    parse: (data) => {
      const info = data?.balance_infos?.[0];
      if (!info || info.total_balance == null) return null;
      return `${info.total_balance} ${info.currency ?? ''}`.trim();
    },
  },
  moonshot: {
    path: '/v1/users/me/balance',
    parse: (data) => {
      const available = data?.data?.available_balance;
      if (available == null) return null;
      return `${available}`;
    },
  },
};

/**
 * One lab's verdict, from the pieces the caller gathered.
 *
 * Deliberately four states rather than ok/not-ok. "No key" and "key rejected"
 * get different exit codes because they are different problems: the first is
 * a lab you chose not to use, the second is a lab you think you are using and
 * are not.
 *
 * @param {object} o
 * @param {string} o.provider
 * @param {string} o.envKey
 * @param {string|undefined} o.key       The raw value, if any. Never logged.
 * @param {{status: string, models?: Array<unknown>, reason?: string}|null} o.listing
 * @returns {{provider: string, envKey: string, state: 'missing'|'blank'|'ok'|'rejected', detail: string, models: number}}
 */
export function classifyKey({ provider, envKey, key, listing }) {
  const base = { provider, envKey, models: 0 };
  if (key === undefined || key === null) {
    return { ...base, state: 'missing', detail: `${envKey} is not set` };
  }
  // A present-but-empty key is its own state. It reads as "configured" to
  // anyone skimming the file and behaves as "absent" at run time, which is
  // exactly why it is worth naming separately.
  if (String(key).trim() === '') {
    return { ...base, state: 'blank', detail: `${envKey} is set but empty — check for a duplicate line; the last one wins` };
  }
  if (!listing || listing.status !== 'success') {
    return { ...base, state: 'rejected', detail: listing?.reason || 'the lab did not accept this key' };
  }
  return { ...base, state: 'ok', detail: '', models: listing.models?.length ?? 0 };
}

/**
 * The exit code this run should use.
 *
 * A key that is present and does not work fails the check — that is the whole
 * point of running it. A lab with no key at all does not: watching fewer labs
 * is a legitimate choice, and `validate.mjs` is where "you watch a lab you
 * have no key for" is reported against the adapter that says so.
 *
 * A blank key fails. It is not a choice; it is a typo that looks like a
 * choice.
 *
 * @param {Array<{state: string}>} results
 * @returns {{code: 0|1, failed: number, blank: number, missing: number, ok: number}}
 */
export function summarise(results) {
  const count = (s) => results.filter((r) => r.state === s).length;
  const failed = count('rejected');
  const blank = count('blank');
  return {
    code: failed + blank > 0 ? 1 : 0,
    failed,
    blank,
    missing: count('missing'),
    ok: count('ok'),
  };
}

/** One aligned line per lab, for a terminal. Never includes a key. */
export function formatLine(result, balance = null) {
  const icon = { ok: '✅', rejected: '❌', blank: '❌', missing: '⚠️ ' }[result.state] ?? '?';
  const name = result.provider.padEnd(10);
  if (result.state === 'ok') {
    const models = `${result.models} model${result.models === 1 ? '' : 's'}`;
    return `${icon} ${name} key works — ${models}${balance ? ` · balance: ${balance}` : ''}`;
  }
  return `${icon} ${name} ${result.detail}`;
}
