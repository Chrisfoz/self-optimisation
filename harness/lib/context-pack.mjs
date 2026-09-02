#!/usr/bin/env node

/**
 * Derived context for the suggestion stage — the context compiler. Ported
 * from carrotgame's scripts/lib/context-pack.mjs (the reference
 * implementation), which is real design work rather than a straight port
 * (see Portable-Harness-Design.md §8.2): every builder below took a
 * hardcoded, repo-relative path or a carrotgame-specific literal and needed
 * an actual decision about what becomes a parameter versus what stays
 * project-specific.
 *
 * The rule every builder follows, unchanged from the reference
 * implementation: send what changes the decision, not what describes the
 * codebase. Raw source has diminishing and eventually negative returns —
 * each function here returns *derived* context (a manifest, an index, a
 * history), denser per token by roughly an order of magnitude than the
 * files it's derived from.
 *
 * What did NOT port, and why — see Portable-Harness-Design.md's Bucket B
 * table and §8.2 for the full reasoning:
 *   - collectScreenshots() / buildScorecardBrief() — carrotgame's own
 *     visual and scorecard plugins. The *category* (optional, non-gating
 *     quality-dimension plugins) is portable; the specific dimensions are
 *     not, and were already flagged as the one worked example, not the
 *     default, when visual-check/wordless-play were assessed.
 *   - buildPlatformNotes() — a static paragraph of prose describing
 *     carrotgame's hospital-tablet deployment. There's no function to
 *     port here; a project supplies its own paragraph as plain adapter
 *     config (`context.platform_notes`) and passes it straight through.
 */

import fs from 'fs';
import path from 'path';
import { isEditable } from './edit-format.mjs';

const read = (repoRoot, relative) => {
  try {
    return fs.readFileSync(path.join(repoRoot, relative), 'utf8');
  } catch {
    return null;
  }
};

const sizeOf = (repoRoot, relative) => {
  try {
    return fs.statSync(path.join(repoRoot, relative)).size;
  } catch {
    return null;
  }
};

const listDir = (repoRoot, relative) => {
  try {
    return fs.readdirSync(path.join(repoRoot, relative)).filter((f) => !f.startsWith('.'));
  } catch {
    return [];
  }
};

const kb = (bytes) => `${Math.round(bytes / 1024)}KB`;

// ---------------------------------------------------------------------------
// (1) Source bundle — the files the agent may actually edit
// ---------------------------------------------------------------------------

/**
 * Full source of every listed file. A file the agent may edit must be a
 * file the agent has read — see learning/04-context-recipe.md's "A file
 * the agent may edit is a file the agent must have read" for the incident
 * this rule exists to prevent (a file sat in the editable allowlist for
 * months, unsent, so a proposal could legitimately target it and the
 * implementation stage would have to invent SEARCH blocks against text it
 * had never seen).
 *
 * @param {string[]} files  Relative paths, typically a project's
 *   `constitution.allowed_paths` minus anything sent separately (e.g. a
 *   generation log, sent as history rather than duplicated as source).
 * @param {{repoRoot?: string}} [opts]
 */
