#!/usr/bin/env node

/**
 * Cost accounting — what a generation actually spent, in tokens.
 *
 * Every provider already parses a `usage` object out of its response
 * (harness/providers/*.mjs) and until this file existed the orchestrator
 * dropped it on the floor: attempts.json recorded how big the prompt was
 * and never what any call cost. learning/03-failure-modes.md Part 9 states
 * the consequence — "Nothing in the pipeline reads a budget" — and the
 * paper's RQ6 (economics) could not be answered from the record.
 *
 * Three pieces, all pure:
 *   normalizeUsage()   the four usage shapes the nine labs return, reduced
 *                      to {inputTokens, outputTokens}
 *   createSpendLedger() an accumulator one generation carries through every
 *                      stage, summarised into the attempt record
 *   withSpend()        wraps a `call` so each stage records itself without
 *                      the stage knowing accounting exists
 *
 * Tokens, not money. A price table rots faster than anything else in this
 * repository and a wrong price is worse than no price; tokens are what the
 * provider reports and what a cap can be honestly enforced against. Set a
 * spending limit in money at the provider as well — a cap here bounds one
 * run, not a month.
 */

/**
 * Reduce a provider's usage object to input/output tokens.
 *
 * Shapes, checked against each provider file's parse():
 *   anthropic          {input_tokens, output_tokens, cache_creation_input_tokens?, cache_read_input_tokens?}
 *   openai + the six   {prompt_tokens, completion_tokens}   (chat completions)
 *   openai-compatible  {input_tokens, output_tokens}         (responses API)
 *   google             {promptTokenCount, candidatesTokenCount, thoughtsTokenCount?}
 *
 * Cache and thinking tokens are billed, so they count: cache reads/writes as
 * input, thoughts as output. Returns null when nothing usable is present —
 * a caller then records an estimate and says so, rather than a zero that
 * would read as "free".
 *
 * @param {object|null|undefined} usage
 * @returns {{inputTokens: number, outputTokens: number}|null}
 */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const n = (v) => (Number.isFinite(v) ? v : 0);

  const input =
    n(usage.input_tokens) + n(usage.cache_creation_input_tokens) + n(usage.cache_read_input_tokens) +
    n(usage.prompt_tokens) +
    n(usage.promptTokenCount);
  const output =
    n(usage.output_tokens) +
    n(usage.completion_tokens) +
    n(usage.candidatesTokenCount) + n(usage.thoughtsTokenCount);

  const sawAny = ['input_tokens', 'prompt_tokens', 'promptTokenCount', 'output_tokens', 'completion_tokens', 'candidatesTokenCount']
    .some((k) => Number.isFinite(usage[k]));
  if (!sawAny) return null;
  return { inputTokens: input, outputTokens: output };
}

/** Rough tokens for a prompt or response when the provider reported nothing — the same 4-chars-per-token rule context-pack.mjs uses. */
export function estimateTokens(text) {
  return Math.round((text ?? '').length / 4);
}

/**
 * A rough per-image input cost for reservations. Labs bill an image at
 * somewhere between a few hundred and ~1,600 tokens depending on size; the
 * top of that range, because a reservation that is too small is the one
 * that lets a run overspend.
 */
export const IMAGE_TOKEN_ESTIMATE = 1600;

/** The input side of one request, estimated before it is sent. */
export function estimateRequestTokens({ system = '', user = '', images = [] } = {}) {
  return estimateTokens(system) + estimateTokens(user) + (images?.length ?? 0) * IMAGE_TOKEN_ESTIMATE;
}

/**
 * Thrown when a request would not fit under the generation's cap. Tagged
 * `kind: 'budget'` so it reads like any other classified API failure to
 * code that sorts failures by kind (a fan-out records it as that model's
 * failure; the attempt loop turns it into a `budget-exhausted` attempt).
 */
export class BudgetExceededError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'BudgetExceededError';
    this.kind = 'budget';
    Object.assign(this, detail);
  }
}

