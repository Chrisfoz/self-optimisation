#!/usr/bin/env node

/**
 * The escalation ledger — what models are not allowed to change, but think
 * the project should. Ported from carrotgame's scripts/lib/escalations.mjs
 * (the reference implementation) essentially unchanged: this file was
 * already fully generic. The only thing that moved is where "the repo
 * root" and "where the ledger lives" come from — module-level constants
 * computed from this file's own location, now caller-supplied parameters
 * defaulting to `process.cwd()`, the same convention every other harness
 * script uses (a portable script can't assume it's running from inside a
 * fixed repo layout).
 *
 * The agent brief, the workflow, the tests and the edit format are frozen
 * for the pipeline, enforced twice (the allowlist in edit-format.mjs and
 * the guard in CI). That constraint is not negotiable and is not being
 * relaxed here: a loop that can rewrite its own gates has no gates.
 *
 * But "you may not change it" and "you may not have an opinion about it"
 * are different rules, and only the first one is load-bearing. A proposal
 * may open an ESCALATION: a specific, argued case for changing something it
 * cannot touch. Escalations are:
 *
 *   1. recorded permanently here, one entry per idea, never overwritten;
 *   2. shown back to every future model, which may back one or argue against it;
 *   3. escalated to the project's owner once enough models independently
 *      agree — CONSENSUS below.
 *
 * Nothing here changes a single line of the pipeline on its own. The ledger
 * is a queue for a human decision, and the human's answer is written back
 * into the entry so the loop stops re-litigating a question that has been
 * settled.
 *
 * Why the threshold spans labs: with a multi-model fan-out, several models
 * are asked in the same run. Three agreeing models from one family is a
 * shared prior; three across two labs is a signal.
 */

import fs from 'fs';
import path from 'path';

/** Default location, relative to a project's root. Override via `ledgerPath` on loadLedger/saveLedger, or `memory.escalation_ledger` in project-adapter.yml. */
export const DEFAULT_LEDGER_PATH = 'docs/escalations/ledger.json';

/**
 * What "the models agree" means before a human is interrupted.
 *
 * `models` counts DISTINCT model ids across all generations, so one model
 * restating its own case every month never reaches the bar on its own.
 * `labs` counts distinct providers among those models.
 */
export const CONSENSUS = { models: 3, labs: 2 };

/** Statuses a human sets. Anything not `open`/`flagged` is settled. */
export const RESOLVED_STATUSES = new Set(['accepted', 'declined', 'superseded']);

const TARGETS = new Set(['agent-brief', 'pipeline', 'hard-constraint', 'other']);

const MAX_TITLE = 140;
const MAX_CASE = 4000;
const MAX_NOTE = 800;

const clamp = (text, max) => String(text ?? '').trim().slice(0, max);

const isNone = (text) => !text || /^\(?none\)?\.?$/i.test(String(text).trim());

export const slugify = (title) =>
  String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

// ---------------------------------------------------------------------------
// Reading and writing the ledger
// ---------------------------------------------------------------------------

export function emptyLedger() {
  return {
    version: 1,
    // Written into the file so the rule is legible to whoever opens it next,
    // rather than only living in this module.
    consensus: { ...CONSENSUS },
    howToResolve:
      'A human decides. Set "status" to "accepted" or "declined", add a ' +
      '"resolution" sentence, and commit. Resolved entries are still shown to ' +
      'future models — with your answer — so the same case is not re-argued.',
    escalations: [],
  };
}

export function loadLedger({ repoRoot = process.cwd(), ledgerPath = DEFAULT_LEDGER_PATH } = {}) {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, ledgerPath), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.escalations)) return emptyLedger();
    return { ...emptyLedger(), ...parsed };
  } catch {
    return emptyLedger();
  }
}

