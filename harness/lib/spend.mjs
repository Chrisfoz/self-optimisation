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
 * One generation's running total. Records are kept in full (one per call)
 * and summarised on demand, so the attempt record can carry both the
 * totals a cap needs and the per-model breakdown a report needs.
 */
export function createSpendLedger() {
  const calls = [];

  return {
    calls,

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
      const real = normalizeUsage(usage);
      const entry = real
        ? { site, model, provider, ...real, estimated: false }
        : { site, model, provider, inputTokens: estimateTokens(system) + estimateTokens(user), outputTokens: estimateTokens(text), estimated: true };
      calls.push(entry);
      return entry;
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
        byModel: by('model'),
        bySite: by('site'),
      };
    },
  };
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
  return async (opts) => {
    try {
      const result = await call(opts);
      ledger.record({
        site, model: result?.model ?? opts.model, provider: result?.provider ?? opts.provider ?? null,
        usage: result?.usage, system: opts.system, user: opts.user, text: result?.text,
      });
      return result;
    } catch (err) {
      ledger.record({ site, model: opts.model, provider: opts.provider ?? null, usage: null, system: opts.system, user: opts.user, text: '' });
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
