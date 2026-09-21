#!/usr/bin/env node

/**
 * Targeted search/replace edit format — the bounded patch executor. Ported
 * from carrotgame's scripts/lib/edit-format.mjs (the reference
 * implementation). The parsing and application mechanics are unchanged
 * character-for-character; what's genericised is the allowlist, which used
 * to be a module-level constant (`EDITABLE_FILES`) and is now supplied by
 * the caller from a project's adapter config — see
 * examples/carrotgame/project-adapter.yml's `constitution.allowed_paths`
 * and `constitution.create_only_paths`.
 *
 * HARD CONSTRAINT, unchanged from the reference implementation: improvements
 * are applied as targeted edits — exact old-string / new-string pairs —
 * never as whole rewritten files.
 *
 * Why this is non-negotiable:
 *   - A real source file can be tens of thousands of output tokens. A
 *     whole-file rewrite either hits the output cap and silently truncates,
 *     or drifts somewhere in the middle. Either way a working file is
 *     overwritten with a broken one and committed by an unattended job.
 *   - A search/replace pair is a few hundred tokens, so cost and latency
 *     stay flat regardless of how large the target files grow.
 *   - The unique-match requirement is self-verifying: if the file has moved
 *     on since the model read it, the edit fails loudly instead of landing
 *     in the wrong place.
 *   - The resulting diff is small enough for the review stage to reason
 *     about.
 *
 * See learning/06-starter-kit.md §3 for the format given to the implementer
 * verbatim, and learning/01-principles.md principles 7 and 8 for why each
 * rule below exists.
 */

import fs from 'fs';
import path from 'path';
import { globToRegExp, isGlob, expandGlob } from './glob.mjs';

const EDIT_BLOCK = /<<<EDIT>>>[ \t]*\r?\nFILE:[ \t]*(.+?)[ \t]*\r?\n<<<SEARCH>>>[ \t]*\r?\n([\s\S]*?)\r?\n<<<REPLACE>>>[ \t]*\r?\n([\s\S]*?)\r?\n<<<END>>>/g;

const CREATE_BLOCK = /<<<CREATE>>>[ \t]*\r?\nFILE:[ \t]*(.+?)[ \t]*\r?\n<<<CONTENT>>>[ \t]*\r?\n([\s\S]*?)\r?\n<<<END>>>/g;

const FIELD = (name) => new RegExp(`^${name}:[ \\t]*(.+)$`, 'im');

