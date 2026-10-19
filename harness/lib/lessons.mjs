/**
 * Lessons: what earlier generations established about this project, one
 * addressable record each, anchored to the files it concerns.
 *
 * The generation history carries full detail for the last few runs only, and
 * the themes review rewrites itself whole every N generations — which is the
 * pattern Agentic Context Engineering warns erases useful detail. A lesson
 * instead:
 *
 *   - is derived from the records, never written by a model, so it can be
 *     rebuilt from them at any time (updateLessons() is idempotent);
 *   - is deduplicated, and counts how often and in which generations it was
 *     seen, rather than repeating;
 *   - is anchored to the hashes of the files it concerns AND of the files
 *     those import, at the time it was first seen — a change to either makes
 *     it STALE, and a stale lesson leaves the prompt until it is seen again;
 *   - is a CANDIDATE until evidence beyond one model's opinion supports it:
 *     the same failure in two different generations, or a person's verdict
 *     (a merge, a close, a revert). A plausible explanation never silently
 *     becomes project policy.
 *
 * Kept in `<generationsDir>/lessons.json`, so the steps that already commit
 * the records commit it too.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { oneLine } from './gh-output.mjs';
import { extractImports, resolveImport } from './code-map.mjs';
import { loadRecords } from './report.mjs';
import { fenceUntrusted } from './context-pack.mjs';

export const LESSONS_FILE = 'lessons.json';
export const DEFAULT_LESSONS_MAX_CHARS = 6000;

const FAILURE_OUTCOMES = new Set(['rejected-by-review', 'tests-failed', 'review-insufficient-context']);

/** Strip what varies between two sightings of the same failure: numbers, paths' line refs, quoting. */
export function lessonKey(kind, files, text) {
  const norm = String(text ?? '').toLowerCase()
    .replace(/\b(gen(eration)?[- #]?\d+|attempt \d+|line \d+|:\d+(:\d+)?)\b/g, '')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/[`'"*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return `${kind}|${[...files].sort().join(',')}|${norm}`;
}

const fateOf = (record) => {
  if (record?.reverted) return 'reverted';
  const state = record?.pullRequest?.state;
  if (state === 'merged' || state === 'closed' || state === 'open') return state;
  return null;
};

/**
 * Observations from one generation's record: each failed attempt, and the
 * shipped change with what a person later did with it.
 */
export function observationsFrom(record) {
  const generation = String(record.generation ?? '');
  // A failed attempt is about the files as they were when it was tried —
  // the commit the run started from — not as a later approved attempt in the
  // same run left them.
  const baseCommit = record.provenance?.baseCommit ?? null;
  const out = [];
  for (const a of record.attempts ?? []) {
    if (!FAILURE_OUTCOMES.has(a.outcome) || !a.files?.length) continue;
    const what = a.outcome === 'tests-failed' ? "failed the project's tests"
      : a.outcome === 'review-insufficient-context' ? 'could not be judged by the reviewer from what it was shown'
      : 'was rejected by review';
    out.push({
      kind: 'failure',
      files: a.files,
      text: `A change to ${a.files.join(', ')} ${what}: ${oneLine(a.detail ?? '', 300)}`,
      keyText: `${a.outcome} ${a.detail ?? ''}`,
      generation,
      verdict: null,
      anchorCommit: baseCommit,
    });
  }
  const approved = (record.attempts ?? []).find((a) => a.outcome === 'approved');
  if (record.outcome === 'approved' && approved?.files?.length) {
    const fate = fateOf(record);
    const summary = oneLine(record.proposalSummary || approved.detail || '', 200);
    if (fate === 'closed' || fate === 'reverted') {
      out.push({
        kind: 'failure',
        files: approved.files,
        text: `A person ${fate === 'closed' ? 'closed without merging' : 'reverted'} an approved change to ${approved.files.join(', ')}: ${summary}${record.reverted?.reason ? ` — ${oneLine(record.reverted.reason, 200)}` : ''}`,
        keyText: `${fate} ${summary}`,
        generation,
        verdict: fate,
      });
    } else {
      out.push({
        kind: 'success',
        files: approved.files,
        text: `An approved change to ${approved.files.join(', ')}${fate === 'merged' ? ', merged by a person' : ''}: ${summary}`,
        keyText: summary,
        generation,
        verdict: fate === 'merged' ? 'merged' : null,
      });
    }
  }
  return out;
}

/**
 * Fold every record into the ledger. Idempotent: the same records produce
 * the same ledger, so a lost or corrupted file is rebuilt by running this
 * on an empty one (anchors are then taken at rebuild time).
 *
 * @param {{lessons?: object[]}} prior
 * @param {object[]} records          report.mjs's loadRecords().records
 * @param {{hashOf: (file: string) => string|null, depsOf?: (file: string) => string[], commit?: string|null, date?: string}} deps
 */
export function updateLessons(prior, records, { hashOf, hashAt = null, statusHashOf = hashOf, depsOf = () => [], commit = null, date = new Date().toISOString().slice(0, 10) }) {
  const lessons = (prior?.lessons ?? []).map((l) => ({ ...l, evidence: [...(l.evidence ?? [])] }));
  const byKey = new Map(lessons.map((l) => [l.key, l]));
  let next = lessons.reduce((m, l) => Math.max(m, Number(String(l.id).replace(/\D/g, '')) || 0), 0);

  const anchor = (files, at = null) => {
    const h = (f) => (at && hashAt ? hashAt(f, at) ?? hashOf(f) : hashOf(f));
    const deps = [...new Set(files.flatMap((f) => depsOf(f)))].filter((d) => !files.includes(d));
    return {
      files: Object.fromEntries(files.map((f) => [f, h(f)])),
      dependencies: Object.fromEntries(deps.map((d) => [d, h(d)])),
    };
  };

  for (const record of records) {
    for (const o of observationsFrom(record)) {
      const key = lessonKey(o.kind, o.files, o.keyText);
      let lesson = byKey.get(key);
      if (!lesson) {
        next += 1;
        lesson = { id: `L-${String(next).padStart(4, '0')}`, key, kind: o.kind, statement: o.text, status: 'candidate', firstSeen: date, sourceCommit: o.anchorCommit ?? commit, ...anchor(o.files, o.anchorCommit), evidence: [] };
        lessons.push(lesson);
        byKey.set(key, lesson);
      }
      const seen = lesson.evidence.find((e) => e.generation === o.generation);
      if (seen) { if (o.verdict) seen.verdict = o.verdict; } else lesson.evidence.push({ generation: o.generation, verdict: o.verdict });
      // A failure seen again after its files changed is current again:
      // re-anchor to what the files are now.
      if (!seen && statusOf(lesson, statusHashOf) === 'stale') Object.assign(lesson, anchor(o.files, o.anchorCommit), { sourceCommit: o.anchorCommit ?? commit });
    }
  }

  for (const l of lessons) l.status = statusOf(l, statusHashOf);
  return { version: 1, lessons };
}

/**
 * candidate → verified on independent evidence; anything → stale when an
 * anchored file or dependency changed; superseded is set by a person and
 * kept.
 */
export function statusOf(lesson, hashOf) {
  if (lesson.status === 'superseded') return 'superseded';
  const anchored = { ...(lesson.files ?? {}), ...(lesson.dependencies ?? {}) };
  if (Object.entries(anchored).some(([f, h]) => hashOf(f) !== h)) return 'stale';
  const generations = new Set(lesson.evidence.map((e) => e.generation));
  const personSaid = lesson.evidence.some((e) => e.verdict && e.verdict !== 'open');
  if (personSaid || (lesson.kind === 'failure' && generations.size >= 2)) return 'verified';
  return 'candidate';
}

/** Mark a lesson superseded by another, or by a note. A person's call, never automatic. */
export function supersede(ledger, id, { by = null, note = null } = {}) {
  const lesson = ledger.lessons.find((l) => l.id === id);
  if (!lesson) throw new Error(`no lesson ${id}`);
  lesson.status = 'superseded';
  lesson.supersededBy = by;
  lesson.supersededNote = note;
  return ledger;
}

/**
 * The prompt section: verified lessons first, then candidates, most-seen
 * first, within maxChars. Stale and superseded lessons are counted, not
 * shown. Null when there is nothing current to say.
 */
export function buildLessonsBrief(ledger, { hashOf = null, maxChars = DEFAULT_LESSONS_MAX_CHARS } = {}) {
  const all = ledger?.lessons ?? [];
  if (!all.length) return null;
  const current = all.map((l) => ({ ...l, status: hashOf ? statusOf(l, hashOf) : l.status }));
  const shown = current
    .filter((l) => l.status === 'verified' || l.status === 'candidate')
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'verified' ? -1 : 1) || b.evidence.length - a.evidence.length || String(b.firstSeen).localeCompare(String(a.firstSeen)));
  if (!shown.length) return null;
  const lines = [];
  let used = 0;
  let omitted = 0;
  for (const l of shown) {
    const gens = [...new Set(l.evidence.map((e) => e.generation))];
    const line = `- [${l.id} · ${l.status}${gens.length > 1 ? ` · seen in ${gens.length} generations` : ''}] ${l.statement}`;
    if (used + line.length > maxChars) { omitted += 1; continue; }
    lines.push(line);
    used += line.length + 1;
  }
  const stale = current.filter((l) => l.status === 'stale').length;
  return [
    'VERIFIED lessons are backed by a person\'s verdict or by the same failure in more than one generation. CANDIDATE lessons are one observation: evidence to weigh, not project policy. Every lesson is about the files it names, as they are now; any lesson whose files have changed since is left out.',
    '',
    // The statements quote reviewers' reasons and test output: data.
    fenceUntrusted('LESSONS', [
      ...lines,
      ...(omitted ? [`(${omitted} more lesson(s) not shown, over the ${maxChars}-character budget.)`] : []),
      ...(stale ? [`(${stale} lesson(s) left out as stale: their files have changed since.)`] : []),
    ].join('\n')),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// On disk
// ---------------------------------------------------------------------------

/** Hash and import lookups against the working tree, for updateLessons()/buildLessonsBrief(). */
export function diskLookups(repoRoot) {
  const hashOf = (file) => {
    try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(repoRoot, file))).digest('hex').slice(0, 16); } catch { return null; }
  };
  // resolveImport() asks a Set whether a candidate path exists; this one asks the disk.
  class OnDisk extends Set {
    has(p) { try { return fs.statSync(path.join(repoRoot, p)).isFile(); } catch { return false; } }
  }
  const onDisk = new OnDisk();
  const depsOf = (file) => {
    let source;
    try { source = fs.readFileSync(path.join(repoRoot, file), 'utf8'); } catch { return []; }
    return extractImports(source).map((spec) => resolveImport(file, spec, onDisk)).filter(Boolean);
  };
  const hashAt = (file, commit) => {
    try {
      const bytes = execFileSync('git', ['show', `${commit}:${file}`], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
      return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    } catch { return null; }
  };
  return { hashOf, hashAt, depsOf };
}

export function loadLessons({ repoRoot, generationsDir = 'docs/generations' }) {
  try { return JSON.parse(fs.readFileSync(path.join(repoRoot, generationsDir, LESSONS_FILE), 'utf8')); } catch { return { version: 1, lessons: [] }; }
}

/**
 * Re-derive the ledger from every record and save it. Run after a generation
 * writes its record and after pull-request fates are read back. Writes
 * nothing when no record yields a lesson, so a project's first runs add no
 * file.
 */
export function refreshLessons({ repoRoot, generationsDir = 'docs/generations', commit = null, statusRef = null }) {
  const prior = loadLessons({ repoRoot, generationsDir });
  const { records } = loadRecords({ repoRoot, generationsDir });
  const lookups = diskLookups(repoRoot);
  // The status stored is as of the branch the ledger is committed to. On an
  // agent branch the working tree holds the change, which would mark every
  // lesson about the changed files stale on a branch where they are not.
  const statusHashOf = statusRef ? (f) => lookups.hashAt(f, statusRef) : lookups.hashOf;
  const ledger = updateLessons(prior, records, { ...lookups, statusHashOf, commit });
  if (!ledger.lessons.length) return ledger;
  fs.mkdirSync(path.join(repoRoot, generationsDir), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, generationsDir, LESSONS_FILE), JSON.stringify(ledger, null, 2) + '\n');
  return ledger;
}
