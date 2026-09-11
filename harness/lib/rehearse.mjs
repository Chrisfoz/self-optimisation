/**
 * Which generation number a local rehearsal (harness/scripts/rehearse.mjs)
 * takes next. Delegates to harness/lib/generation-id.mjs, the same function
 * the generated workflow's numbering step uses (via
 * harness/scripts/next-generation.mjs), so a locally rehearsed generation
 * and a CI-run one number themselves the same way.
 *
 * Kept as its own export because rehearse.mjs and its tests import it from
 * here. It used to read `gen-*` tags only — which only the autonomous-merge
 * path ever creates, so every pull-request-path generation was 001.
 */

import { nextGenerationNumber as next } from './generation-id.mjs';

/**
 * @param {(...args: string[]) => string} git  Injectable git command
 *   runner, same convention as guard.mjs/promote.mjs/rollback.mjs.
 * @param {{generationsDir?: string, baseRef?: string|null}} [opts]
 * @returns {string} the next generation number, zero-padded (e.g. "001").
 */
export function nextGenerationNumber(git, opts = {}) {
  return next(git, opts);
}