export function saveLedger(ledger, { repoRoot = process.cwd(), ledgerPath = DEFAULT_LEDGER_PATH } = {}) {
  const absolute = path.join(repoRoot, ledgerPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
  return ledgerPath;
}

// ---------------------------------------------------------------------------
// Parsing a proposal's escalation fields
// ---------------------------------------------------------------------------

/**
 * A labelled block, from its label to the next ALL-CAPS label or edit block.
 *
 * Same forgiving shape as the edit-format parser: this feeds a human
 * decision, and a mangled field is worth more than a dropped one.
 */
function field(text, label) {
  const start = text.search(new RegExp(`^${label}:`, 'im'));
  if (start === -1) return '';
  const rest = text.slice(start).replace(new RegExp(`^${label}:[ \\t]*`, 'i'), '');
  const end = rest.search(/^(?:[A-Z][A-Z ]{2,}:|<<<(?:EDIT|CREATE)>>>)/m);
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

const normaliseTarget = (raw) => {
  const value = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  if (TARGETS.has(value)) return value;
  if (/brief|prompt/.test(value)) return 'agent-brief';
  if (/pipeline|workflow|harness|script|test/.test(value)) return 'pipeline';
  if (/constraint|rule/.test(value)) return 'hard-constraint';
  return 'other';
};

/**
 * Ids named on a SUPPORT or DISSENT line, with whatever reasoning followed.
 *
 * Deliberately loose about the separator: models write "esc-001 — because…",
 * "esc-001, esc-003: both…" and "ESC-1" with equal confidence.
 */
function parseReferences(raw) {
  if (isNone(raw)) return [];
  const ids = [...String(raw).matchAll(/esc-(\d+)/gi)].map(
    (m) => `esc-${String(Number(m[1])).padStart(3, '0')}`
  );
  if (ids.length === 0) return [];

  // Everything after the last id is the argument; models put it there.
  const lastId = String(raw).toLowerCase().lastIndexOf(ids[ids.length - 1].toLowerCase());
  const note = clamp(
    String(raw).slice(lastId + ids[ids.length - 1].length).replace(/^[\s—–\-:,.]+/, ''),
    MAX_NOTE
  );

  return [...new Set(ids)].map((id) => ({ id, note }));
}

/**
 * What one proposal said about the parts of the system it may not edit.
 * Pure: no filesystem, no ledger. Returns nulls and empty arrays when
 * silent, which is the common and entirely acceptable case.
 */
export function parseEscalation(text) {
  const source = String(text ?? '');
  const title = field(source, 'ESCALATION');
  const body = field(source, 'ESCALATION CASE');

  const opened =
    isNone(title) || isNone(body)
      ? null
      : {
          title: clamp(title.split('\n')[0], MAX_TITLE),
          target: normaliseTarget(field(source, 'ESCALATION TARGET')),
          case: clamp(body, MAX_CASE),
        };

  return {
    opened,
    supports: parseReferences(field(source, 'ESCALATION SUPPORT')),
    dissents: parseReferences(field(source, 'ESCALATION DISSENT')),
  };
}

// ---------------------------------------------------------------------------
// Consensus
// ---------------------------------------------------------------------------

const distinct = (list, key) =>
  [...new Set(list.map((s) => String(s[key] ?? '').trim().toLowerCase()).filter(Boolean))];

/** How close an entry is to the bar, and whether it has cleared it. */
export function consensusOf(entry, threshold = CONSENSUS) {
  const supporters = entry.supporters ?? [];
  const models = distinct(supporters, 'model');
  const labs = distinct(supporters, 'provider');
  return {
    models: models.length,
    labs: labs.length,
    modelIds: models,
    labIds: labs,
    reached: models.length >= threshold.models && labs.length >= threshold.labs,
  };
}

const nextId = (ledger) => {
  const highest = (ledger.escalations ?? []).reduce((max, e) => {
    const n = Number(String(e.id ?? '').match(/(\d+)/)?.[1] ?? 0);
    return n > max ? n : max;
  }, 0);
  return `esc-${String(highest + 1).padStart(3, '0')}`;
};

const already = (list, model, generation) =>
  (list ?? []).some(
    (s) =>
      String(s.model).toLowerCase() === String(model).toLowerCase() &&
      String(s.generation) === String(generation)
  );

/**
 * Fold one generation's proposals into the ledger.
 *
 * `entries` is one item per model that was asked — including the models
 * whose proposals lost the ranking. A losing proposal's opinion about the
 * brief is worth exactly as much as the winner's, and this is the only
 * place that is true of anything in this pipeline.
 *
 * Pure with respect to the filesystem: it takes a ledger and returns a new
 * one, so the caller decides when to write. Returns what changed, because a
 * notifier needs to know what crossed the line in THIS run rather than what
 * is flagged in general.
 */
export function recordRound({ generation, date, entries, ledger, threshold = CONSENSUS }) {
  const next = { ...ledger, escalations: (ledger.escalations ?? []).map((e) => ({ ...e })) };
  const day = date ?? new Date().toISOString().slice(0, 10);

  const opened = [];
  const supported = [];
  const dissented = [];

  const findBySlug = (slug) =>
    next.escalations.find((e) => e.slug === slug && !RESOLVED_STATUSES.has(e.status));
  const findById = (id) => next.escalations.find((e) => e.id === id);

  for (const entry of entries ?? []) {
    const { model, provider, parsed } = entry;
    if (!parsed) continue;

    // A new case. An identical title against a live entry is treated as
    // backing it rather than as a duplicate — models that independently
    // reach the same conclusion should add up, not fill the ledger with
    // near-copies.
    if (parsed.opened) {
      const slug = slugify(parsed.opened.title);
      const existing = findBySlug(slug);

      if (existing) {
        if (!already(existing.supporters, model, generation)) {
          existing.supporters.push({
            generation, date: day, model, provider,
            note: clamp(parsed.opened.case, MAX_NOTE),
          });
          supported.push({ id: existing.id, model, provider });
        }
      } else {
        const created = {
          id: nextId(next),
          slug,
          title: parsed.opened.title,
          target: parsed.opened.target,
          status: 'open',
          opened: { generation, date: day, model, provider },
          case: parsed.opened.case,
          // The opener counts as the first supporter: one model raising it
          // is one model backing it, and the consensus maths should say so.
          supporters: [{ generation, date: day, model, provider, note: '' }],
          dissenters: [],
          flagged: null,
          resolution: null,
        };
        next.escalations.push(created);
        opened.push({ id: created.id, title: created.title, model, provider });
      }
    }

    for (const ref of parsed.supports) {
      const target = findById(ref.id);
      // A model cannot back its own case twice, and cannot back one that a
      // human has already settled.
      if (!target || RESOLVED_STATUSES.has(target.status)) continue;
      if (already(target.supporters, model, generation)) continue;
      target.supporters.push({ generation, date: day, model, provider, note: ref.note });
      supported.push({ id: target.id, model, provider });
    }

    for (const ref of parsed.dissents) {
      const target = findById(ref.id);
      if (!target || RESOLVED_STATUSES.has(target.status)) continue;
      if (already(target.dissenters, model, generation)) continue;
      target.dissenters.push({ generation, date: day, model, provider, note: ref.note });
      dissented.push({ id: target.id, model, provider });
    }
  }

  // Flagging happens once. The transition is stored, so a later run that
  // adds a fourth supporter does not notify a second time about the same
  // idea — only a human moving it out of `flagged` closes it.
  const flagged = [];
  for (const entry of next.escalations) {
    if (entry.status !== 'open') continue;
    const consensus = consensusOf(entry, threshold);
    if (!consensus.reached) continue;
    entry.status = 'flagged';
    entry.flagged = {
      generation,
      date: day,
      models: consensus.modelIds,
      labs: consensus.labIds,
    };
    flagged.push(entry);
  }

  return { ledger: next, opened, supported, dissented, flagged };
}

// ---------------------------------------------------------------------------
// The prompt section
// ---------------------------------------------------------------------------

const line = (entry, threshold) => {
  const c = consensusOf(entry, threshold);
  return `${c.models}/${threshold.models} model(s) across ${c.labs}/${threshold.labs} lab(s)`;
};

/**
 * What earlier models asked for, rendered for the next one's prompt.
 *
 * This is the mechanism that turns a suggestion box into a vote: a model
 * cannot agree with a case it has never seen. Kept compact — titles, the
 * argument, who is behind it and who is against it — because the decision
 * it informs is one line of the response.
 */
export function buildEscalationBrief(ledger, { threshold = CONSENSUS } = {}) {
  const all = ledger?.escalations ?? [];
  if (all.length === 0) return null;

  const live = all.filter((e) => !RESOLVED_STATUSES.has(e.status));
  const settled = all.filter((e) => RESOLVED_STATUSES.has(e.status));

  const blocks = [];

  for (const entry of live) {
    const lines = [
      `### ${entry.id} — ${entry.title}`,
      `- Target: ${entry.target} · Status: ${entry.status} · Backing: ${line(entry, threshold)}`,
      `- Raised by \`${entry.opened?.model}\` (${entry.opened?.provider}) in generation ${entry.opened?.generation}`,
      `- Case: ${entry.case}`,
    ];
    const backers = (entry.supporters ?? []).slice(1);
    if (backers.length) {
      lines.push(
        `- Also backed by: ${backers.map((s) => `\`${s.model}\` (${s.provider}, gen ${s.generation})`).join(', ')}`
      );
    }
    for (const d of entry.dissenters ?? []) {
      lines.push(`- Argued against by \`${d.model}\` (${d.provider}, gen ${d.generation}): ${d.note || 'no reason given'}`);
    }
    if (entry.status === 'flagged') {
      lines.push('- This one has reached the bar and is with the project\'s owner for a decision.');
    }
    blocks.push(lines.join('\n'));
  }

  for (const entry of settled) {
    blocks.push(
      `### ${entry.id} — ${entry.title}\n` +
      `- **${entry.status.toUpperCase()} by the project's owner.** ${entry.resolution ?? ''}\n` +
      `- Do not raise this again unless you have an argument the decision did not consider.`
    );
  }

  return [
    'These are cases earlier models made for changing something no model is',
    'allowed to edit. You can add to this: back one by id, argue against one by',
    'id, or open a new one. Backing an existing case is worth more than opening a',
    `near-duplicate — ${threshold.models} distinct models across ${threshold.labs} labs sends it to a human for a decision.`,
    '',
    ...blocks,
  ].join('\n');
}

/** One flagged entry, as the plain text of an owner-facing notification. */
export function renderForNotification(entry, { threshold = CONSENSUS } = {}) {
  const c = consensusOf(entry, threshold);
  const backers = (entry.supporters ?? []).map(
    (s) => `  - ${s.model} (${s.provider}, generation ${s.generation})${s.note ? `\n      ${s.note}` : ''}`
  );
  const against = (entry.dissenters ?? []).map(
    (s) => `  - ${s.model} (${s.provider}, generation ${s.generation})${s.note ? `\n      ${s.note}` : ''}`
  );

  return [
    `${entry.id} — ${entry.title}`,
    `Target: ${entry.target}`,
    `Raised by: ${entry.opened?.model} (${entry.opened?.provider}), generation ${entry.opened?.generation}`,
    `Agreement: ${c.models} distinct models across ${c.labs} labs (${c.labIds.join(', ')})`,
    '',
    'The case:',
    entry.case,
    '',
    'Backed by:',
    ...(backers.length ? backers : ['  (none)']),
    ...(against.length ? ['', 'Argued against by:', ...against] : []),
  ].join('\n');
}

export const __testing = { field, parseReferences, normaliseTarget, isNone, already, nextId };
