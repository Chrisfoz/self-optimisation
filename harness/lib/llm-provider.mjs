#!/usr/bin/env node

/**
 * Multi-provider LLM client — the core kernel component. Ported from
 * carrotgame's scripts/lib/llm-provider.mjs (the reference implementation),
 * genericised in one way: this file used to hardcode nine labs directly; it
 * now hardcodes none. Every lab is a separate file under harness/providers/
 * that calls registerProvider() as a side effect of being imported. This
 * file is the ONLY place that knows the transport, retry, and truncation
 * mechanics — it does not know Anthropic from Zhipu.
 *
 * Adding a provider to a project means writing one file under
 * harness/providers/ (see CONTRIBUTING-A-PROVIDER.md) and importing it —
 * nothing in this file changes. That was already carrotgame's stated
 * invariant ("adding a provider means adding one entry to PROVIDERS and one
 * pattern to PROVIDER_PATTERNS. Nothing else in the pipeline should branch on
 * provider"); this split makes it true one level further out — the entry no
 * longer requires editing a shared file at all.
 *
 * Images are part of the contract. Each lab encodes inline image data
 * differently, so each provider builds its own content parts in its own
 * file; callers just pass `images: [{mime, data}]`. A model with no vision
 * support is handled by retrying text-only rather than failing the run —
 * see callModel().
 */

import https from 'https';

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

// Ordered by registration order — most-specific-first is a convention each
// provider file's pattern should honour, not something this module enforces.
// See harness/providers/README (CONTRIBUTING-A-PROVIDER.md) for why pattern
// resolution is deliberately only ever the fallback: the release detector
// carries the provider alongside every model id it discovers, and that
// explicit tag is checked before this pattern table ever runs.
const PROVIDER_PATTERNS = [];
const PROVIDERS = {};

/**
 * Register a provider. Called as a side effect of importing a file under
 * harness/providers/ — see harness/providers/anthropic.mjs for the shape.
 *
 * @param {string} name    Provider key, e.g. "anthropic". Must be unique.
 * @param {object} config
 * @param {RegExp} [config.pattern]  Matched against a raw model id when no
 *   explicit provider was supplied. Optional — a provider can be dispatched
 *   to purely by explicit tag (see resolveProvider) without ever being
 *   guessed from an id.
 * @param {string} config.envKey      Environment variable holding the API key.
 * @param {string} config.hostname
 * @param {(ctx: {model, key}) => string} config.path
 * @param {(key: string) => object} config.headers
 * @param {(ctx: object) => object} config.body    Builds the request body.
 * @param {(data: object) => {text, stopReason, blockTypes, usage}} config.parse
 * @param {string[]} config.truncationReasons  Stop-reason values this
 *   provider uses to mean "ran out of output room". Provider-specific
 *   vocabulary — Anthropic says `max_tokens`, OpenAI-shaped APIs say
 *   `length`, Google says `MAX_TOKENS` — so this lives on the provider, not
 *   as a shared global set.
 * @param {(ctx: {statusCode, raw, body}) => object|null} [config.retryWithAdjustedBody]
 *   Optional escape hatch for a per-provider request-shape quirk discovered
 *   only from a live 4xx — e.g. an older model in a family that rejects a
 *   newer required field and wants the legacy one instead. Given the failed
 *   response, return an adjusted body to retry once, or null/undefined to
 *   decline. This is the named slot the checklist in
 *   learning/06-starter-kit.md means by "any per-provider quirk ... given a
 *   named slot on the shared request code, rather than a branch in the
 *   shared path itself" — it keeps quirk logic on the provider that has it,
 *   instead of the core branching on provider name.
 */
export function registerProvider(name, config) {
  if (PROVIDERS[name]) {
    throw new Error(`Provider "${name}" is already registered. Each provider file must use a unique name.`);
  }
  const { pattern, truncationReasons = [], ...rest } = config;
  PROVIDERS[name] = { ...rest, truncationReasons: new Set(truncationReasons) };
  if (pattern) PROVIDER_PATTERNS.push([pattern, name]);
}

/**
 * Map a model id to the lab that serves it, by pattern only.
 * Throws rather than guessing — sending a model id to the wrong provider
 * returns a confusing 404, which is exactly the failure this function exists
 * to prevent.
 *
 * This is the fallback path. Wherever a model id was discovered alongside an
 * explicit provider tag (a release-detection catalogue, a forced override),
 * prefer that tag over calling this function at all — see callModel's
 * `provider` option.
 */