/**
 * One generation's running total, and the thing that stops it overspending.
 *
 * Every underlying request is ADMITTED before it is sent and SETTLED after:
 *
 *   admit()   reserves the request's estimated input plus its whole output
 *             allowance (maxTokens), and refuses — BudgetExceededError —
 *             if what is already spent, plus what is in flight, plus this,
 *             would exceed the cap. Parallel suggestions each reserve as
 *             they start, so a fan-out cannot collectively overshoot; a
 *             headroom retry reserves its doubled allowance before it goes.
 *   settle()  releases the reservation and records what the provider says
 *             the request actually cost (or an estimate, flagged, when it
 *             said nothing). Idempotent: the innermost layer that knows the
 *             real usage settles first, and an outer layer's settle of the
 *             same ticket is a no-op — which is what lets a test double,
 *             which settles nothing, still be counted by the wrapper.
 *
 * Before this, the ledger wrapped the headroom retry from outside and saw
 * only the final result: a truncated call and its retry, 200 tokens each,
 * were recorded as 200. And the cap was checked only between attempts, so
 * nothing bounded a single stage.
 *
 * @param {{maxTokens?: number|null}} [opts]  The cap. Null or absent: every
 *   request is admitted and simply recorded.
 */
export function createSpendLedger({ maxTokens = null } = {}) {
  const calls = [];
  const refused = [];
  const cap = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : null;
  let reserved = 0;
  let nextTicket = 1;

  const recordEntry = ({ site, model, provider = null, usage = null, system = '', user = '', text = '', estimatedInput = null, failed = false, statusCode = null }) => {
    const real = normalizeUsage(usage);
    const entry = real
      ? { site, model, provider, ...real, estimated: false }
      : {
          site, model, provider,
          inputTokens: estimatedInput ?? estimateTokens(system) + estimateTokens(user),
          outputTokens: estimateTokens(text),
          estimated: true,
        };
    if (failed) entry.failed = true;
    if (statusCode !== null && statusCode !== 200) entry.statusCode = statusCode;
    calls.push(entry);
    return entry;
  };

  const ledger = {
    calls,
    refused,

    /** Tokens held for requests that have been admitted but not settled. */
    reservedTokens() {
      return reserved;
    },

    /**
     * Reserve room for one request, or refuse it.
     * @param {{site: string, model: string, provider?: string|null, inputTokens: number, outputTokens: number}} req
     * @returns {object} a ticket for settle()
     */
    admit({ site, model, provider = null, inputTokens = 0, outputTokens = 0 }) {
      const need = Math.max(0, Math.round(inputTokens)) + Math.max(0, Math.round(outputTokens));
      const spent = ledger.total();
      if (cap !== null && spent + reserved + need > cap) {
        refused.push({ site, model, provider, need, spent, reserved });
        throw new BudgetExceededError(
          `budget.max_generation_tokens (${cap.toLocaleString()}) would be exceeded by a ${site} call to ${model}: ` +
          `${spent.toLocaleString()} spent + ${reserved.toLocaleString()} in flight + ${need.toLocaleString()} reserved for this request ` +
          `(estimated input + its full output allowance)`,
          { provider, site, need, spent, reserved, cap }
        );
      }
      reserved += need;
      return { id: nextTicket++, site, model, provider, inputTokens: Math.round(inputTokens), need, open: true };
    },

    /**
     * Release a ticket and record what the request cost. A second settle of
     * the same ticket returns null and records nothing.
     * @param {object} ticket
     * @param {{usage?: object|null, text?: string, failed?: boolean, statusCode?: number|null, model?: string, provider?: string|null}} [info]
     */
    settle(ticket, { usage = null, text = '', failed = false, statusCode = null, model, provider } = {}) {
      if (!ticket || !ticket.open) return null;
      ticket.open = false;
      reserved -= ticket.need;
      return recordEntry({
        site: ticket.site,
        model: model ?? ticket.model,
        provider: provider ?? ticket.provider,
        usage: failed ? null : usage,
        text: failed ? '' : text,
        estimatedInput: ticket.inputTokens,
        failed,
        statusCode,
      });
    },

    /** Close a ticket for a request that was never sent — a missing key, say — recording nothing. */
    release(ticket) {
      if (!ticket || !ticket.open) return;
      ticket.open = false;
      reserved -= ticket.need;
    },

    /** A site-bound view of admit/settle/release, handed to callModel as `meter`. */
    meterFor(site) {
      return {
        admit: (req) => ledger.admit({ ...req, site }),
        settle: (ticket, info) => ledger.settle(ticket, info),
        release: (ticket) => ledger.release(ticket),
      };
    },

    /**
     * @param {object} entry
     * @param {string} entry.site       suggest | rank | implement | review | digest | themes
     * @param {string} entry.model
     * @param {string|null} [entry.provider]
     * @param {object|null} [entry.usage]     The provider's raw usage object.
     * @param {string} [entry.system]         Used only to estimate when usage is absent.
     * @param {string} [entry.user]
     * @param {string} [entry.text]           The response text, likewise.
     */
    record({ site, model, provider = null, usage = null, system = '', user = '', text = '' }) {
      return recordEntry({ site, model, provider, usage, system, user, text });
    },

    /** Tokens spent so far, input plus output. */
    total() {
      return calls.reduce((sum, c) => sum + c.inputTokens + c.outputTokens, 0);
    },

    /** The shape written into attempts.json. */
    summary() {
      const by = (key) => {
        const out = {};
        for (const c of calls) {
          const k = c[key] ?? 'unknown';
          out[k] ??= { calls: 0, inputTokens: 0, outputTokens: 0 };
          out[k].calls += 1;
          out[k].inputTokens += c.inputTokens;
          out[k].outputTokens += c.outputTokens;
        }
        return out;
      };
      const inputTokens = calls.reduce((s, c) => s + c.inputTokens, 0);
      const outputTokens = calls.reduce((s, c) => s + c.outputTokens, 0);
      return {
        calls: calls.length,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        // How many entries are estimates because the provider reported no
        // usage — a reader should trust the totals less as this rises.
        estimatedCalls: calls.filter((c) => c.estimated).length,
        // Requests that errored (a timeout, a 5xx, a request-shape 4xx the
        // provider retried around). Counted at their estimated input, since
        // most labs bill a prompt they read before failing.
        failedRequests: calls.filter((c) => c.failed).length,
        // Requests the cap refused before they were sent. Nothing was spent
        // on these; they are why a run stopped early, not what it cost.
        refusedRequests: refused.length,
        maxGenerationTokens: cap,
        byModel: by('model'),
        bySite: by('site'),
      };
    },
  };
  return ledger;
}

