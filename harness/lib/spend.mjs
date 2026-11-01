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

/**
 * Prompt-cache activity inside a usage object, already counted in the input
 * total by normalizeUsage() and reported separately so a record can show what
 * caching saved. Reads are billed at a fraction of the input price, writes at a
 * premium. Anthropic reports both; OpenAI-shaped and Gemini responses report
 * cached reads only.
 *
 * @returns {{cacheReadTokens: number, cacheWriteTokens: number}}
 */
export function cacheUsage(usage) {
  const n = (v) => (Number.isFinite(v) ? v : 0);
  if (!usage || typeof usage !== 'object') return { cacheReadTokens: 0, cacheWriteTokens: 0 };
  return {
    cacheReadTokens: n(usage.cache_read_input_tokens) + n(usage.prompt_tokens_details?.cached_tokens) + n(usage.prompt_cache_hit_tokens) + n(usage.cachedContentTokenCount),
    cacheWriteTokens: n(usage.cache_creation_input_tokens),
  };
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

/**
 * Characters per token used when RESERVING room for a request. Lower than
 * the 4 that estimateTokens() uses for sizing, on purpose: code, JSON and
 * non-English text tokenize denser than prose, and a reservation that is
 * too small is the one that lets a run overspend. Sizing reports stay on 4
 * so their numbers remain comparable with older records.
 */
export const ADMISSION_CHARS_PER_TOKEN = 3;

/** The input side of one request, estimated before it is sent — conservatively (see ADMISSION_CHARS_PER_TOKEN). */
export function estimateRequestTokens({ system = '', user = '', images = [] } = {}) {
  const chars = (system ?? '').length + (user ?? '').length;
  return Math.round(chars / ADMISSION_CHARS_PER_TOKEN) + (images?.length ?? 0) * IMAGE_TOKEN_ESTIMATE;
}

/**
 * How cached input counts toward the cap, relative to ordinary input. Not
 * prices — the ratios labs publish for prompt caching, which have held
 * across every model generation so far: a cache read is billed at about a
 * tenth of an uncached token, a write at about 1.25x. Counting a cache read
 * at full weight made a run that re-read a large cached prefix look ten
 * times dearer than it was (Hospital of the Future generation 022:
 * 2,361,856 of 2,362,015 input tokens were cache reads).
 */
export const CACHE_READ_WEIGHT = 0.1;
export const CACHE_WRITE_WEIGHT = 1.25;

/**
 * Sites that belong to the discovery pool — finding out WHAT to build — as
 * opposed to building, reviewing and reporting it. See createSpendLedger()'s
 * discoveryShare.
 */
export const DISCOVERY_SITES = ['suggest', 'rank'];

/**
 * A provider-reported input count this many times the request's own
 * conservative estimate is not believable for a text prompt; the entry is
 * flagged `implausibleUsage` so a reader (and the next run's model
 * selection) can tell a pricing anomaly from a real cost. Seen live: Qwen's
 * `pre-mock_*` test endpoints reported ~4x the characters sent as tokens.
 */
export const IMPLAUSIBLE_USAGE_RATIO = 2.5;

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
 * Two pools, when `discoveryShare` is set. Discovery (DISCOVERY_SITES: the
 * suggestion fan-out and the ranking) may use at most that share of the
 * cap. Everything else — implement, review, refine, digest — may use the
 * rest, PLUS whatever discovery left unused, and is never charged for a
 * discovery overrun: discovery's spend is counted against the build pool
 * only up to discovery's own share. Before this, one pool meant five
 * suggesters could spend the whole cap and the implementer — the only stage
 * that produces anything — was refused (networkinAI generation 015: 6.2M
 * tokens of proposals, no code). An overrun can still happen, because a
 * provider can report more than was estimated; it is bounded by that
 * estimate error, discovery admits nothing more once it is over, and the
 * build stage keeps its full share either way.
 *
 * @param {{maxTokens?: number|null, discoveryShare?: number|null}} [opts]
 *   The cap, and the share of it discovery may use (0 < share < 1). Null or
 *   absent cap: every request is admitted and simply recorded. Null share:
 *   one pool, as before.
 */
export function createSpendLedger({ maxTokens = null, discoveryShare = null } = {}) {
  const calls = [];
  const refused = [];
  const cap = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : null;
  const discoveryCap = cap !== null && Number.isFinite(discoveryShare) && discoveryShare > 0 && discoveryShare < 1
    ? Math.round(cap * discoveryShare)
    : null;
  const isDiscovery = (site) => DISCOVERY_SITES.includes(site);
  let reserved = 0;
  let reservedDiscovery = 0;
  let nextTicket = 1;
  const cost = (c) => c.costTokens ?? (c.inputTokens + c.outputTokens);
  const spentWhere = (pred) => calls.reduce((sum, c) => (pred(c.site) ? sum + cost(c) : sum), 0);

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
    // Only when there was any, so a record from a run with no caching is
    // unchanged.
    if (real) {
      const cache = cacheUsage(usage);
      if (cache.cacheReadTokens) entry.cacheReadTokens = cache.cacheReadTokens;
      if (cache.cacheWriteTokens) entry.cacheWriteTokens = cache.cacheWriteTokens;
      // What counts toward the cap: cached input at its billed weight.
      // Present only when caching moved the number, so a record from a run
      // with no caching is unchanged.
      if (cache.cacheReadTokens || cache.cacheWriteTokens) {
        const uncached = Math.max(0, entry.inputTokens - cache.cacheReadTokens - cache.cacheWriteTokens);
        entry.costTokens = Math.round(uncached + cache.cacheReadTokens * CACHE_READ_WEIGHT + cache.cacheWriteTokens * CACHE_WRITE_WEIGHT + entry.outputTokens);
      }
      if (Number.isFinite(estimatedInput) && estimatedInput >= 1000 && entry.inputTokens > estimatedInput * IMPLAUSIBLE_USAGE_RATIO) {
        entry.implausibleUsage = true;
        entry.estimatedInputTokens = estimatedInput;
      }
    }
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

    /** The discovery pool's size, or null when there is one pool. */
    discoveryCap() {
      return discoveryCap;
    },

    /** What discovery (suggest, rank) has spent so far, at cap weight. */
    discoverySpent() {
      return spentWhere(isDiscovery);
    },

    /**
     * Reserve room for one request, or refuse it.
     * @param {{site: string, model: string, provider?: string|null, inputTokens: number, outputTokens: number}} req
     * @returns {object} a ticket for settle()
     */
    admit({ site, model, provider = null, inputTokens = 0, outputTokens = 0 }) {
      const need = Math.max(0, Math.round(inputTokens)) + Math.max(0, Math.round(outputTokens));
      const refuse = (spent, held, limit, pool) => {
        refused.push({ site, model, provider, need, spent, reserved: held, pool });
        throw new BudgetExceededError(
          `budget.max_generation_tokens (${cap.toLocaleString()}) would be exceeded by a ${site} call to ${model}` +
          `${pool ? ` (${pool} pool: ${limit.toLocaleString()})` : ''}: ` +
          `${spent.toLocaleString()} spent + ${held.toLocaleString()} in flight + ${need.toLocaleString()} reserved for this request ` +
          `(estimated input + its full output allowance)`,
          { provider, site, need, spent, reserved: held, cap, pool }
        );
      };
      const discovery = isDiscovery(site);
      if (cap !== null && discoveryCap === null) {
        const spent = ledger.total();
        if (spent + reserved + need > cap) refuse(spent, reserved, cap, null);
      } else if (cap !== null && discovery) {
        const spent = spentWhere(isDiscovery);
        if (spent + reservedDiscovery + need > discoveryCap) refuse(spent, reservedDiscovery, discoveryCap, 'discovery');
      } else if (cap !== null) {
        // The build pool: the cap, less what discovery used — but never less
        // than discovery's own share, however far over it ran.
        const discoveryCharged = Math.min(spentWhere(isDiscovery) + reservedDiscovery, discoveryCap);
        const limit = cap - discoveryCharged;
        const spent = spentWhere((s) => !isDiscovery(s));
        const held = reserved - reservedDiscovery;
        if (spent + held + need > limit) refuse(spent, held, limit, 'build');
      }
      reserved += need;
      if (discovery) reservedDiscovery += need;
      return { id: nextTicket++, site, model, provider, inputTokens: Math.round(inputTokens), need, discovery, open: true };
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
      if (ticket.discovery) reservedDiscovery -= ticket.need;
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
      if (ticket.discovery) reservedDiscovery -= ticket.need;
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

    /** Tokens spent so far, input plus output, with cached input at its billed weight (CACHE_READ_WEIGHT). */
    total() {
      return calls.reduce((sum, c) => sum + cost(c), 0);
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
          if (c.cacheReadTokens) out[k].cacheReadTokens = (out[k].cacheReadTokens ?? 0) + c.cacheReadTokens;
          if (c.cacheWriteTokens) out[k].cacheWriteTokens = (out[k].cacheWriteTokens ?? 0) + c.cacheWriteTokens;
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
        // Present only when they differ from the raw totals above, or a pool
        // or anomaly exists — so an ordinary record's shape is unchanged.
        ...(calls.some((c) => c.costTokens !== undefined) ? { costTokens: ledger.total() } : {}),
        ...(discoveryCap !== null ? { discoveryCap, discoverySpent: spentWhere(isDiscovery) } : {}),
        ...(calls.some((c) => c.implausibleUsage) ? {
          implausibleUsage: calls.filter((c) => c.implausibleUsage).map((c) => ({ site: c.site, model: c.model, provider: c.provider, reportedInputTokens: c.inputTokens, estimatedInputTokens: c.estimatedInputTokens })),
        } : {}),
        // Present only when a lab reported cache activity. Included in
        // inputTokens above; this is how much of it was cheap (reads) or
        // carried a premium (writes).
        ...(calls.some((c) => c.cacheReadTokens || c.cacheWriteTokens) ? {
          cacheReadTokens: calls.reduce((s, c) => s + (c.cacheReadTokens ?? 0), 0),
          cacheWriteTokens: calls.reduce((s, c) => s + (c.cacheWriteTokens ?? 0), 0),
        } : {}),
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

/**
 * How many suggesting models a pool can afford, before any is called. Each
 * is costed at its prompt (estimated conservatively, as admission does) plus
 * its whole output allowance — and twice over for a scoped run, whose
 * selection call re-sends the brief. Returns how many fit (0 when not even
 * one does) and the per-model cost used, so a caller can trim the fan-out
 * instead of letting the first few calls drain the pool and the rest be
 * refused mid-flight.
 *
 * @param {{promptChars: number, outputTokens: number, models: number, pool: number|null, calls?: number}} opts
 * @returns {{affordable: number, perModel: number}}
 */
export function affordableFanOut({ promptChars, outputTokens = 0, models, pool, calls = 1 }) {
  const perModel = Math.round(promptChars / ADMISSION_CHARS_PER_TOKEN) * calls + outputTokens;
  if (!Number.isFinite(pool) || pool <= 0) return { affordable: models, perModel };
  return { affordable: Math.max(0, Math.min(models, Math.floor(pool / Math.max(1, perModel)))), perModel };
}