export function buildSourceBundle(files, { repoRoot = process.cwd() } = {}) {
  const blocks = [];
  for (const relative of files) {
    const content = read(repoRoot, relative);
    if (content === null) continue;
    const lang = relative.endsWith('.md') ? 'markdown'
      : relative.endsWith('.css') ? 'css'
      : relative.endsWith('.json') ? 'json'
      : relative.endsWith('.js') || relative.endsWith('.mjs') ? 'javascript'
      : 'html';
    blocks.push(
      `## ${relative} (${content.length} chars)\n\`\`\`${lang}\n${content}\n\`\`\``
    );
  }
  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// (2) Architecture notes
// ---------------------------------------------------------------------------

/**
 * The standing-context prose at the top of a project's own architecture
 * document — everything before an append-only log begins, if it has one.
 *
 * The reference implementation's own incident, generalised: its prompt
 * used to send a fixed-size *tail* of the whole file
 * (`.slice(-4000)`). That was fine while the file was short, and silently
 * stopped being fine the moment an ever-growing append-only log at the
 * bottom pushed the real notes further than 4000 characters from the end —
 * every note added after that point was invisible to every suggesting
 * model, with nothing checking what the slice actually contained. This
 * sends everything up to the marker, in full, rather than a fixed-size
 * window of the whole file — see
 * learning/01-principles.md's "20c" for the general shape of this bug
 * class (a fixed-size window silently forgetting content nobody is
 * checking).
 *
 * @param {{repoRoot?: string, docPath?: string, appendOnlyMarker?: string|null}} [opts]
 *   `docPath` defaults to null, meaning "no architecture doc configured" —
 *   this returns null rather than guessing a filename. `appendOnlyMarker`,
 *   when set, is the literal text where an append-only log begins; notes
 *   are truncated there. Leave unset for a doc with no such log.
 */
export function buildArchitectureNotes({ repoRoot = process.cwd(), docPath = null, appendOnlyMarker = null } = {}) {
  if (!docPath) return null;
  const text = read(repoRoot, docPath);
  if (!text) return null;

  if (!appendOnlyMarker) return text.trim() || null;
  const marker = text.indexOf(appendOnlyMarker);
  const notes = marker === -1 ? text : text.slice(0, marker);
  return notes.trim() || null;
}

// ---------------------------------------------------------------------------
// (3) Generation history, including what failed
// ---------------------------------------------------------------------------

const DEFAULT_GENERATIONS_DIR = 'docs/generations';

/**
 * Pull the useful fields out of a stored proposal.md without parsing
 * markdown properly — the file is written by the (not yet ported)
 * orchestrator's own proposal writer, so its shape is a known contract.
 */
function summariseProposal(markdown) {
  const field = (name) =>
    markdown.match(new RegExp(`^- \\*\\*${name}:\\*\\*\\s*(.+)$`, 'im'))?.[1]?.trim() ?? null;

  const rationale = markdown
    .match(/^## Rationale\s*\n+([\s\S]*?)(?=\n## )/m)?.[1]
    ?.trim()
    ?.replace(/\s+/g, ' ')
    ?? null;

  return {
    summary: field('Summary'),
    suggestedBy: field('Suggested by'),
    implementedBy: field('Implemented by'),
    scope: field('Scope'),
    attempts: field('Attempts'),
    rationale,
  };
}

function generationDirs(repoRoot, generationsDir) {
  return listDir(repoRoot, generationsDir).filter((f) => /^gen-\d+$/.test(f)).sort();
}

/**
 * The generation numbers on record, oldest first, as the padded strings
 * their directory names carry (`['001', '002', ...]`).
 *
 * Exported because more than one caller now needs "which generations exist"
 * without needing their contents — `generate-themes-review.mjs` uses it to
 * default GEN_NUMBER to the newest one and to size its window honestly. The
 * sort is lexicographic on the directory name, which is correct precisely
 * because the padding is consistent; see generate-themes.mjs's
 * padGeneration() for the same constraint stated where it can be violated.
 */
export function generationNumbers({ repoRoot = process.cwd(), generationsDir = DEFAULT_GENERATIONS_DIR } = {}) {
  return generationDirs(repoRoot, generationsDir).map((d) => d.slice('gen-'.length));
}

/**
 * A one-line-per-generation index covering every generation on record —
 * not just the recent window buildGenerationHistory() below sends in full.
 *
 * Full per-generation detail is expensive to send and most of it stops
 * being decision-relevant once a couple of newer attempts exist, so
 * buildGenerationHistory() only sends the most recent few in full. But
 * "only the most recent few" means everything older silently disappears
 * from every future suggesting model's view, with no signal that it
 * happened — the reference implementation's default 5-entry window had
 * already aged nine real generations out of view by generation 015. This
 * index is the fix: one short line per generation is cheap enough to send
 * in full, unconditionally, for as long as the project runs.
 *
 * @param {{repoRoot?: string, generationsDir?: string}} [opts]
 */
export function buildGenerationIndex({ repoRoot = process.cwd(), generationsDir = DEFAULT_GENERATIONS_DIR } = {}) {
  const all = generationDirs(repoRoot, generationsDir);
  if (all.length === 0) return null;

  // Markdown table cells cannot contain a literal `|`, and this text
  // ultimately comes from model-authored proposals and error messages.
  const cell = (s) => String(s ?? '—').replace(/\|/g, '/').replace(/\s+/g, ' ').trim().slice(0, 90);
  const modelOnly = (s) => cell(s).replace(/`/g, '').replace(/\s*—\s*newly released\s*$/i, '');

  const rows = all.map((dir) => {
    const proposal = read(repoRoot, `${generationsDir}/${dir}/proposal.md`);
    const attemptsRaw = read(repoRoot, `${generationsDir}/${dir}/attempts.json`);

    let suggestedBy = '—';
    let outcome = 'unknown';
    let change = '—';

    if (proposal) {
      const p = summariseProposal(proposal);
      suggestedBy = p.suggestedBy ?? '—';
      outcome = 'MERGED';
      change = p.summary ?? '—';
    } else if (attemptsRaw) {
      try {
        const record = JSON.parse(attemptsRaw);
        // suggestModel is only set once a model actually produced a
        // proposal — on a no-proposal outcome it is always null, even
        // though we know exactly who was asked. fanOut.asked has that;
        // falling back to it means the index still says who failed, not
        // just that someone did.
        suggestedBy = record.suggestModel ?? record.fanOut?.asked?.join(', ') ?? '—';
        outcome = record.outcome === 'no-proposal' ? 'NO PROPOSAL'
          : record.outcome === 'abandoned' ? 'ABANDONED'
          : String(record.outcome ?? 'unknown').toUpperCase();
        change = record.proposalSummary
          || record.attempts?.find((a) => a.outcome !== 'approved')?.detail
          || '—';
      } catch {
        // A malformed record is not worth failing the build over; the row
        // just stays generic instead of describing this generation.
      }
    }

    return `| ${dir.replace('gen-', '')} | ${modelOnly(suggestedBy)} | ${outcome} | ${cell(change)} |`;
  });

  return [
    '| Gen | Suggested by | Outcome | Change |',
    '|---|---|---|---|',
    ...rows,
  ].join('\n');
}

/**
 * What previous generations proposed, and — more valuably — what did not
 * work. Deliberately a small recent window rather than everything:
 * buildGenerationIndex() above already guarantees no generation is ever
 * completely forgotten, so this only needs to carry the *expensive* detail
 * (rationale, exact failure messages) for generations recent enough that
 * it is still likely to change this generation's decision.
 *
 * @param {{repoRoot?: string, generationsDir?: string, limit?: number}} [opts]
 */
export function buildGenerationHistory({ repoRoot = process.cwd(), generationsDir = DEFAULT_GENERATIONS_DIR, limit = 5 } = {}) {
  const all = generationDirs(repoRoot, generationsDir);

  // Not `.slice(-limit)`: at limit 0 that is `.slice(-0)`, which is
  // `.slice(0)` and returns everything.
  const dirs = all.slice(Math.max(0, all.length - Math.max(0, limit)));

  if (dirs.length === 0) return '- None yet; this is the first generation.';

  const entries = dirs.map((dir) => {
    const lines = [`### ${dir}`];

    const proposal = read(repoRoot, `${generationsDir}/${dir}/proposal.md`);
    if (proposal) {
      const p = summariseProposal(proposal);
      lines.push(`- Outcome: MERGED`);
      if (p.suggestedBy) lines.push(`- Suggested by: ${p.suggestedBy}`);
      if (p.implementedBy) lines.push(`- Implemented by: ${p.implementedBy}`);
      if (p.scope) lines.push(`- Scope: ${p.scope}`);
      if (p.summary) lines.push(`- Change: ${p.summary}`);
      if (p.attempts) lines.push(`- Implementation attempts needed: ${p.attempts}`);
      if (p.rationale) lines.push(`- Rationale: ${p.rationale}`);
    }

    const attemptsRaw = read(repoRoot, `${generationsDir}/${dir}/attempts.json`);
    if (attemptsRaw) {
      try {
        const record = JSON.parse(attemptsRaw);
        if (!proposal) {
          lines.push(`- Outcome: ${record.outcome === 'approved' ? 'APPROVED' : 'ABANDONED — no change shipped'}`);
          if (record.suggestModel) lines.push(`- Suggested by: ${record.suggestModel}`);
          if (record.proposalSummary) lines.push(`- Proposed: ${record.proposalSummary}`);
        }
        for (const attempt of record.attempts ?? []) {
          if (attempt.outcome === 'approved') continue;
          lines.push(
            `- Attempt ${attempt.attempt} failed (${attempt.outcome}): ${attempt.detail}`
          );
        }
      } catch {
        // A malformed record is not worth failing a run over.
      }
    }

    return lines.join('\n');
  });

  return entries.join('\n\n');
}

// ---------------------------------------------------------------------------
// (4) Test index — names, not bodies
// ---------------------------------------------------------------------------

/**
 * Default name extractor: matches `test('name', ...)`, `it('name', ...)`
 * and `describe('name', ...)` — the shape Node's own built-in test runner,
 * Jest, Mocha and Jasmine all share. Deliberately a regex rather than a
 * real parse: this is an index for a prompt, and a missed line costs
 * nothing.
 */
export function extractStandardTestNames(source) {
  const CALL = /\b(?:test|it|describe)\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  const names = [];
  for (const match of source.matchAll(CALL)) {
    names.push(match[2].replace(/\$\{[^}]*\}/g, 'N'));
  }
  return names;
}

