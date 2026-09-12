/**
 * What models can a person actually pin to a seat right now?
 *
 * The detector (model-release-detector.mjs) answers a narrower question —
 * "what is new since last month" — and answers it inside a GitHub Actions
 * run, with the project's own keys. This module answers the broader one for
 * a human filling in a form: the full list each lab currently offers,
 * newest first, with an honest label on where each entry came from and how
 * old it is.
 *
 * There are exactly two sources, and they are kept distinguishable rather
 * than blended, because they are not equally true:
 *
 *   - **bundled** — `harness/data/model-catalogue.json`, refreshed by
 *     harness/scripts/refresh-model-catalogue.mjs and committed. It is a
 *     snapshot of what existed when someone last ran that script. It needs
 *     no keys, so it is all the console can offer before a repository is
 *     connected, and it is stale by construction.
 *
 *   - **repository** — the connected project's own
 *     `.agent/model-snapshot.json`, written by the detector during that
 *     project's last run using that project's own keys. This is the list
 *     that matters: it is current, and every id in it is one that
 *     account demonstrably can list. The console never holds a lab key, so
 *     this is the only way a live catalogue can reach it at all.
 *
 * A model in the repository snapshot that the bundled list has never heard
 * of is flagged `unseen`. That is the closest honest statement available to
 * "this is new": the snapshot carries ids only, with no release dates, so
 * "newer than the list we shipped" is a fact, while "released this month"
 * would be a guess.
 */

/**
 * Order a lab's models the way a person scanning a list wants them:
 * newest first where a release date is known, then by id descending, which
 * puts higher version numbers above lower ones for every naming scheme
 * observed in a real catalogue. Same rule as the detector's
 * rankCandidates() — a picker that ordered candidates differently from the
 * detector would quietly teach two different ideas of "newest".
 */
function byRecency(a, b) {
  return (b.created || 0) - (a.created || 0) || String(b.id).localeCompare(String(a.id));
}

/**
 * Normalise a `.agent/model-snapshot.json` into `{ provider: string[] }`.
 *
 * Tolerant on purpose: this file is read from someone else's repository,
 * where it may be half-written, hand-edited, or from a harness version
 * older than this one. A malformed entry is dropped, never thrown on — a
 * broken snapshot should cost the picker its live half, not the whole page.
 *
 * `_unfixable` is skipped: it is the diagnostic ledger
 * (unfixable-models.mjs), not a provider.
 *
 * @param {unknown} snapshot
 * @returns {Record<string, string[]>}
 */
export function snapshotModels(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return {};
  const out = {};
  for (const [provider, models] of Object.entries(snapshot)) {
    if (provider.startsWith('_') || !Array.isArray(models)) continue;
    const ids = [...new Set(models.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))];
    if (ids.length) out[provider] = ids;
  }
  return out;
}

/**
 * Normalise the bundled catalogue file into `{ provider: {id, created}[] }`.
 *
 * @param {unknown} bundled  Parsed harness/data/model-catalogue.json.
 * @returns {{fetchedAt: string|null, labs: Record<string, Array<{id: string, created: number}>>}}
 */
export function bundledModels(bundled) {
  const labs = {};
  const source = bundled && typeof bundled === 'object' && !Array.isArray(bundled) ? bundled : {};
  for (const [provider, entry] of Object.entries(source.labs || {})) {
    const models = Array.isArray(entry?.models) ? entry.models : [];
    const rows = models
      .filter((m) => m && typeof m.id === 'string' && m.id.trim())
      .map((m) => ({ id: m.id.trim(), created: Number.isFinite(m.created) ? m.created : Date.parse(m.created) || 0 }));
    if (rows.length) labs[provider] = rows;
  }
  return { fetchedAt: typeof source.fetchedAt === 'string' ? source.fetchedAt : null, labs };
}

/**
 * Merge both sources into one pick-list.
 *
 * @param {object} options
 * @param {unknown} [options.bundled]   Parsed harness/data/model-catalogue.json.
 * @param {unknown} [options.snapshot]  Parsed .agent/model-snapshot.json from the connected repo.
 * @param {string|null} [options.snapshotReadAt]  ISO time the snapshot file was read.
 * @param {(name: string) => {envKey?: string}|null} [options.provider]  getProvider, injected.
 * @returns {{
 *   fetchedAt: string|null,
 *   snapshotReadAt: string|null,
 *   counts: {bundled: number, repository: number, unseen: number},
 *   labs: Array<{name: string, envKey: string|null, models: Array<{id: string, created: number, sources: string[], unseen: boolean}>}>
 * }}
 */
export function buildCatalogue({ bundled, snapshot, snapshotReadAt = null, provider = () => null } = {}) {
  const fromBundle = bundledModels(bundled);
  const fromRepo = snapshotModels(snapshot);
  const names = [...new Set([...Object.keys(fromBundle.labs), ...Object.keys(fromRepo)])].sort();
  const counts = { bundled: 0, repository: 0, unseen: 0 };

  const labs = names.map((name) => {
    const bundledRows = fromBundle.labs[name] || [];
    const bundledIds = new Set(bundledRows.map((m) => m.id.toLowerCase()));
    const byId = new Map();

    for (const row of bundledRows) {
      byId.set(row.id.toLowerCase(), { id: row.id, created: row.created, sources: ['bundled'], unseen: false });
      counts.bundled++;
    }
    for (const id of fromRepo[name] || []) {
      counts.repository++;
      const key = id.toLowerCase();
      const existing = byId.get(key);
      if (existing) {
        existing.sources = [...new Set([...existing.sources, 'repository'])];
        continue;
      }
      // Present in the project's live snapshot, absent from what we shipped:
      // the only "this is newer than our list" claim this data supports.
      byId.set(key, { id, created: 0, sources: ['repository'], unseen: bundledIds.size > 0 });
      if (bundledIds.size > 0) counts.unseen++;
    }

    return {
      name,
      envKey: provider(name)?.envKey ?? null,
      models: [...byId.values()].sort(byRecency),
    };
  });

  return {
    fetchedAt: fromBundle.fetchedAt,
    snapshotReadAt,
    counts,
    labs: labs.filter((lab) => lab.models.length),
  };
}

/**
 * Flatten a catalogue to `{id, provider, created, unseen}` rows, newest
 * first across every lab — the shape a single picker renders from.
 *
 * @param {ReturnType<typeof buildCatalogue>} catalogue
 */
export function catalogueModels(catalogue) {
  return (catalogue?.labs || [])
    .flatMap((lab) => lab.models.map((m) => ({ ...m, provider: lab.name })))
    .sort((a, b) => Number(b.unseen) - Number(a.unseen) || byRecency(a, b));
}
