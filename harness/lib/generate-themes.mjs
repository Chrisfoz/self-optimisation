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
 * @param {string} projectDescription  One sentence describing what's being
 *   improved, e.g. "an autonomous pipeline that lets newly-released AI
 *   models propose one improvement at a time to two children's browser
 *   games, gated by code review and tests."
 */
export function buildThemesSystemPrompt(projectDescription) {
  return `You are reviewing ten generations of ${projectDescription}

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
