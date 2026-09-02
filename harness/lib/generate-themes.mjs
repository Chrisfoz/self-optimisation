#!/usr/bin/env node

/**
 * Pure logic for a themes review: the prompt, and parsing/validating what
 * comes back. Ported from carrotgame's scripts/lib/generate-themes.mjs
 * (the reference implementation). Split from any CLI that actually calls a
 * model — same reasoning as probe-models.mjs and llm-provider.mjs's
 * callModelWithHeadroom: pure functions can be unit tested against fixed
 * strings, without a live API call.
 *
 * Genericised in one place: the reference implementation's system prompt
 * named "two children's browser games" directly. buildThemesSystemPrompt()
 * takes a `projectDescription` instead — see
 * examples/carrotgame/project-adapter.yml's `project.id` for where that
 * text would come from in a real installation, or just write a sentence
 * describing what the reviewed generations changed.
 */

/**
 * Zero-pad a generation number the way the rest of the harness does.
 *
 * `loadLatestThemesReview()` picks the newest review by sorting filenames
 * lexicographically, so `review-9.json` would sort after `review-10.json`
 * and a project would silently keep reading a stale review forever. Padding
 * is therefore not cosmetic: it is what makes that sort correct. Three
 * digits matches the workflow's own `printf '%03d'` for `gen-NNN`; a
 * number wider than that keeps its own width rather than being truncated.
 *
 * @param {string|number} genNumber
 * @returns {string}
 */
export function padGeneration(genNumber) {
  const digits = String(genNumber).trim().replace(/^gen-/, '');
  if (!/^\d+$/.test(digits)) {
    throw new Error(`Not a generation number: ${JSON.stringify(genNumber)}`);
  }
  // Strip existing leading zeros first, so '0020', '020' and '20' are one
  // generation rather than three — the caller may be handing us a filename,
  // an environment variable, or a number.
  return digits.replace(/^0+(?=\d)/, '').padStart(3, '0');
}

/** The filename a review covering `genNumber` is written to. */
export function themesReviewFilename(genNumber) {
  return `review-${padGeneration(genNumber)}.json`;
}

/**
 * Is a themes review due after this generation?
 *
 * Pure on purpose — the caller does the directory read and passes what it
 * found, so every branch of this decision is testable without a filesystem.
 *
 * Due when the generation lands on a cadence boundary and no review already
 * covers it. `force` overrides the boundary (a first run, or a backfill)
 * but NOT the "already covered" check: re-reviewing a generation that has
 * already been reviewed would either overwrite a real review with a second
 * opinion or, worse, quietly produce two files claiming the same window.
 * A caller that genuinely wants to redo one deletes the file first, which
 * is a visible act.
 *
 * A cadence check cheap enough to run after every generation is better than
 * a second schedule to keep in sync with the first.
 *
 * @param {object} opts
 * @param {string|number} opts.genNumber  The generation just completed.
 * @param {number} opts.cadence  `memory.themes_review.cadence_generations`.
 * @param {boolean} [opts.force]  FORCE_REVIEW.
 * @param {string[]} [opts.reviewed]  Generation numbers already covered by
 *   a review on disk, in any padding.
 * @returns {{due: boolean, reason: string}}  `reason` is written to be
 *   printed as-is: this runs every generation and says nothing most of the
 *   time, so the one line it does print has to explain itself.
 */
export function isThemesReviewDue({ genNumber, cadence, force = false, reviewed = [] } = {}) {
  let padded;
  try {
    padded = padGeneration(genNumber);
  } catch {
    return { due: false, reason: `GEN_NUMBER is not a generation number (${JSON.stringify(genNumber)}); nothing to review.` };
  }

  const covered = new Set(reviewed.map((g) => {
    try { return padGeneration(g); } catch { return String(g); }
  }));
  if (covered.has(padded)) {
    return { due: false, reason: `A themes review already covers generation ${padded}.` };
  }

  if (force) {
    return { due: true, reason: `FORCE_REVIEW is set — reviewing through generation ${padded} regardless of cadence.` };
  }

  if (!Number.isFinite(cadence) || cadence < 1) {
    return { due: false, reason: `No usable themes-review cadence configured (memory.themes_review.cadence_generations); set one, or use FORCE_REVIEW.` };
  }

  const n = Number(padded);
  if (n % cadence !== 0) {
    const next = (Math.floor(n / cadence) + 1) * cadence;
    return { due: false, reason: `Not a cadence boundary: generation ${padded}, cadence ${cadence}. Next review at generation ${String(next).padStart(padded.length, '0')}.` };
  }

  return { due: true, reason: `Generation ${padded} is a cadence boundary (every ${cadence}).` };
}

