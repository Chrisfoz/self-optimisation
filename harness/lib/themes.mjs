#!/usr/bin/env node

/**
 * Recurring themes — the abstraction the raw generation history never
 * states. Ported from carrotgame's scripts/lib/themes.mjs (the reference
 * implementation), read side only — see generate-themes.mjs for the
 * write-side prompt/parse logic.
 *
 * Generation history gives every suggesting model a sliding window of what
 * happened: which model proposed what, which attempts were rejected and
 * why. That is association-level data — the same shape a human would get
 * from reading ten bug reports in a row. It never states the principle
 * underneath them, so a new model has to rediscover the same pattern from
 * scratch every ten generations, forever, or not at all.
 *
 * Every N generations (a themes-review cadence, project-configurable), a
 * model is asked to read that same window and name the abstraction rather
 * than the association — not "what happened" but "what does the fact that
 * these things kept happening actually mean." The result is stored one file
 * per review; this module is the read side: it finds the latest one and
 * formats it for the suggestion-stage prompt, the same role escalations.mjs
 * plays for the escalation ledger.
 *
 * The distinction is from "Association Is Not Abstraction": association is
 * noticing that things co-occur; abstraction is naming the principle that
 * explains why. See learning/01-principles.md's "20e" for the full note.
 */

import fs from 'fs';
import path from 'path';

/** Default location, relative to a project's root. Override via `themesDir`, or `memory.themes_review.dir` in project-adapter.yml. */
export const DEFAULT_THEMES_DIR = 'docs/themes';

/**
 * The highest-numbered review-NNN.json in the themes directory, parsed — or
 * null if none exists yet (true until the first themes-review cadence
 * boundary is reached).
 */
export function loadLatestThemesReview({ repoRoot = process.cwd(), themesDir = DEFAULT_THEMES_DIR } = {}) {
  const absolute = path.join(repoRoot, themesDir);
  let files;
  try {
    files = fs.readdirSync(absolute);
  } catch {
    return null;
  }

  const reviews = files
    .filter((f) => /^review-\d+\.json$/.test(f))
    .sort();

  if (!reviews.length) return null;

  const latest = reviews[reviews.length - 1];
  try {
    return JSON.parse(fs.readFileSync(path.join(absolute, latest), 'utf8'));
  } catch (err) {
    // A malformed file on disk should not take the suggestion stage down
    // with it — it should just mean this run gets no themes section, same
    // as if the directory did not exist. The problem is visible in git
    // blame either way.
    console.error(`⚠️  Could not parse ${latest}: ${err.message}`);
    return null;
  }
}

/**
 * Which generations already have a themes review on disk, as the padded
 * numbers in their filenames.
 *
 * Read from the filenames rather than by opening each file: the filename is
 * what `loadLatestThemesReview()` sorts on, so it is the thing that must be
 * unique, and a review whose `throughGeneration` disagreed with its own
 * filename would be a different bug from the one this guards against.
 *
 * Returns `[]` for a directory that doesn't exist yet — the normal state of
 * a project that has never reached a cadence boundary.
 */
export function reviewedGenerations({ repoRoot = process.cwd(), themesDir = DEFAULT_THEMES_DIR } = {}) {
  let files;
  try {
    files = fs.readdirSync(path.join(repoRoot, themesDir));
  } catch {
    return [];
  }
  return files
    .map((f) => f.match(/^review-(\d+)\.json$/)?.[1])
    .filter(Boolean)
    .sort();
}

/**
 * Format a review for the suggestion-stage prompt. Returns null to drop the
 * section entirely when there is nothing to show yet.
 */
export function buildThemesBrief(review) {
  if (!review || !Array.isArray(review.themes) || !review.themes.length) return null;

  const lines = review.themes.map(
    (t, i) => `${i + 1}. Noticed: ${t.noticed}\n   Means: ${t.means}`
  );

  return (
    `As of generation ${review.throughGeneration} (${review.date}), the last themes review ` +
    `found these recurring patterns — not technical specifics, but what the pattern of changes ` +
    `is actually evidence of. Treat these as standing context, the way you would a lesson already ` +
    `learned, not as something to re-derive:\n\n${lines.join('\n\n')}`
  );
}

export const __testing = { DEFAULT_THEMES_DIR };
