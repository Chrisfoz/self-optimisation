/**
 * A loopback stand-in for all nine labs, for driving the REAL chain
 * end to end without a key or a bill.
 *
 * Every provider file under harness/providers/ describes how its lab
 * speaks: the path, the auth header, the request body, the response shape,
 * the /models listing. This server answers in each of those dialects, on
 * one port, and works out which lab it is being asked to be from the
 * `x-harness-upstream-host` header harness/lib/lab-endpoint.mjs adds when
 * HARNESS_LAB_ENDPOINT is set. So the request that reaches here is the
 * exact request a real run sends — built by the real provider file, sent
 * by the real transport, carrying the (fake) key from the real env var —
 * and the response goes back through the real parser. Only the model's
 * answer is scripted.
 *
 * What it checks on the way in, because a real lab would: a key must be
 * present in the dialect's own place (x-api-key, Authorization: Bearer,
 * or Google's ?key=) or the request is refused 401; a model id the
 * catalogue does not list is refused 404, the way a lab refuses a model
 * it does not serve.
 *
 * Every request is kept in `requests` (lab, model, stage, system, user,
 * images) so a test can assert on what the harness actually sent — which
 * prompt sections were present, which seat called which lab, how many
 * times.
 *
 * Usage:
 *   const labs = await startMockLabs();
 *   process.env.HARNESS_LAB_ENDPOINT = labs.url;
 *   for (const lab of labs.labs) process.env[lab.envKey] = 'test-key';
 *   ... run any harness script ...
 *   await labs.close();
 */

import http from 'node:http';
import '../../harness/providers/index.mjs';
import { registeredProviders, getProvider } from '../../harness/lib/llm-provider.mjs';
import { UPSTREAM_HOST_HEADER } from '../../harness/lib/lab-endpoint.mjs';
import { PROBE_SYSTEM } from '../../harness/lib/probe-models.mjs';

/** The line the default script's edits anchor on; a project the mock edits must contain it. */
export const MARKER = '<!-- harness: append below -->';

/**
 * One model per lab, ids matching each provider's own pattern so no
 * `provider:` pin is needed anywhere — the same ids the bundled catalogue
 * carries, so the console's pick-list and this server agree.
 */
export const DEFAULT_MODELS = {
  anthropic: ['claude-opus-5', 'claude-fable-5-1'],
  openai: ['gpt-6-astra', 'gpt-5.5'],
  google: ['gemini-3.8-flash', 'gemini-3.1-pro-preview'],
  moonshot: ['kimi-k3'],
  deepseek: ['deepseek-v4-pro'],
  qwen: ['qwen3.5-max'],
  xai: ['grok-4.6'],
  meta: ['muse-spark-1.3'],
  zai: ['glm-5.3'],
};

// ---------------------------------------------------------------------------
// Dialects
// ---------------------------------------------------------------------------

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((p) => p.text ?? '').join('')
      : '';

const imagesOf = (content) =>
  Array.isArray(content)
    ? content.filter((p) => p.type === 'image' || p.type === 'image_url' || p.inlineData || p.inline_data).length
    : 0;

const DIALECTS = {
  anthropic: {
    key: (req) => req.headers['x-api-key'],
    isList: (url) => url.pathname === '/v1/models',
    list: (models) => ({ data: models.map((id, i) => ({ id, created_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() })) }),
    isCall: (url) => url.pathname === '/v1/messages',
    parse: (body) => ({
      model: body.model,
      system: body.system ?? '',
      user: textOf(body.messages?.[0]?.content),
      images: imagesOf(body.messages?.[0]?.content),
      maxTokens: body.max_tokens,
    }),
    reply: (text, { input, output }) => ({
      id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: input, output_tokens: output },
    }),
    error: (status, message) => ({ type: 'error', error: { type: status === 401 ? 'authentication_error' : 'not_found_error', message } }),
  },
  google: {
    key: (req, url) => url.searchParams.get('key'),
    isList: (url) => url.pathname === '/v1beta/models',
    list: (models) => ({
      models: models.map((id) => ({
        name: `models/${id}`, supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1000000,
      })),
    }),
    isCall: (url) => /^\/v1beta\/models\/[^/]+:generateContent$/.test(url.pathname),
    parse: (body, url) => ({
      model: decodeURIComponent(url.pathname.match(/^\/v1beta\/models\/([^/]+):generateContent$/)[1]),
      system: body.systemInstruction?.parts?.map((p) => p.text ?? '').join('') ?? '',
      user: (body.contents?.[0]?.parts ?? []).map((p) => p.text ?? '').join(''),
      images: (body.contents?.[0]?.parts ?? []).filter((p) => p.inlineData).length,
      maxTokens: body.generationConfig?.maxOutputTokens,
    }),
    reply: (text, { input, output }) => ({
      candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: input, candidatesTokenCount: output, totalTokenCount: input + output },
    }),
    error: (status, message) => ({ error: { code: status, message, status: status === 401 ? 'UNAUTHENTICATED' : 'NOT_FOUND' } }),
  },
  openai: {
    key: (req) => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || null,
    isList: (url, provider) => url.pathname === provider.listModels.path(''),
    list: (models) => ({ object: 'list', data: models.map((id, i) => ({ id, object: 'model', created: 1767225600 + i * 86400, owned_by: 'mock' })) }),
    isCall: (url, provider) => url.pathname === provider.path({ model: '', key: '' }),
    parse: (body) => ({
      model: body.model,
      system: textOf(body.messages?.find((m) => m.role === 'system')?.content),
      user: textOf(body.messages?.find((m) => m.role === 'user')?.content),
      images: imagesOf(body.messages?.find((m) => m.role === 'user')?.content),
      maxTokens: body.max_tokens ?? body.max_completion_tokens,
    }),
    reply: (text, { input, output }) => ({
      id: 'chatcmpl-mock', object: 'chat.completion', model: 'mock',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
    }),
    error: (status, message) => ({ error: { message, type: status === 401 ? 'invalid_request_error' : 'invalid_request_error', code: status === 401 ? 'invalid_api_key' : 'model_not_found' } }),
  },
};