/**
 * The review object written to `<themesDir>/review-NNN.json`.
 *
 * `throughGeneration` and `date` are what `buildThemesBrief()` already
 * reads back. `windowSize`, `model` and `provider` are recorded because a
 * later comparison of two reviews needs to know they read *different*
 * windows — a theme that survives a second, differently-sized window is
 * evidence of something a theme restated from the same window is not (see
 * docs/curiosity/C7-memory-consolidation.md).
 */
export function buildThemesReview({ throughGeneration, windowSize, model, provider, themes, date = new Date() }) {
  return {
    version: 1,
    throughGeneration: padGeneration(throughGeneration),
    date: (date instanceof Date ? date.toISOString() : String(date)).slice(0, 10),
    windowSize,
    model,
    provider,
    themes,
  };
}

/**
 * @param {string} projectDescription  One sentence describing what's being
 *   improved, e.g. "an autonomous pipeline that lets newly-released AI
 *   models propose one improvement at a time to two children's browser
 *   games, gated by code review and tests."
 * @param {number} [windowSize]  How many generations are actually in the
 *   history below. Defaulted to ten because that was the reference
 *   implementation's cadence and its prompt said so literally — but a
 *   project on a cadence of 5, or a first review with only 3 generations
 *   on record, must not be told it is reading ten. A model asked to
 *   compare ten things when it has three will pad to reach the count, and
 *   padding is exactly what the rest of this prompt is trying to prevent.
 */
export function buildThemesSystemPrompt(projectDescription, windowSize = 10) {
  const count = Number.isFinite(windowSize) && windowSize > 0 ? windowSize : 10;
  return `You are reviewing ${count} generation${count === 1 ? '' : 's'} of ${projectDescription}

Your job is not to summarise what happened. A list of "gen 003 did X, gen 007 did Y" is already available to everyone — that is association: noticing that things occurred. You are asked for abstraction: the principle that explains WHY they occurred, that is not stated in any single generation's record but is visible once you compare several.

The distinction, from "Association Is Not Abstraction": apples falling, books falling and tennis balls falling are three observations — association links them. Gravity is not present in any one of them; it is the explanatory construct inferred from comparing all three. That is abstraction.

Read the generation history below. Find 2 to 4 real patterns — not technical trivia — but the kind of thing that is only visible by comparing generations, and that changes how the next generation should be read. Prefer patterns that are surprising, load-bearing, or that connect generations nobody would otherwise think to connect. If you cannot find a genuine one, it is better to return fewer than to pad the count.

For each theme, give:
NOTICED: the concrete, specific observation — cite generation numbers. This is the association: what keeps co-occurring.
MEANS: the principle it points to. This is the abstraction: why it happens, stated so it transfers to generations that have not happened yet. Do not just restate NOTICED in other words — if MEANS could be produced by a thesaurus pass over NOTICED, it is not an abstraction.

Respond in EXACTLY this format, with nothing before the first THEME line or after the last MEANS line:

THEME 1
NOTICED: <text>
MEANS: <text>

THEME 2
NOTICED: <text>
MEANS: <text>

(repeat for up to 4 themes total)`;
}

export function buildThemesUserPrompt(historyText, throughGeneration) {
  return `# Generation history through ${throughGeneration}

${historyText}

Find the recurring themes across these generations.`;
}

/**
 * Parse a THEME/NOTICED/MEANS response into { themes: [{noticed, means}] }.
 * Throws with a specific reason on anything malformed — this harness fails
 * closed on model output (see edit-format.mjs), and a themes review is
 * permanent standing context for every future generation, so a bad one is
 * worse than none.
 */
export function parseThemesResponse(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Empty response — nothing to parse.');
  }

  const blocks = text
    .split(/^THEME\s+\d+\s*$/m)
    .map((b) => b.trim())
    .filter(Boolean);

  if (!blocks.length) {
    throw new Error('No "THEME n" blocks found in the response.');
  }
  if (blocks.length > 4) {
    throw new Error(`${blocks.length} themes returned; the cap is 4.`);
  }

  const themes = blocks.map((block, i) => {
    const noticed = block.match(/^NOTICED:\s*([\s\S]*?)(?:\nMEANS:|$)/m)?.[1]?.trim();
    const means = block.match(/^MEANS:\s*([\s\S]*)$/m)?.[1]?.trim();

    if (!noticed) throw new Error(`Theme ${i + 1} is missing a NOTICED field.`);
    if (!means) throw new Error(`Theme ${i + 1} is missing a MEANS field.`);
    if (noticed.length < 15) throw new Error(`Theme ${i + 1}'s NOTICED is too short to be a real observation.`);
    if (means.length < 15) throw new Error(`Theme ${i + 1}'s MEANS is too short to be a real principle.`);

    return { noticed, means };
  });

  if (themes.length < 2) {
    throw new Error(`Only ${themes.length} theme(s) parsed; at least 2 are required.`);
  }

  return { themes };
}