/**
 * Wrap a `call` so that every invocation is recorded against `site`.
 * Failures are recorded too, as estimates of the prompt with no output —
 * a call that errored after the provider read the prompt was still paid
 * for on most labs, and a failed run with an honest cost is more useful
 * than one that looks free.
 *
 * @param {Function} call    callModelWithHeadroom or a test fake.
 * @param {ReturnType<typeof createSpendLedger>} ledger
 * @param {string} site
 */
export function withSpend(call, ledger, site) {
  const meter = ledger.meterFor(site);
  return async (opts) => {
    // Admitted before the call starts — synchronously, so every model in a
    // parallel fan-out reserves its room before any of them is sent. The
    // ticket is handed down as `meterTicket`: the real callModel settles it
    // with its first request's usage, and admits (and settles) any further
    // requests it makes — a headroom retry, a text-only retry — itself.
    const ticket = meter.admit({
      model: opts.model,
      provider: opts.provider ?? null,
      inputTokens: estimateRequestTokens(opts),
      outputTokens: opts.maxTokens ?? 16000,
    });
    try {
      const result = await call({ ...opts, meter, meterTicket: ticket });
      // A no-op when a layer below already settled it with real usage; the
      // record for a call that reported through no meter at all otherwise.
      meter.settle(ticket, { usage: result?.usage, text: result?.text, model: result?.model ?? opts.model, provider: result?.provider ?? opts.provider ?? null });
      return result;
    } catch (err) {
      meter.settle(ticket, { failed: true });
      throw err;
    }
  };
}

/**
 * The pre-fan-out check: would asking every model at this prompt size
 * already exceed the cap, before a single call is made? Input only — output
 * is unknowable in advance, so this catches "this will plainly not fit"
 * and leaves the rest to the running check between attempts.
 *
 * @param {{promptChars: number, models: number, maxTokens: number|null}} opts
 * @returns {{over: boolean, estimatedTokens: number}}
 */
export function projectedFanOut({ promptChars, models, maxTokens }) {
  const estimatedTokens = Math.round(promptChars / 4) * models;
  return { over: Number.isFinite(maxTokens) && maxTokens > 0 && estimatedTokens > maxTokens, estimatedTokens };
}