export function resolveProvider(model) {
  if (!model || typeof model !== 'string') {
    throw new Error(`Invalid model id: ${JSON.stringify(model)}`);
  }
  for (const [pattern, provider] of PROVIDER_PATTERNS) {
    if (pattern.test(model)) return provider;
  }
  throw new Error(
    `Cannot resolve a provider for model "${model}". ` +
    `No registered provider's pattern matches it, and none was supplied explicitly. ` +
    `Either import the provider file that registers it, or pass { provider } explicitly.`
  );
}

/** True if a provider has been registered under this name. */
export function isProviderRegistered(name) {
  return Boolean(PROVIDERS[name]);
}

/** The names of every provider currently registered, in registration order. */
export function registeredProviders() {
  return Object.keys(PROVIDERS);
}

/**
 * Does this error body look like "I do not accept images"?
 *
 * Every lab words it differently and none of them use a machine-readable
 * code for it, so this matches on text. It is deliberately broad: the cost
 * of a false positive is one wasted text-only retry, while the cost of a
 * false negative is a whole generation lost because a new model shipped
 * without vision. Only consulted when images were actually sent.
 *
 * `content.type` is in here because a real probe against one lab's API
 * (Zhipu/GLM, text-only) rejected screenshots with a message that named
 * neither "image" nor any field name every other lab uses — a message this
 * regex would otherwise have missed entirely. The lesson generalises: a lab
 * can refuse images without using the word "image", so match the shape of
 * the complaint, not any one vendor's wording. See
 * learning/01-principles.md, principle 6c, for the incident this survived.
 */
const VISION_REJECTION = /image|vision|multimodal|inline_?data|image_url|media_type|unsupported content|content\[\d+\]|content\.type/i;

function looksLikeVisionRejection(raw) {
  return VISION_REJECTION.test(raw);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function postJson({ hostname, path, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname,
        port: 443,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode, raw: data }));
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request to ${hostname} timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Call a model on whichever provider serves it.
 *
 * @param {object}  opts
 * @param {string}  opts.model      Model id, e.g. "claude-opus-5", "gpt-5".
 * @param {string}  opts.system     System prompt.
 * @param {string}  opts.user       User prompt.
 * @param {number} [opts.maxTokens] Output cap. Default 16000 — comfortably
 *                                  above what targeted edits need, and below
 *                                  the point where non-streaming requests
 *                                  risk an HTTP timeout.
 * @param {string} [opts.provider]  Explicit provider, bypassing pattern
 *                                  resolution. Prefer this whenever the
 *                                  caller already knows the provider — a
 *                                  release-detection catalogue entry, a
 *                                  forced override — rather than asking
 *                                  resolveProvider() to guess.
 * @param {number} [opts.timeoutMs] Per-request timeout. Default 10 minutes:
 *                                  reasoning models can think for a long time.
 * @param {Array}  [opts.images]    Inline images as `{mime, data}` where data
 *                                  is base64. Dropped automatically if the
 *                                  model turns out to have no vision support.
 * @returns {Promise<{text, stopReason, truncated, provider, model, usage, blockTypes, sentImages}>}
 */
