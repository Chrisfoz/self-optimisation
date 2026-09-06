/**
 * The one piece of git bookkeeping harness/scripts/rehearse.mjs needs that
 * is worth a real-git test of its own: which generation number comes next.
 * Mirrors harness/templates/workflow.yml.tmpl's own bash exactly —
 *
 *   last=$(git tag -l 'gen-*' | sed 's/^gen-//' | sort -n | tail -1)
 *   next=$(( ${last:-0} + 1 ))
 *   padded=$(printf '%03d' "$next")
 *
 * — so a locally rehearsed generation and a CI-run one number themselves
 * the same way regardless of which one actually tagged the repository
 * last. Reuses generate-themes.mjs's padGeneration() rather than
 * reimplementing zero-padding a second time.
 */

import { padGeneration } from './generate-themes.mjs';

/**
 * @param {(...args: string[]) => string} git  Injectable git command
 *   runner, same convention as guard.mjs/promote.mjs/rollback.mjs.
 * @returns {string} the next generation number, zero-padded (e.g. "001").
 */
export function nextGenerationNumber(git) {
  const raw = git('tag', '-l', 'gen-*');
  const numbers = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((tag) => Number(tag.replace(/^gen-/, '')))
    .filter((n) => Number.isFinite(n));
  const last = numbers.length ? Math.max(...numbers) : 0;
  return padGeneration(last + 1);
}
