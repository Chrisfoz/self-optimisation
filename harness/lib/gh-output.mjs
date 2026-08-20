#!/usr/bin/env node

/**
 * Writing to GITHUB_OUTPUT. Ported verbatim from the reference
 * implementation — already fully generic, nothing GitHub-specific about
 * the values it writes, only the file format.
 *
 * `key=value` only works for single-line values. A multi-line value written
 * that way is silently truncated at the first newline — which is how a
 * review verdict turns into an empty string downstream. Anything with a
 * newline needs the heredoc form instead.
 */

import fs from 'fs';

export function setOutput(name, value) {
  const target = process.env.GITHUB_OUTPUT;
  const text = String(value ?? '');
  // The delimiter must not appear in the value or the block ends early.
  const delimiter = `__GHOUT_${Math.random().toString(36).slice(2, 10)}__`;
  const line = text.includes('\n')
    ? `${name}<<${delimiter}\n${text}\n${delimiter}\n`
    : `${name}=${text}\n`;

  if (target) fs.appendFileSync(target, line);
  else console.error(`[output] ${name}=${text.split('\n')[0]}`);
}

/** Collapse to a single line, for values that must use the `key=value` form. */
export function oneLine(text, max = 100) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}