const normalise = (filePath) => filePath.replace(/\\/g, '/').replace(/^\.\//, '');
const isTraversal = (p) => p.includes('..') || path.isAbsolute(p);

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

/**
 * Compile a project's editable/creatable path config (from its adapter, e.g.
 * `constitution.allowed_paths` and `constitution.create_only_paths`) into a
 * shape isEditable/isCreatable/applyEdits can check quickly.
 *
 * This is the single point every list downstream should derive from —
 * carrotgame's own history is the reason why: `EDITABLE_FILES` used to be
 * three separate literals (this one, plus one deciding what got snapshotted
 * between attempts, plus one deciding what the prompt contained), and a file
 * could be editable but never shown to the model for months before anyone
 * noticed. Compile once, pass the result everywhere.
 *
 * @param {object} config
 * @param {string[]} [config.allowedPaths]     Editable file paths. An entry
 *   containing `*` is a pattern; anything else is an exact path.
 * @param {(string|RegExp)[]} [config.createOnlyPaths]  Glob strings (or raw
 *   RegExp, for parity with a hand-written pattern) a CREATE block may
 *   target — only at a path that does not already exist.
 */
export function compileAllowlist({ allowedPaths = [], createOnlyPaths = [] } = {}) {
  // The pattern slot below was reserved from the start and left empty:
  // "a project with a directory of similarly-shaped source files plausibly
  // will [need one]". It does now. A project that outgrows one file cannot
  // enumerate every module by hand in YAML, and an allowlist nobody can keep
  // current is worse than a pattern — it drifts, and the drift is silent.
  //
  // Whoever populates this must also expand the same patterns wherever the
  // editable list becomes prompt context. A file the agent may edit is a file
  // the agent must have read; a pattern that widens editing without widening
  // the source bundle recreates exactly the incident that rule exists for.
  // See expandEditablePaths() below, which is the one way to do that.
  const exact = allowedPaths.filter((p) => !isGlob(p));
  const patterns = allowedPaths.filter((p) => isGlob(p));
  return {
    editableExact: new Set(exact.map(normalise)),
    editablePatterns: patterns.map((p) => globToRegExp(p)),
    creatablePatterns: createOnlyPaths.map((p) => (p instanceof RegExp ? p : globToRegExp(p))),
  };
}

/**
 * Turn `constitution.allowed_paths` into the concrete files that exist right
 * now: exact entries pass through, patterns expand against the working tree.
 *
 * Every caller that treats the editable list as *content* — the source
 * bundle, the inter-attempt snapshot, anything that reads the files — must
 * go through this rather than the raw adapter list. Passing a pattern
 * straight to a reader silently drops it (`read()` returns null for
 * "game/**"), which would let a model edit a file it was never shown. That
 * is the failure `learning/04-context-recipe.md` records, and a pattern-based
 * surface is the easiest way to reintroduce it.
 *
 * @param {string[]} allowedPaths
 * @param {{repoRoot?: string}} [opts]
 * @returns {string[]} existing relative paths, de-duplicated, stable order
 */
export function expandEditablePaths(allowedPaths = [], { repoRoot = process.cwd() } = {}) {
  const out = [];
  for (const p of allowedPaths) {
    if (isGlob(p)) out.push(...expandGlob(p, { repoRoot }));
    else out.push(p);
  }
  return [...new Set(out)];
}

/** Is this path one the agent is allowed to edit in place? */
export function isEditable(filePath, allowlist) {
  const normalised = normalise(filePath);
  if (isTraversal(normalised)) return false;
  if (allowlist.editableExact.has(normalised)) return true;
  return allowlist.editablePatterns.some((re) => re.test(normalised));
}

/** Is this path one the agent is allowed to create from scratch? */
export function isCreatable(filePath, allowlist) {
  const normalised = normalise(filePath);
  if (isTraversal(normalised)) return false;
  return allowlist.creatablePatterns.some((re) => re.test(normalised));
}

// ---------------------------------------------------------------------------
// Format spec
// ---------------------------------------------------------------------------

/**
 * Build the format spec injected into the implementation prompt, so it lives
 * in one place per project rather than being retyped. The mechanical
 * contract (block markers, the four numbered SEARCH/REPLACE rules) is
 * unchanged from the reference implementation and should stay that way —
 * see learning/06-starter-kit.md §3, "give this to the implementer
 * verbatim, and parse it with code rather than trusting it." What's
 * parameterised is the project-specific parts: which extra metadata field
 * the response must carry beyond SUMMARY/RATIONALE (carrotgame requires
 * PILLAR — "which quality dimension this strengthens" — but a project with
 * no such taxonomy can omit it), the safety framing named in the rationale
 * requirement, and whether a CREATE surface exists at all.
 *
 * @param {object} [opts]
 * @param {{name: string, description: string}} [opts.extraField]  An extra
 *   required metadata field between SUMMARY and RATIONALE, e.g.
 *   `{name: 'PILLAR', description: 'which game design pillar this strengthens'}`.
 * @param {string} [opts.safetyFraming]  Appended to the RATIONALE line's
 *   description, e.g. "and why it is safe for ages 3-8". Defaults to a
 *   generic phrase.
 * @param {{pathDescription: string, examplePath: string}} [opts.createSection]
 *   If present, documents an optional CREATE block for the given
 *   create-only surface. Omit entirely for a project with no such surface.
 * @param {boolean} [opts.blocksOnly]  Emit only the edit-block contract, not
 *   the "Respond in EXACTLY this format" header and its SUMMARY/RATIONALE
 *   fields. For a prompt that already defines the response's structure. The
 *   suggestion stage is one: it had both this header in its system prompt
 *   and SUGGEST_RESPONSE_FORMAT in its user prompt, two structures each
 *   claiming to be the only one, and models padded their answers to satisfy
 *   both. A suggesting model escalated it in the first external install
 *   (docs/campaigns/2026-09-17-networkinai-install.md).
 */
export function buildEditFormatSpec({
  extraField = null,
  safetyFraming = 'and why it is safe to ship unattended',
  createSection = null,
  blocksOnly = false,
} = {}) {
  const extraFieldLine = extraField
    ? `${extraField.name}: <${extraField.description}>\n`
    : '';

  const createBlock = createSection
    ? `

To add a NEW file (optional, and only for a brand new path):

<<<CREATE>>>
FILE: ${createSection.examplePath}
<<<CONTENT>>>
<the complete file>
<<<END>>>

5. CREATE may only add ${createSection.pathDescription}, and only at a path
   that does not exist yet. Existing files matching this pattern are
   append-only and cannot be modified through CREATE.`
    : '';

  const header = blocksOnly
    ? `Edit blocks, one or more:`
    : `Respond in EXACTLY this format. No other structure is accepted.

SUMMARY: <one line, imperative, max 80 chars — becomes the commit message>
${extraFieldLine}RATIONALE: <2-4 sentences: why this change, why now, ${safetyFraming}>

Then one or more edit blocks:`;

  return `${header}

<<<EDIT>>>
FILE: <path from the editable list>
<<<SEARCH>>>
<exact text copied verbatim from the file, including indentation>
<<<REPLACE>>>
<the replacement text>
<<<END>>>

Rules for edit blocks — these are enforced by a parser, not read by a human:
1. The SEARCH text must appear EXACTLY ONCE in the target file. Copy it
   character for character, including leading whitespace. If a snippet would be
   ambiguous, include more surrounding context until it is unique.
2. Do NOT output the whole file. Do NOT abbreviate with "..." or
   "// rest unchanged". Every SEARCH block must be literal, complete text that
   exists in the file right now.
3. Keep the change focused: one improvement, as few edit blocks as it takes.
4. Do not wrap the edit blocks in markdown code fences.${createBlock}`;
}

/**
 * Pull the metadata fields, edit blocks and create blocks out of a response.
 * Parsing never touches the filesystem — see applyEdits for that.
 *
 * @param {string} response
 * @param {string[]} [extraFieldNames]  Names of any extra metadata fields
 *   beyond SUMMARY/RATIONALE to extract (e.g. `['PILLAR']`), matching
 *   whatever was passed to buildEditFormatSpec's `extraField`.
 */
export function parseResponse(response, extraFieldNames = []) {
  const clean = (s) => s.trim().replace(/^`|`$/g, '');

  const edits = [];
  for (const match of response.matchAll(EDIT_BLOCK)) {
    edits.push({ file: clean(match[1]), search: match[2], replace: match[3] });
  }

  const creates = [];
  for (const match of response.matchAll(CREATE_BLOCK)) {
    creates.push({ file: clean(match[1]), content: match[2] });
  }

  const extra = {};
  for (const name of extraFieldNames) {
    extra[name.toLowerCase()] = response.match(FIELD(name))?.[1]?.trim() ?? '';
  }

  return {
    summary: response.match(FIELD('SUMMARY'))?.[1]?.trim() ?? '',
    rationale: response.match(FIELD('RATIONALE'))?.[1]?.trim() ?? '',
    ...extra,
    edits,
    creates,
  };
}

/**
 * Locate `search` in `content`, tolerating a CRLF/LF mismatch between the
 * checked-out file and what the model emitted.
 * Returns the search string as it actually appears in the file, or null.
 */
function reconcileLineEndings(content, search) {
  if (content.includes(search)) return search;
  const asCrlf = search.replace(/\r?\n/g, '\r\n');
  if (content.includes(asCrlf)) return asCrlf;
  const asLf = search.replace(/\r\n/g, '\n');
  if (content.includes(asLf)) return asLf;
  return null;
}

/**
 * Validate and apply edits.
 *
 * Every edit is validated against in-memory content for all files BEFORE
 * anything is written, so one bad edit in a set cannot leave the tree half
 * modified. Multiple edits to the same file apply in order.
 *
 * @param {Array} edits
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {ReturnType<typeof compileAllowlist>} opts.allowlist
 * @param {boolean} [opts.dryRun]
 * @param {Array} [opts.creates]
 * @param {string} [opts.createDescription]  Human-readable description of
 *   what CREATE may target, used only in error messages (e.g. "new
 *   tests/game-logic/*.test.js files"). Defaults to a generic phrase.
 * @returns {{applied: Array, errors: string[], filesChanged: string[]}}
 */
export function applyEdits(edits, { repoRoot, allowlist, dryRun = false, creates = [], createDescription = 'files matching the create-only pattern' } = {}) {
  const errors = [];
  const applied = [];
  const staged = new Map(); // relative path -> pending content
  const created = new Map(); // relative path -> new file content

  if (edits.length === 0 && creates.length === 0) {
    return { applied, errors: ['No edit blocks found in the response.'], filesChanged: [] };
  }

  for (const [index, create] of creates.entries()) {
    const label = `create ${index + 1} (${create.file})`;

    if (!isCreatable(create.file, allowlist)) {
      errors.push(`${label}: "${create.file}" cannot be created. Only ${createDescription} may be added.`);
      continue;
    }
    if (fs.existsSync(path.join(repoRoot, create.file))) {
      errors.push(`${label}: file already exists. Existing files in this pattern are append-only.`);
      continue;
    }
    if (created.has(create.file)) {
      errors.push(`${label}: the same path is created twice in one response.`);
      continue;
    }
    if (create.content.trim() === '') {
      errors.push(`${label}: CONTENT block is empty.`);
      continue;
    }

    created.set(create.file, create.content.endsWith('\n') ? create.content : create.content + '\n');
    applied.push({ file: create.file, removedLines: 0, addedLines: create.content.split('\n').length });
  }

  for (const [index, edit] of edits.entries()) {
    const label = `edit ${index + 1} (${edit.file})`;

    if (!isEditable(edit.file, allowlist)) {
      errors.push(`${label}: "${edit.file}" is not in the editable allowlist.`);
      continue;
    }

    const absolute = path.join(repoRoot, edit.file);
    if (!staged.has(edit.file)) {
      if (!fs.existsSync(absolute)) {
        errors.push(`${label}: file does not exist.`);
        continue;
      }
      staged.set(edit.file, fs.readFileSync(absolute, 'utf8'));
    }

    const content = staged.get(edit.file);

    if (edit.search.trim() === '') {
      errors.push(`${label}: SEARCH block is empty. Edits must target existing text.`);
      continue;
    }

    const needle = reconcileLineEndings(content, edit.search);
    if (needle === null) {
      errors.push(
        `${label}: SEARCH text not found. It must be copied verbatim from the ` +
        `current file. First line was: ${JSON.stringify(edit.search.split('\n')[0].slice(0, 80))}`
      );
      continue;
    }

    const occurrences = content.split(needle).length - 1;
    if (occurrences > 1) {
      errors.push(
        `${label}: SEARCH text appears ${occurrences} times — it must be unique. ` +
        `Include more surrounding context.`
      );
      continue;
    }

    const replacement = needle.includes('\r\n')
      ? edit.replace.replace(/\r?\n/g, '\r\n')
      : edit.replace;

    staged.set(edit.file, content.replace(needle, replacement));
    applied.push({
      file: edit.file,
      removedLines: needle.split('\n').length,
      addedLines: replacement.split('\n').length,
    });
  }

  // All-or-nothing: a partially applied improvement is worse than none.
  if (errors.length > 0) {
    return { applied: [], errors, filesChanged: [] };
  }

  if (!dryRun) {
    for (const [relative, content] of staged) {
      fs.writeFileSync(path.join(repoRoot, relative), content, 'utf8');
    }
    for (const [relative, content] of created) {
      const absolute = path.join(repoRoot, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content, 'utf8');
    }
  }

  return { applied, errors, filesChanged: [...staged.keys(), ...created.keys()] };
}

/** Render edits as a diff for the review stage, the proposal record and the log. */
export function renderForReview({ summary, rationale, edits, creates = [], ...extra }) {
  const blocks = edits.map((edit, i) => {
    const minus = edit.search.split('\n').map((l) => `- ${l}`).join('\n');
    const plus = edit.replace.split('\n').map((l) => `+ ${l}`).join('\n');
    return `--- Edit ${i + 1}: ${edit.file} ---\n${minus}\n${plus}`;
  });

  for (const [i, create] of creates.entries()) {
    const body = create.content.split('\n').map((l) => `+ ${l}`).join('\n');
    blocks.push(`--- New file ${i + 1}: ${create.file} ---\n${body}`);
  }

  const extraLines = Object.entries(extra)
    .filter(([, v]) => typeof v === 'string' && v !== '')
    .map(([k, v]) => `${k.toUpperCase()}: ${v}`);

  return [
    `SUMMARY: ${summary}`,
    ...extraLines,
    `RATIONALE: ${rationale}`,
    '',
    ...blocks,
  ].join('\n');
}