/**
 * The reference implementation's own extractor, kept as a named export
 * rather than silently dropped: it matches `check('name', …)` and
 * `check('game', 'name', …)` — a project-specific test-helper convention,
 * useful as a worked example of a custom `extractNames` function for a
 * project whose test suite doesn't use test/it/describe.
 */
export function extractCheckCallNames(source) {
  const CALL = /\bcheck\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*,\s*(?:(['"`])((?:\\.|(?!\3)[^\\])*)\3\s*,)?/g;
  const names = [];
  for (const match of source.matchAll(CALL)) {
    const name = match[4] ?? match[2];
    names.push(name.replace(/\$\{[^}]*\}/g, 'N'));
  }
  return names;
}

/**
 * What the suites assert, by name, without their bodies — dense signal at
 * a fraction of the token cost of the real files. Names carry the
 * constraint; bodies would only cost tokens.
 *
 * @param {{repoRoot?: string, testFiles?: string[], extractNames?: (source: string) => string[]}} opts
 *   `testFiles` is a list of relative paths to scan — typically resolved
 *   from a project's test glob before calling this (this function does no
 *   glob expansion itself, to stay dependency-free). `extractNames`
 *   defaults to extractStandardTestNames.
 */
export function buildTestIndex({ repoRoot = process.cwd(), testFiles = [], extractNames = extractStandardTestNames } = {}) {
  const sections = [];

  for (const relative of testFiles) {
    const source = read(repoRoot, relative);
    if (!source) continue;
    const names = extractNames(source);
    if (names.length === 0) continue;
    sections.push(`**${relative}**\n${names.map((n) => `- ${n}`).join('\n')}`);
  }

  if (sections.length === 0) return null;

  return `Every assertion named below runs against your change, and none of them can be modified — the test suite is append-only for this harness, because the cheapest way to make a failing build pass is to weaken the test. Treat each line as a frozen invariant. Bodies are omitted deliberately: the names carry the constraint, the bodies would only cost tokens.\n\n${sections.join('\n\n')}`;
}

// ---------------------------------------------------------------------------
// (5) Repo manifest
// ---------------------------------------------------------------------------

/**
 * A map of the repository: path, size, one line of purpose, and whether
 * the agent may touch it. Enough to rule out a structurally impossible
 * proposal before it is written — "add a setting to a frozen config file"
 * — before it is rejected three stages later.
 *
 * @param {{repoRoot?: string, purposes: Record<string,string>, allowlist: object, appendOnlyPaths?: RegExp[], createOnlyDescription?: string}} opts
 *   `purposes` is a path -> one-line-description map — always
 *   project-specific, supplied by the caller (a project's adapter config
 *   is the natural source; see examples/carrotgame/project-adapter.yml's
 *   file list for the shape, though the reference implementation itself
 *   still keeps this as a literal, not yet an adapter field). `allowlist`
 *   is edit-format.mjs's compileAllowlist() result. `appendOnlyPaths` is
 *   guard.mjs-style RegExp[], for a status column that isn't just
 *   editable-vs-frozen.
 */
export function buildRepoManifest({ repoRoot = process.cwd(), purposes = {}, allowlist, appendOnlyPaths = [], createOnlyDescription = 'files matching the create-only pattern' } = {}) {
  const rows = [];

  const statusOf = (relative) => {
    if (isEditable(relative, allowlist)) return 'EDITABLE';
    if (appendOnlyPaths.some((re) => re.test(relative))) return 'append-only (new files only)';
    return 'frozen';
  };

  for (const [relative, purpose] of Object.entries(purposes)) {
    const size = sizeOf(repoRoot, relative);
    if (size === null) continue;
    const isDir = fs.statSync(path.join(repoRoot, relative)).isDirectory();
    const measure = isDir ? `${listDir(repoRoot, relative).length} files` : kb(size);
    rows.push(`| \`${relative}\` | ${measure} | ${statusOf(relative)} | ${purpose} |`);
  }

  return [
    '| Path | Size | Agent access | Purpose |',
    '|---|---|---|---|',
    ...rows,
    '',
    `You may additionally CREATE new ${createOnlyDescription}. Every other path`,
    'in the repository is frozen for this harness and is enforced twice — as',
    'an allowlist before anything is written, and by the guard in CI.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// (6) Context size — an estimate cheap enough to run before spending a call
// ---------------------------------------------------------------------------

// Screenshots don't map cleanly from base64 byte count to vision tokens,
// but this is the right order of magnitude for a typical captured PNG —
// precise enough for what this estimate is for: catching "this clearly
// will not fit", not billing.
const IMAGE_TOKENS_EACH = 1500;

/**
 * A synchronous, dependency-light estimate of how large the
 * suggestion-stage prompt will be. Deliberately approximate — this exists
 * to run cheaply during a reachability probe, before any candidate model
 * has been spent a real call on, not to reproduce the exact prompt.
 *
 * Used to compare against a candidate model's advertised context window
 * before the real suggest call: a model that plainly cannot fit this
 * payload is better dropped here, with a clear reason, than discovered
 * five minutes into a call that then times out or gets truncated
 * mid-response — see harness/lib/probe-models.mjs's checkContextFit().
 *
 * This is the assembler: it composes whichever blocks the caller supplies
 * pre-built text for, plus an image count, rather than calling every
 * builder above itself — the builders above have different configuration
 * needs (a generations dir, a test-file list, a purposes map), and forcing
 * them all through one config shape here would either hide those
 * differences or reinvent them. A caller (eventually the orchestrator)
 * calls the builders it wants, then passes the results here.
 *
 * @param {{blocks?: Record<string, string|null|undefined>, imageCount?: number}} [opts]
 */
export function estimateContextSize({ blocks = {}, imageCount = 0 } = {}) {
  const breakdown = {};
  let textChars = 0;
  for (const [name, text] of Object.entries(blocks)) {
    const chars = (text ?? '').length;
    breakdown[`${name}Chars`] = chars;
    textChars += chars;
  }

  const estimatedTokens = Math.round(textChars / 4) + imageCount * IMAGE_TOKENS_EACH;

  return { ...breakdown, textChars, imageCount, estimatedTokens };
}

// ---------------------------------------------------------------------------
// (7) How ambitious this generation may be
// ---------------------------------------------------------------------------

/**
 * Did this generation merge on its first attempt? Prefers the attempt
 * record, and falls back to the proposal — generations from before
 * attempts.json existed still merged, and reading them as failures would
 * hold the ceiling down for a reason that is an artefact of the tooling
 * rather than of the work.
 */
function landedCleanly(repoRoot, generationsDir, dir) {
  const raw = read(repoRoot, `${generationsDir}/${dir}/attempts.json`);
  if (raw) {
    try {
      const record = JSON.parse(raw);
      return record.outcome === 'approved' && (record.attempts ?? []).length === 1;
    } catch {
      // Fall through to the proposal.
    }
  }

  const proposal = read(repoRoot, `${generationsDir}/${dir}/proposal.md`);
  if (!proposal) return false;
  return summariseProposal(proposal).attempts === '1';
}

/**
 * Did any model even produce a proposal this generation? `outcome:
 * 'no-proposal'` means every asked model failed before writing one — a
 * wrong API endpoint, a dropped connection. That is vendor/network
 * flakiness, not a code-quality signal, and treating it like a real
 * reviewed-and-rejected attempt would silently suppress the
 * ambitious-scope unlock for every generation downstream over something
 * that was never about code quality. `outcome: 'abandoned'` (a real
 * proposal, implemented, never approved after retries) still counts
 * against the unlock — that IS a code-quality signal.
 */
function hadRealProposal(repoRoot, generationsDir, dir) {
  const raw = read(repoRoot, `${generationsDir}/${dir}/attempts.json`);
  if (!raw) return true; // pre-attempts.json generations: assume a real attempt
  try {
    return JSON.parse(raw).outcome !== 'no-proposal';
  } catch {
    return true;
  }
}

/**
 * Earn the headroom, or spend it. The ceiling moves with the evidence: a
 * run of generations that merged on the first attempt buys one ambitious
 * generation; anything less keeps the loop conservative. Deliberately not
 * a random or rotating schedule — the trigger is competence.
 *
 * @param {{repoRoot?: string, generationsDir?: string, required?: number}} [opts]
 */
export function recommendScope({ repoRoot = process.cwd(), generationsDir = DEFAULT_GENERATIONS_DIR, required = 2 } = {}) {
  const all = generationDirs(repoRoot, generationsDir)
    .filter((dir) => hadRealProposal(repoRoot, generationsDir, dir));

  if (all.length < required) {
    return {
      scope: 'focused',
      reason: `only ${all.length} generation(s) with a real proposal on record; ${required} clean ones unlock ambitious scope`,
    };
  }

  const recent = all.slice(-required);
  const clean = recent.filter((dir) => landedCleanly(repoRoot, generationsDir, dir));

  if (clean.length === required) {
    return {
      scope: 'ambitious',
      reason: `the last ${required} generations each merged on the first attempt`,
    };
  }

  return {
    scope: 'focused',
    reason: `${clean.length} of the last ${required} generations merged on the first attempt`,
  };
}

export const __testing = { summariseProposal, landedCleanly, hadRealProposal, generationDirs };