export async function callModel({
  model,
  system,
  user,
  maxTokens = 16000,
  provider = null,
  timeoutMs = 600000,
  images = [],
}) {
  const resolved = provider || resolveProvider(model);
  const config = PROVIDERS[resolved];
  if (!config) {
    throw new Error(
      `Unknown provider "${resolved}". Import the provider file that registers it before calling callModel().`
    );
  }

  const key = process.env[config.envKey];
  if (!key) {
    throw new Error(
      `${config.envKey} is not set, but model "${model}" is served by ${resolved}. ` +
      `Add that secret wherever this runs so the agent can run on this lab's model.`
    );
  }

  const request = {
    hostname: config.hostname,
    path: config.path({ model, key }),
    headers: config.headers(key),
    body: config.body({ model, system, user, maxTokens, images }),
    timeoutMs,
  };

  let sentImages = images.length;
  let { statusCode, raw } = await postJson(request);

  // The suggesting seat has to run on models that did not exist when this
  // was written, so it cannot know in advance whether a given model accepts
  // images. A text-only retry keeps the run alive: worse context beats no
  // run at all.
  if (statusCode >= 400 && sentImages > 0 && looksLikeVisionRejection(raw)) {
    console.error(
      `   ⚠️  ${resolved}/${model} rejected the ${sentImages} screenshot(s); retrying text-only.`
    );
    sentImages = 0;
    request.body = config.body({ model, system, user, maxTokens, images: [] });
    ({ statusCode, raw } = await postJson(request));
  }

  // A provider-declared quirk retry — e.g. an older model in a family that
  // rejects a newer required field. See registerProvider()'s
  // retryWithAdjustedBody doc above for why this is a hook rather than a
  // branch on provider name here.
  if (statusCode !== 200 && typeof config.retryWithAdjustedBody === 'function') {
    const adjusted = config.retryWithAdjustedBody({ statusCode, raw, body: request.body });
    if (adjusted) {
      request.body = adjusted;
      ({ statusCode, raw } = await postJson(request));
    }
  }

  if (statusCode !== 200) {
    throw new Error(`${resolved} API error ${statusCode}: ${raw.slice(0, 600)}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${resolved} returned unparseable JSON: ${err.message}`);
  }

  const parsed = config.parse(data);
  const truncated = config.truncationReasons.has(parsed.stopReason);

  if (!parsed.text) {
    const error = new Error(
      `${resolved}/${model} returned no text content ` +
      `(stop_reason: ${parsed.stopReason}, blocks: ${parsed.blockTypes.join(', ') || 'none'}). ` +
      (truncated
        ? 'The response hit the output cap before producing any text — raise maxTokens.'
        : 'Check the raw response shape for this provider.')
    );
    /* Tagged so callModelWithHeadroom() can tell the two apart. "Spent the
       whole budget thinking and never started writing" is the same problem
       as a truncated answer and has the same fix — more room — but it
       arrives as an exception rather than a short result, so the retry has
       to catch it explicitly. This is not a hypothetical: a real review call
       carrying three screenshots reasoned past its token cap and returned
       nothing but thinking blocks, with an error message that literally said
       "raise maxTokens" — see learning/03-failure-modes.md, "Changing what a
       stage returns without changing its output budget". */
    error.truncatedWithoutText = truncated;
    error.stopReason = parsed.stopReason;
    error.blockTypes = parsed.blockTypes;
    throw error;
  }

  return { ...parsed, truncated, provider: resolved, model, sentImages };
}

/**
 * callModel(), but retries with a larger token budget when the response was
 * truncated rather than accepting a partial answer at face value.
 *
 * Any fixed budget is a guess sized against models that exist today, and no
 * guess can be generous enough for one that ships later — a reasoning model
 * can spend an unpredictable share of it on hidden thinking tokens before
 * any visible answer. This reacts rather than guesses: on a truncated
 * response it retries once with the budget doubled before falling back to
 * whatever the caller does with a truncated result (salvage, reject, fail
 * closed).
 *
 * Bounded by design. An unattended job must not loop indefinitely, or run up
 * API spend, chasing a model that will never fit — one retry at up to
 * `factor`× the original budget is the default, and output is billed on
 * what is produced rather than what is permitted, so the extra headroom
 * costs nothing on the common path where the first call already fit.
 *
 * @param {Parameters<typeof callModel>[0]} opts
 * @param {{maxRetries?: number, factor?: number, call?: typeof callModel}} [tuning]
 *   `call` defaults to callModel and exists so tests can inject a fake
 *   without a live API call.
 */
export async function callModelWithHeadroom(opts, { maxRetries = 1, factor = 2, call = callModel } = {}) {
  let maxTokens = opts.maxTokens ?? 16000;
  let retries = 0;

  /* Two shapes of "ran out of room" reach us, and both get the same
     treatment: a short result flagged `truncated`, and a thrown error
     tagged `truncatedWithoutText` for a response that spent its whole
     budget on hidden reasoning. Anything else propagates immediately — a
     404, a bad key or an unparseable response is not fixed by trying again
     with a bigger number. */
  const attempt = async () => {
    try {
      return await call({ ...opts, maxTokens });
    } catch (err) {
      if (!err?.truncatedWithoutText) throw err;
      if (retries >= maxRetries) {
        err.message +=
          ` Retried ${retries} time(s), up to ${maxTokens} tokens; ` +
          `the budget for this call site is too small.`;
        throw err;
      }
      return { truncated: true, stopReason: err.stopReason ?? 'max_tokens', text: '', fromError: true };
    }
  };

  let result = await attempt();

  while (result.truncated && retries < maxRetries) {
    retries += 1;
    const next = Math.round(maxTokens * factor);
    console.error(
      `   ⚠️  ${opts.model} ${result.fromError ? 'produced no text' : 'truncated'} at ${maxTokens} tokens ` +
      `(${result.stopReason}); retrying with ${next} tokens of headroom (attempt ${retries}/${maxRetries}).`
    );
    maxTokens = next;
    result = await attempt();
  }

  return result;
}

export const __testing = { PROVIDERS, PROVIDER_PATTERNS, VISION_REJECTION, resolveProvider };
