#!/usr/bin/env node

/**
 * Do the keys actually work? Run this before switching a schedule on, and
 * again whenever a run reports something odd about a lab.
 *
 * `validate.mjs` checks the adapter and reports a key that is ABSENT. This
 * checks the keys themselves: it calls each lab's model listing with the key
 * it would really use, and — for the labs that expose one to an ordinary key
 * — reads the account balance too. A key that is valid on an account with no
 * payment method is the failure this catches earliest; the alternative is
 * finding out mid-generation, after the fan-out has been priced.
 *
 * Run from a project's root:
 *
 *   node --env-file=.env.harness.local harness/scripts/check-keys.mjs
 *   node --env-file=.env harness/scripts/check-keys.mjs --providers anthropic,google
 *
 * Options:
 *   --providers a,b   only these labs (default: every registered lab)
 *   --adapter <path>  read project-adapter.yml from here, to also check the
 *                     notify key. Default: ./project-adapter.yml if present.
 *   --json            machine-readable, for a workflow step
 *
 * Exit code: 0 when every key present was accepted. 1 when any key was
 * rejected, or set-but-empty. A lab with NO key does not fail this check —
 * watching fewer labs is a legitimate choice, and the adapter, not this
 * script, is where "you watch a lab you have no key for" belongs.
 *
 * A key is never printed, in any mode, including on failure.
 */

import fs from 'node:fs';
import path from 'node:path';
import '../providers/index.mjs';
import { registeredProviders, getProvider } from '../lib/llm-provider.mjs';
import { fetchModels } from '../lib/model-release-detector.mjs';
import { resolveLabEndpoint } from '../lib/lab-endpoint.mjs';
import { BALANCE_CHECKS, classifyKey, summarise, formatLine } from '../lib/key-check.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : undefined;
};
const JSON_OUT = argv.includes('--json');

const only = (flag('--providers') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const providers = only.length ? only : registeredProviders();

const unknown = providers.filter((p) => !getProvider(p));
if (unknown.length) {
  console.error(`Not a registered lab: ${unknown.join(', ')}. Registered: ${registeredProviders().join(', ')}.`);
  process.exit(1);
}

/** The balance endpoint, over the same transport and host rules a real call uses. */
async function readBalance(providerName, key) {
  const check = BALANCE_CHECKS[providerName];
  if (!check) return null;
  const provider = getProvider(providerName);
  try {
    // Same rule the model calls use: a request carrying a real key goes
    // wherever LAB_ENDPOINT sends them, so a local stand-in intercepts this
    // too rather than this one call escaping to the real lab.
    const base = resolveLabEndpoint(provider.hostname);
    const scheme = base.port === 80 ? 'http' : 'https';
    const authority = base.port === 443 || base.port === 80 ? base.hostname : `${base.hostname}:${base.port}`;
    const res = await fetch(`${scheme}://${authority}${check.path}`, {
      headers: { ...provider.headers(key), ...base.headers },
    });
    if (!res.ok) return null;
    return check.parse(await res.json());
  } catch {
    // A balance is a nice-to-have. A lab that changed this endpoint must not
    // turn a working key into a failed check.
    return null;
  }
}

const results = [];
const balances = {};
for (const name of providers) {
  const provider = getProvider(name);
  const key = process.env[provider.envKey];
  const usable = typeof key === 'string' && key.trim() !== '';
  const listing = usable ? await fetchModels(name, key) : null;
  const result = classifyKey({ provider: name, envKey: provider.envKey, key, listing });
  results.push(result);
  if (result.state === 'ok') {
    const balance = await readBalance(name, key);
    if (balance) balances[name] = balance;
  }
}

// The notify key, when the adapter asks for one. A blank SENDGRID_API_KEY is
// the quietest failure in this whole system: the digest step is
// continue-on-error, so the run stays green and the email simply never
// arrives.
const adapterPath = flag('--adapter') || path.join(process.cwd(), 'project-adapter.yml');
let notifyResult = null;
if (fs.existsSync(adapterPath)) {
  const { loadAdapter, notifyConfig } = await import('../lib/adapter.mjs');
  try {
    const adapter = await loadAdapter(adapterPath);
    const notify = notifyConfig(adapter);
    if (notify?.provider) {
      const envKey = `${notify.provider.toUpperCase()}_API_KEY`;
      const key = process.env[envKey];
      if (typeof key !== 'string' || key.trim() === '') {
        notifyResult = classifyKey({ provider: notify.provider, envKey, key, listing: null });
      } else if (notify.provider === 'sendgrid') {
        // /v3/scopes tells us the key is accepted and what it may do, without
        // sending anything to anybody.
        let listing;
        try {
          const res = await fetch('https://api.sendgrid.com/v3/scopes', {
            headers: { Authorization: `Bearer ${key}` },
          });
          listing = res.ok
            ? { status: 'success', models: (await res.json())?.scopes ?? [] }
            : { status: 'error', reason: `SendGrid rejected this key (HTTP ${res.status})` };
        } catch (e) {
          listing = { status: 'error', reason: `SendGrid unreachable: ${e.message}` };
        }
        notifyResult = classifyKey({ provider: notify.provider, envKey, key, listing });
      }
    }
  } catch {
    // An adapter that will not parse is validate.mjs's business, not this
    // script's. Checking lab keys should still work in a project mid-edit.
  }
}

const all = notifyResult ? [...results, notifyResult] : results;
const summary = summarise(all);

if (JSON_OUT) {
  console.log(JSON.stringify({
    results: all.map((r) => ({ ...r, balance: balances[r.provider] ?? null })),
    ...summary,
  }, null, 2));
} else {
  for (const r of results) console.log(formatLine(r, balances[r.provider]));
  if (notifyResult) {
    console.log('');
    console.log(formatLine(
      // The notify key lists permission scopes, not models; say so rather
      // than reporting "37 models" for an email provider.
      notifyResult.state === 'ok' ? { ...notifyResult, models: 0 } : notifyResult,
    ).replace('key works — 0 models', 'key works — accepted, digest email can send'));
  }
  console.log('');
  const parts = [`${summary.ok} working`];
  if (summary.failed) parts.push(`${summary.failed} rejected`);
  if (summary.blank) parts.push(`${summary.blank} set but empty`);
  if (summary.missing) parts.push(`${summary.missing} not set`);
  console.log(parts.join(', ') + '.');
  if (summary.blank) {
    console.log('A key that is set but empty is usually a duplicate line: --env-file keeps the LAST assignment.');
  }
  if (summary.missing) {
    console.log('A lab with no key is only a problem if your adapter watches it, or pins a seat to it — `node harness/scripts/validate.mjs` checks that.');
  }
}

process.exit(summary.code);