const dialectFor = (lab) => (lab === 'anthropic' || lab === 'google' ? DIALECTS[lab] : DIALECTS.openai);

// ---------------------------------------------------------------------------
// Stage classification — from the prompts the harness actually builds
// ---------------------------------------------------------------------------

/**
 * Which seat is calling, read off the request the way a person would: each
 * stage's prompt opens with a sentence no other stage uses. Kept in one
 * place so a driver script can branch on `ctx.stage` instead of re-deriving
 * it, and so a harness prompt change shows up here as a misclassified
 * request rather than a silently wrong answer.
 */
export function classify({ system, user }) {
  if (system === PROBE_SYSTEM) return 'probe';
  if (/^You are choosing between improvement proposals/.test(system)) return 'rank';
  if (/^You are implementing an approved improvement/.test(system)) return 'implement';
  if (/^You are reviewing \d+ generations? of /.test(system)) return 'themes';
  if (/^## Review request — /.test(user)) return 'review';
  if (/^Generation #\d+/.test(user)) return 'suggest';
  if (/digest|email/i.test(system)) return 'digest';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// The default script — a well-behaved lab that ships one small change
// ---------------------------------------------------------------------------

export function editBlock(file, search, replace) {
  return `<<<EDIT>>>\nFILE: ${file}\n<<<SEARCH>>>\n${search}\n<<<REPLACE>>>\n${replace}\n<<<END>>>`;
}

/** A complete, parseable suggestion. `fields` overrides any field; `edits` (array of blocks) is appended. */
export function suggestion({ model, file = 'index.html', fields = {}, edits = null } = {}) {
  const defaults = {
    PILLAR: 'Clarity',
    PROBLEM: `The page gives a first-time visitor no cue about what changed recently; ${model} found nothing that names the current state.`,
    CHANGE: `Append one short status line beneath the marker in ${file}, attributed to ${model}, so the next reader sees what the last generation did.`,
    'WHY THIS ONE': 'It is the smallest change that leaves a visible trace for the next generation to build on.',
    RISK: 'None beyond one extra paragraph; nothing existing is altered.',
    'ALSO UPDATE': 'nothing',
    VERIFICATION: `Open ${file} and confirm a paragraph attributed to ${model} sits directly under the marker.`,
    'BRIEF FEEDBACK': 'The brief was clear about the editable surface; it could say more about the audience.',
    ESCALATION: 'none',
    'ESCALATION TARGET': 'none',
    'ESCALATION CASE': 'none',
    'ESCALATION SUPPORT': 'none',
    'ESCALATION DISSENT': 'none',
  };
  const merged = { ...defaults, ...fields };
  const prose = Object.entries(merged).map(([k, v]) => `${k}: ${v}`).join('\n');
  const blocks = edits ?? [editBlock(file, MARKER, `${MARKER}\n<p data-generation="${model}">Improved by ${model}</p>`)];
  return `${prose}\n\n${blocks.join('\n\n')}`;
}

export const APPROVAL = 'VERDICT: APPROVED\n\nREASON: The change is minimal, matches the proposal, and touches only the editable file.\n\nREQUIRED FIXES: none\n\nEND OF REVIEW';

export const REJECTION = (why) => `VERDICT: REJECTED\n\nREASON: ${why}\n\nREQUIRED FIXES:\n- ${why}\n\nEND OF REVIEW`;

export const THEMES = `THEME 1
NOTICED: Generations 001 and 002 each appended a single attributed status line rather than changing any behaviour.
MEANS: When the editable surface is one static file and the brief rewards visibility, models converge on additive, low-risk traces instead of structural work.
UNKNOWN: Whether a wider editable surface would move the proposals toward behaviour, or only toward more traces.

THEME 2
NOTICED: Every proposal across both generations named the marker line as its anchor and nothing else in the file.
MEANS: A single well-known anchor concentrates every model's attention on it; the rest of the file becomes invisible to the loop.`;

/**
 * The default answer for each stage. A driver overrides per call by
 * passing `respond(ctx, defaults)` to startMockLabs(); `defaults` is this
 * function so an override can fall through for the stages it does not care
 * about.
 */
export function defaultRespond(ctx) {
  switch (ctx.stage) {
    case 'probe': return 'OK';
    case 'suggest': return suggestion({ model: ctx.model });
    case 'rank': return 'CHOICE: 1\nREASON: It is the most direct fix of the ones offered.';
    case 'implement': {
      // Re-issue the proposal's own edit blocks: a faithful implementer.
      const blocks = ctx.user.match(/<<<EDIT>>>[\s\S]*?<<<END>>>/g);
      const author = ctx.user.match(/^# The proposed improvement, from (.+)$/m)?.[1] ?? ctx.model;
      return blocks?.length
        ? blocks.join('\n\n')
        : editBlock('index.html', MARKER, `${MARKER}\n<p data-generation="${author}">Improved by ${author}, implemented by ${ctx.model}</p>`);
    }
    case 'review': return APPROVAL;
    case 'themes': return THEMES;
    case 'digest': return 'Subject: The loop ran\n\nOne change shipped this cycle.';
    default: return 'OK';
  }
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

const readBody = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', (c) => (data += c));
  req.on('end', () => resolve(data));
  req.on('error', reject);
});

const tokens = (text) => Math.max(1, Math.ceil(String(text ?? '').length / 4));

/**
 * @param {object} [opts]
 * @param {Record<string, string[]>} [opts.models]  Catalogue per lab; mutable
 *   after start via `labs.models` (add an id to make the detector see a release).
 * @param {(ctx: object, fallback: typeof defaultRespond) => string|Promise<string>} [opts.respond]
 * @param {(ctx: object) => number|null} [opts.status]  Return an HTTP status
 *   to refuse a call instead of answering it (a 503 to exercise the retry,
 *   a 429 for a quota) — null answers normally.
 */
export async function startMockLabs({ models = structuredClone(DEFAULT_MODELS), respond = null, status = null } = {}) {
  const hostToLab = new Map(registeredProviders().map((name) => [getProvider(name).hostname, name]));
  const requests = [];
  const listings = [];
  let calls = 0;

  const server = http.createServer(async (req, res) => {
    const send = (code, body) => {
      const payload = JSON.stringify(body);
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    };
    try {
      const upstream = req.headers[UPSTREAM_HOST_HEADER];
      const lab = hostToLab.get(upstream);
      const url = new URL(req.url, 'http://mock');
      if (!lab) return send(502, { error: `mock-labs: no lab registered for upstream host ${JSON.stringify(upstream)}` });
      const provider = getProvider(lab);
      const dialect = dialectFor(lab);
      const key = dialect.key(req, url);
      if (!key) return send(401, dialect.error(401, `mock ${lab}: no API key in the request`));

      if (req.method === 'GET' && dialect.isList(url, provider)) {
        listings.push({ lab, key });
        return send(200, dialect.list(models[lab] ?? []));
      }
      if (req.method === 'POST' && dialect.isCall(url, provider)) {
        const body = JSON.parse(await readBody(req));
        const parsed = dialect.parse(body, url);
        const stage = classify(parsed);
        const ctx = { lab, key, ...parsed, stage, n: ++calls, body, requests };
        requests.push({ lab, model: parsed.model, stage, system: parsed.system, user: parsed.user, images: parsed.images, maxTokens: parsed.maxTokens });
        if (!(models[lab] ?? []).includes(parsed.model)) {
          return send(404, dialect.error(404, `mock ${lab}: model ${parsed.model} does not exist or is not served here`));
        }
        const refuse = status ? status(ctx) : null;
        if (refuse) return send(refuse, dialect.error(refuse, `mock ${lab}: refused with ${refuse} by the test script`));
        const text = String(await (respond ? respond(ctx, defaultRespond) : defaultRespond(ctx)));
        return send(200, dialect.reply(text, { input: tokens(parsed.system) + tokens(parsed.user), output: tokens(text) }));
      }
      return send(404, dialect.error(404, `mock ${lab}: no route for ${req.method} ${url.pathname}`));
    } catch (err) {
      return send(500, { error: `mock-labs: ${err.message}` });
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    models,
    requests,
    listings,
    labs: registeredProviders().map((name) => ({ name, envKey: getProvider(name).envKey })),
    /** Env with the endpoint and a fake key for every lab — spread over process.env for a child. */
    env(extra = {}) {
      const out = { HARNESS_LAB_ENDPOINT: this.url, ...extra };
      for (const lab of this.labs) out[lab.envKey] = `mock-${lab.name}-key`;
      return out;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
