#!/usr/bin/env node

/**
 * Rewrite harness/data/model-catalogue.json from every lab this machine
 * holds a key for — the maintainer-side half of "see the latest list".
 *
 * The console cannot do this itself and never will: it holds no lab keys
 * (console/DESIGN.md §2.2 — keys go browser → GitHub, never through us), so
 * the list it can offer before a repository is connected is whatever was
 * last committed here. A connected project's own .agent/model-snapshot.json
 * is the live source and always wins in the merged picker; this file is the
 * fallback for the ten minutes before one exists.
 *
 *   node --env-file=.env harness/scripts/refresh-model-catalogue.mjs
 *   node --env-file=.env harness/scripts/refresh-model-catalogue.mjs --providers anthropic,openai
 *
 * A lab with no key is skipped, and a skipped lab KEEPS whatever it already
 * had in the file rather than being emptied — same rule the detector uses
 * for a failed check (model-release-detector.mjs's newSnapshot), and for the
 * same reason: a missing key must never be able to masquerade as "this lab
 * has no models". `--prune` opts into the opposite, for a deliberate rebuild.
 *
 * Logs go to stderr; a one-line summary of what changed goes to stdout.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import '../providers/index.mjs';
import { getProvider, registeredProviders } from '../lib/llm-provider.mjs';
import { fetchModels } from '../lib/model-release-detector.mjs';
import { bundledModels } from '../lib/model-catalogue.mjs';

const CATALOGUE_PATH = fileURLToPath(new URL('../data/model-catalogue.json', import.meta.url));

function parseArgs(argv) {
  const out = { prune: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--providers') out.providers = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--prune') out.prune = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const outPath = path.resolve(args.out || CATALOGUE_PATH);
const providers = (args.providers || registeredProviders().join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

let existing = {};
try {
  existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
} catch {
  console.error(`No readable catalogue at ${outPath} — starting a new one.`);
}
const previous = bundledModels(existing);

/** Carried-over rows keep ISO dates, never the epoch-millisecond form bundledModels() parses them into. */
const carried = (rows) => rows.map((m) => ({ id: m.id, created: m.created > 0 ? new Date(m.created).toISOString() : null }));

const labs = {};
let fetched = 0;
let kept = 0;

for (const name of providers) {
  const provider = getProvider(name);
  if (!provider) {
    console.error(`- ${name}: not a registered provider — skipped`);
    continue;
  }
  const key = process.env[provider.envKey];
  const carryOver = previous.labs[name] || [];

  if (!key) {
    console.error(`- ${name}: skipped (no ${provider.envKey})${carryOver.length ? ` — keeping ${carryOver.length} existing entr${carryOver.length === 1 ? 'y' : 'ies'}` : ''}`);
    if (carryOver.length && !args.prune) {
      labs[name] = { source: existing?.labs?.[name]?.source || 'recorded-runs', models: carried(carryOver) };
      kept += carryOver.length;
    }
    continue;
  }

  const { status, models = [], reason } = await fetchModels(name, key);
  if (status !== 'success') {
    console.error(`⚠️  ${name}: listing failed — ${reason || 'unknown state'}${carryOver.length ? ' — keeping existing entries' : ''}`);
    if (carryOver.length && !args.prune) {
      labs[name] = { source: existing?.labs?.[name]?.source || 'recorded-runs', models: carried(carryOver) };
      kept += carryOver.length;
    }
    continue;
  }

  const rows = models
    .map((m) => ({ id: m.id, at: Number.isFinite(m.created) && m.created > 0 ? m.created : 0 }))
    .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))
    .map((m) => ({ id: m.id, created: m.at ? new Date(m.at).toISOString() : null }));
  labs[name] = { source: 'listed', models: rows };
  fetched += rows.length;

  const before = new Set(carryOver.map((m) => m.id.toLowerCase()));
  const added = rows.filter((m) => !before.has(m.id.toLowerCase())).map((m) => m.id);
  console.error(`✓ ${name}: ${rows.length} models${added.length ? ` (${added.length} not in the previous file: ${added.slice(0, 8).join(', ')}${added.length > 8 ? ', …' : ''})` : ''}`);
}

const catalogue = {
  note: existing.note || 'Bundled model catalogue, read by harness/lib/model-catalogue.mjs and served by the console\'s /api/models. Regenerate with harness/scripts/refresh-model-catalogue.mjs.',
  fetchedAt: new Date().toISOString(),
  source: fetched ? 'listed' : 'recorded-runs',
  sourceDetail: fetched
    ? 'Listed live from each lab\'s own catalogue endpoint by harness/scripts/refresh-model-catalogue.mjs. Labs with no key on that machine kept their previous entries.'
    : existing.sourceDetail || 'No lab could be listed on this run; every entry was carried over.',
  labs,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(catalogue, null, 2) + '\n');

console.log(`${outPath}: ${fetched} model(s) listed live, ${kept} carried over, ${Object.keys(labs).length} lab(s).`);
