#!/usr/bin/env node

/**
 * The independent reviewer — the gate between an unattended run and a
 * project's main branch. Ported from carrotgame's scripts/invoke-code-review.mjs
 * (the reference implementation), genericised the same way stage 1's prompt
 * is: the reviewer's brief is project-supplied content
 * (harness/templates/reviewer-brief.md.tmpl, filled in once per project),
 * not a hardcoded system prompt baked into this file.
 *
 * Pinned to one model on purpose, unlike the suggestion stage. The
 * suggestion stage deliberately rotates onto whichever model was just
 * released; this gate does not. It is the thing standing between an
 * unattended job and the main branch, so it stays on a model whose
 * behaviour is already characterised.
 *
 * Visual capture (rendering the working tree and attaching screenshots to
 * the review call) is an OPTIONAL, project-supplied hook — see
 * `captureVisual` below — not a dependency of this file. carrotgame's own
 * visual-check.mjs, and the incident that produced it (a warning ring
 * stroked across the character's own face — correct code, every suite
 * green, unreadable to a child), is real and worth reading
 * (learning/03-failure-modes.md, "A review gate that had never been shown
 * a picture"), but it's canvas-specific. A project with no visual surface
 * reviews on the diff and full source alone, same as this file's default.
 */

import fs from 'fs';
import path from 'path';
import { callModelWithHeadroom } from './llm-provider.mjs';

/** The default "no visual capture configured" result — the honest default this file ships with. */
async function noVisualCapture() {
  return { available: false, reason: 'no visual capture configured for this project', images: [] };
}

/** Format a visual-capture result for the review prompt. */
function describeVisual(visual) {
  if (!visual.available) {
    return `### Visual check\nNot available (${visual.reason}). You are reviewing the diff and source only — say so in the Visual line rather than guessing at rendered appearance.`;
  }
  return `### Visual check\n${visual.images.length} screenshot(s) attached: ${visual.images.map((i) => i.label).join(', ')}${visual.reason ? ` (${visual.reason})` : ''}. Judge what these actually show, not what the code intends.`;
}

/**
 * Review a set of applied edits.
 *
 * @param {object} opts
 * @param {string} opts.reviewerBrief  The project's filled-in reviewer
 *   brief content (see harness/templates/reviewer-brief.md.tmpl) — this
 *   becomes the system prompt in full. Required; a review gate with no
 *   brief has no criteria to reject against.
 * @param {string} opts.genLabel       A label for this run, e.g. "generation 001".
 * @param {string} opts.diff           Rendered edits — edit-format.mjs's renderForReview().
 * @param {string[]} [opts.filesChanged]  Repo-relative paths, for full-source context.
 * @param {string} [opts.repoRoot]
 * @param {string} [opts.testDescription]  A short description of what must
 *   still pass, e.g. the project's `evaluation.test_commands` joined into
 *   prose. Optional — omitted from the prompt when not supplied, rather
 *   than inventing suite names.
 * @param {() => Promise<{available: boolean, images: Array, reason?: string}>} [opts.captureVisual]
 *   Project-supplied visual-capture hook. Defaults to a no-op that reports
 *   unavailable — see noVisualCapture() above.
 * @param {string} [opts.reviewModel]  Default 'claude-opus-5', matching the
 *   reference implementation's own pinned choice — a reasonable default
 *   for a gate a project hasn't configured yet, not a mandate.
 * @param {number} [opts.maxTokens]  Default 16000 — sized to carry several
 *   screenshots' worth of images plus a page-long verdict; see the
 *   reference implementation's own incident (generation 018) for why this
 *   isn't 8000.
 * @param {typeof callModelWithHeadroom} [opts.call]  Injectable, defaults
 *   to the real callModelWithHeadroom — tests substitute a fake so this
 *   never needs a live API call.
 * @returns {Promise<{approved: boolean, verdict: string, reason: string, feedback: string, raw: string, visual: object}>}
 */
export async function reviewChanges({
  reviewerBrief,
  genLabel,
  diff,
  filesChanged = [],
  repoRoot = process.cwd(),
  testDescription = null,
  captureVisual = noVisualCapture,
  reviewModel = 'claude-opus-5',
  maxTokens = 16000,
  call = callModelWithHeadroom,
}) {
  if (!reviewerBrief || !reviewerBrief.trim()) {
    throw new Error('reviewChanges() requires a non-empty reviewerBrief — a review gate with no brief has no criteria to reject against.');
  }

  const visual = await captureVisual();

  const sources = filesChanged
    .map((relative) => {
      const absolute = path.join(repoRoot, relative);
      if (!fs.existsSync(absolute)) return '';
      return `\n### ${relative} (current content, after the edits)\n\`\`\`\n${fs.readFileSync(absolute, 'utf8')}\n\`\`\``;
    })
    .join('\n');

  const user = `## Review request — ${genLabel}

### The edits that were applied

\`\`\`
${diff}
\`\`\`

### Full source of every touched file
${sources || '(no files reported as changed — treat this as a rejection)'}
${testDescription ? `\n### What must still pass\n${testDescription}\n` : ''}
${describeVisual(visual)}

Review the change and give your verdict.`;

  const result = await call({
    model: reviewModel,
    system: reviewerBrief,
    user,
    maxTokens,
    images: visual.images,
  });

  const raw = result.text;
  const verdictMatch = raw.match(/^VERDICT:\s*(APPROVED|REJECTED)/im);
  // Absent or unparseable verdict is a rejection: this gate fails closed.
  const approved = verdictMatch?.[1]?.toUpperCase() === 'APPROVED';

  return {
    approved,
    verdict: approved ? 'approved' : 'rejected',
    reason: raw.match(/^REASON:\s*(.+)$/im)?.[1]?.trim() ?? '',
    feedback: raw,
    raw,
    // Handed back so a rejected attempt can be shown what it actually
    // rendered — the closest a single-shot implementation call gets to
    // "render it, look at it, try again".
    visual,
  };
}
