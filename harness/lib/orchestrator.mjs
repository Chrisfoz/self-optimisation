#!/usr/bin/env node

/**
 * The orchestrator — suggest, implement, review, refine, in one process.
 * Composes every other kernel component built this session
 * (llm-provider, edit-format, model-release-detector's sibling probe,
 * context-pack, escalations, themes, guard, adapter) into the actual loop.
 * Ported from carrotgame's scripts/invoke-self-improvement-agent.mjs (the
 * reference implementation, 1,450 lines) — this is real design work, not a
 * 1:1 extraction, for one reason above all others: the reference
 * implementation's prompts are carrotgame's own words, hardcoded as JS
 * template literals (game design pillars, hospital-tablet context, a
 * canvas pixel-math lesson). None of that belongs in a portable harness.
 *
 * The fix is a division of responsibility this file holds to throughout:
 * **the harness owns mechanism, the project owns content.** A project's
 * filled-in `agent-brief.md` (see harness/templates/agent-brief.md.tmpl)
 * IS the suggestion stage's system prompt — not a summary of it, not
 * something this file also duplicates in its own words. This file adds
 * only what's genuinely mechanical and the same shape for any project: the
 * edit-format contract, the response-field structure the parsers expect,
 * and a scope note for the current run. Compare this to the reference
 * implementation's own redundancy — its hardcoded system prompt restates
 * much of what `.claude/agents/self-improvement.md` already says, in
 * different words, because nothing enforced them staying in sync. That
 * redundancy doesn't port forward.
 *
 * Same split for stage 3: `reviewChanges()` (review.mjs) takes the
 * project's filled-in reviewer-brief.md as its entire system prompt.
 *
 * The four stages, unchanged from the reference implementation's design:
 *
 *   Stage 1 — SUGGEST    the rotating seat: whichever model(s) a release
 *                        was just detected for. Returns prose, optionally
 *                        with its own edit blocks.
 *   Stage 2 — IMPLEMENT  a pinned model turns the proposal into targeted
 *                        edits, unless the suggesting model already wrote
 *                        usable ones.
 *   Stage 3 — REVIEW     a pinned model, fresh context, approves or
 *                        rejects with required fixes. Fails closed.
 *   Stage 4 — REFINE     on rejection, back to stage 2 with the feedback,
 *                        up to maxAttempts times, always from a pristine
 *                        tree.
 *
 * This lives in one process, not across separate steps, because a
 * review→refine→review cycle has to be able to loop — the same constraint
 * that shaped the reference implementation (GitHub Actions cannot loop
 * jobs).
 */

import fs from 'fs';
import path from 'path';
import { callModelWithHeadroom, resolveProvider } from './llm-provider.mjs';
import { setOutput, oneLine } from './gh-output.mjs';
import { buildEditFormatSpec, parseResponse, applyEdits, renderForReview } from './edit-format.mjs';
import { reviewChanges } from './review.mjs';
import {
  parseEscalation, parseEscalationReview, recordRound, recordJudgements, resurfaceDue,
  queueWorkOrders, assignWorkOrder, completeWorkOrder, buildWorkOrderBrief,
  buildEscalationReviewField, buildEscalationBrief, loadLedger, saveLedger, renderForNotification,
} from './escalations.mjs';
import { summarizeApiIssues } from './api-errors.mjs';
import { harnessVersion } from './version.mjs';
import { createSpendLedger, withSpend, projectedFanOut } from './spend.mjs';

// ---------------------------------------------------------------------------
// Pure text-processing helpers — ported verbatim, no genericisation needed.
// These operate on response text and field names, never on project content.
// ---------------------------------------------------------------------------

/**
 * Pull a labelled prose block out of a response. Runs from the label to
 * the next ALL-CAPS label, the first edit block, or the end — whichever
 * comes first. Deliberately forgiving: this feeds a human or a parser
 * downstream, and a field that is merely mangled is worth more than one
 * dropped because a model added a stray blank line.
 */
export function extractField(text, label) {
  const start = text.search(new RegExp(`^${label}:`, 'im'));
  if (start === -1) return '';
  const rest = text.slice(start).replace(new RegExp(`^${label}:[ \\t]*`, 'i'), '');
  const end = rest.search(/^(?:[A-Z][A-Z ]{2,}:|<<<(?:EDIT|CREATE)>>>)/m);
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

/**
 * The edits a suggesting model chose to write itself, if it wrote any.
 * Tried before the pinned implementer's own attempts — a model that
 * cannot hit the edit-format contract costs nothing, because the run
 * falls back; a model that can hit it gets to ship its own code.
 */
export function extractDirectEdits(text) {
  const parsed = parseResponse(text);
  if (parsed.edits.length === 0 && parsed.creates.length === 0) return null;
  return parsed;
}

/**
 * Rescue the analysis from a response that hit its output cap even after
 * a headroom retry. `anchorField` is the last field the response format
 * requires before any edit blocks — its presence proves every field
 * before it finished, so everything after it (a partial edit set, half a
 * line of feedback) can be safely cut away. A truncated edit set is
 * exactly the thing this harness refuses to touch (see edit-format.mjs).
 *
 * @param {string} text
 * @param {string} [anchorField]  Default 'VERIFICATION' — matches
 *   SUGGEST_RESPONSE_FORMAT below.
 * @returns {string|null}  Salvaged prose, or null when truncation landed
 *   mid-analysis and there is nothing trustworthy to keep.
 */
export function salvageTruncated(text, anchorField = 'VERIFICATION') {
  if (!new RegExp(`^${anchorField}:`, 'im').test(text)) return null;

  const prose = text
    .replace(/<<<(?:EDIT|CREATE)>>>[\s\S]*$/m, '')
    .trimEnd();

  // A stray SEARCH or REPLACE marker means an edit block began before the
  // regex above could anchor on its opening tag. Refuse rather than guess.
  if (/<<<(?:SEARCH|REPLACE|CONTENT|END)>>>/.test(prose)) return null;

  return `${prose}\n\n[NOTE: this response hit its output limit. The analysis above is complete; any edits the model began writing were discarded.]`;
}

/** The argument only: no edit blocks, no note to the maintainers. Used when a proposal is shown to a different model than the one that wrote it (ranking, or a rejected attempt's context). */
export function forRanking(text) {
  return text
    .replace(/<<<(?:EDIT|CREATE)>>>[\s\S]*$/m, '')
    .replace(/^BRIEF FEEDBACK:[\s\S]*$/im, '')
    .trim();
}

/** Drop a prompt section entirely when its content is missing, rather than sending an empty heading. */
export function section(heading, body) {
  return body ? `\n# ${heading}\n${body}\n` : '';
}

// ---------------------------------------------------------------------------
// The suggestion-stage response format — mechanical, not project-specific.
// Field names match what extractField()/parseEscalation() expect.
// ---------------------------------------------------------------------------

export const SUGGEST_RESPONSE_FORMAT = `Respond in this structure:

PILLAR: <which quality dimension this strengthens>
PROBLEM: <what is weak today, citing the specific code or behaviour you saw>
CHANGE: <precisely what should change — name the functions, constants,
         handlers or markup involved, and describe the new behaviour
         concretely enough that another engineer could implement it
         without guessing>
WHY THIS ONE: <why this beats the other candidates you considered>
RISK: <what could break, and how the change stays backwards compatible>
ALSO UPDATE: <every other place that has to change with it, or "nothing" if
         the change genuinely shows up nowhere else. Be specific: name the
         file and the text.>
VERIFICATION: <what a reviewer should check to confirm it works>
BRIEF FEEDBACK: <REQUIRED, and read by a human rather than a machine. Which
         parts of the brief genuinely helped? Which constrained you for no
         good reason, or pushed you toward a worse answer than you would
         have given unprompted? What would you delete?>
ESCALATION: <REQUIRED, and "none" is a perfectly good answer. One line
         naming a change to something you are not allowed to edit that you
         believe would make this project better.>
ESCALATION TARGET: <agent-brief | pipeline | hard-constraint | none>
ESCALATION CASE: <if you opened one: what is blocked today, exactly what
         should change, what it would unlock, what risk it carries.>
ESCALATION SUPPORT: <none, or the id(s) of open escalations you independently
         agree with, and why.>
ESCALATION DISSENT: <none, or the id of one you think is wrong, and why.>

Then, optionally, the edit blocks implementing your change.`;

/**
 * The committed goal, rendered as the one thing that does not change —
 * above the brief, labelled as such. Null drops it entirely, which is what
 * keeps a project with no goal on the prompt it had before (the
 * byte-identity test). See docs/curiosity/C1-committed-goal.md.
 *
 * Direction plus constraints, never a metric (principle 22b): the reviewer
 * judges alignment to it in prose; nothing scores it.
 *
 * @param {{statement: string, holds?: string[], awayFrom?: string[]}|null} goal
 * @returns {string|null}
 */
export function buildGoalSection(goal) {
  if (!goal || !goal.statement) return null;
  const holds = (goal.holds ?? []).map((h) => `- ${h}`).join('\n');
  const away = (goal.awayFrom ?? []).map((a) => `- ${a}`).join('\n');
  return [
    `# The goal — the one thing in this prompt that does not change`,
    ``,
    `A person committed this project to the following, once. It is frozen: you may argue against it through the ESCALATION fields, and a person may change it; nothing else may. Every proposal is judged against it — a change that is correct, safe and tested but moves the project away from it is a rejection.`,
    ``,
    goal.statement,
    ...(holds ? [``, `What must hold, in every generation:`, holds] : []),
    ...(away ? [``, `What counts as drifting away from it:`, away] : []),
    ``,
  ].join('\n');
}

/**
 * Build the suggestion stage's system prompt. The project's agent brief
 * (in full) IS the prompt — this only adds the two things that vary per
 * run and are the same mechanical shape for any project: which scope this
 * generation may attempt, and the optional edit-format contract. A
 * committed goal, when the project has one, goes ABOVE the brief.
 *
 * @param {object} opts
 * @param {string} opts.agentBrief  Required — the project's filled-in
 *   agent-brief.md content.
 * @param {string} opts.scopeText   e.g. "focused: one small, localised
 *   improvement" or an "ambitious" variant. See buildScopeText() below.
 * @param {string[]} opts.editableFiles
 * @param {string} [opts.createOnlyDescription]
 * @param {number} [opts.suggestMaxTokens]
 */
export function buildSuggestSystemPrompt({ agentBrief, scopeText, editableFiles, createOnlyDescription, suggestMaxTokens = 32000, goal = null }) {
  const editSpec = buildEditFormatSpec({
    createSection: createOnlyDescription
      ? { pathDescription: createOnlyDescription, examplePath: '<a new path matching that pattern>' }
      : null,
  });

  const goalSection = buildGoalSection(goal);
  return `${goalSection ? `${goalSection}\n` : ''}${agentBrief}

# Scope for this generation

${scopeText}

# Implementing it yourself (optional)

You may optionally implement your own proposal. If you do, it is applied
and reviewed exactly as written, and this generation is credited to you as
the implementer. This is entirely optional: a proposal that stands on its
own, with no edits attached, is a complete and acceptable response.

${editSpec}

**Order matters, and so does your output budget.** You have roughly
${suggestMaxTokens.toLocaleString()} tokens. Write the complete analysis
FIRST, then the edit blocks. If you find yourself running long, stop
emitting edit blocks and end cleanly — a complete analysis with no edits is
a good outcome; a truncated response is a wasted one.

You may edit only these files:
${editableFiles.map((f) => `- ${f}`).join('\n')}`;
}

/** Default scope text for the two standard modes. A project may supply its own via config.scopeText instead. */
export const DEFAULT_SCOPE_TEXT = {
  focused: `- ONE focused improvement, not a list. Choose the single highest-value change.
- It must be expressible as a small number of localised edits to existing code.
  Do not propose anything that requires rewriting a file wholesale.`,
  ambitious: `- ONE coherent improvement, but this generation is explicitly allowed to be
  AMBITIOUS. The recent generations all merged cleanly, so there is headroom.
- Structural work is in scope: it may touch several files and several hundred
  lines.
- It must still arrive as targeted edits to existing code — many edits is
  fine, a wholesale file rewrite is not — and it must still be ONE idea
  rather than a collection of small ones.`,
};

/**
 * Build the suggestion stage's user prompt: the context blocks (already
 * assembled, typically by context-pack.mjs's builders) plus the response
 * format instructions.
 *
 * @param {object} opts
 * @param {string} opts.genLabel
 * @param {object} opts.context  Named text blocks — sources, manifest,
 *   testIndex, generationIndex, history, themes, openQuestions,
 *   escalations, feedback, platform, qualityMetrics, runtime, workOrder,
 *   architectureNotes — any
 *   of which may be null/undefined and is dropped from the prompt via
 *   section(). `runtime` is what the last runs actually observed rather than
 *   what the code says (context-pack.mjs's buildRuntimeEvidence()).
 *   `workOrder` is the directive for a generation that has been assigned an
 *   accepted escalation; `escalationReview` is the extra response field a
 *   run needs only when something is actually awaiting judgement. Both are
 *   null on an ordinary run, which is what keeps that run's prompt
 *   byte-identical to one from before either existed.
 *   `qualityMetrics` is what carrotgame's readiness scorecard generalised
 *   into: measured, non-gating dimensions from this project's evaluator
 *   plugins (harness/lib/evaluators.mjs). Null for every project that has
 *   configured none, which drops the section entirely.
 * @param {{images: Array, source: string|null}} [opts.screenshots]
 */
export function buildSuggestUserPrompt({ genLabel, context, screenshots = { images: [], source: null } }) {
  // Provenance, when the caller knows it. The reference implementation told
  // every model these images showed "the current state" while silently
  // serving a stale baseline, because a failed generation created a folder
  // with no screenshots in it and shadowed the last real ones
  // (learning/03-failure-modes.md, "One failed generation hid the current
  // screenshots"). loadVisualEvidence() fixes the selection; saying WHICH
  // generation they came from, and that they show the state this change
  // starts from rather than its result, is the other half — a model told
  // "current" cannot notice it is looking at something old.
  const from = screenshots.source ? ` They were rendered at ${screenshots.source}, so they show the state this change starts from, not its result.` : '';
  const shots = screenshots.images.length
    ? `\n# Screenshots\nThe ${screenshots.images.length} image(s) attached to this message show the current state of the project.${from} Judge visual details from these rather than inferring them from source alone.\n`
    : '';

  return `${genLabel}

# Repository map
${context.manifest ?? ''}
${section('THIS GENERATION HAS BEEN ASSIGNED A DECIDED CHANGE', context.workOrder)}${section('Target platform', context.platform)}${section('Measured quality dimensions — non-gating', context.qualityMetrics)}${section('Frozen test invariants', context.testIndex)}${section('Every generation on record (compact — nothing here is ever dropped)', context.generationIndex)}${section('Most recent generations, in full detail (including what failed)', context.history)}${section('What the last runs actually observed at runtime', context.runtime)}${section('Recurring themes from the last review', context.themes)}${section('Open questions this project has not answered', context.openQuestions)}${section('Open escalations — what earlier models asked us to change', context.escalations)}${section('Player feedback', context.feedback)}${section('How this project is built, and what it has learned building itself', context.architectureNotes)}
${shots}
# Current source
${context.sources ?? ''}

# Your task

${context.workOrder
    ? 'Propose the change the work order above describes. It is not yours to choose; it is yours to specify well.'
    : 'Pick the ONE improvement you would make.'} ${SUGGEST_RESPONSE_FORMAT}${context.escalationReview ? `\n${context.escalationReview}` : ''}`;
}

// ---------------------------------------------------------------------------
// Stage 1 — suggest
// ---------------------------------------------------------------------------

/**
 * Ask one model to suggest an improvement.
 *
 * @param {object} promptConfig  Everything buildSuggestSystemPrompt/buildSuggestUserPrompt need.
 * @param {{id: string, provider: string}} model
 * @param {{call?: typeof callModelWithHeadroom, log?: (msg: string) => void}} [deps]
 */
export async function suggest(promptConfig, model, { call = callModelWithHeadroom, log = () => {} } = {}) {
  const system = buildSuggestSystemPrompt(promptConfig);
  const user = buildSuggestUserPrompt(promptConfig);

  const result = await call({
    model: model.id,
    provider: model.provider,
    system,
    user,
    maxTokens: promptConfig.suggestMaxTokens ?? 32000,
    images: promptConfig.screenshots?.images ?? [],
  });

  if (result.truncated) {
    const salvaged = salvageTruncated(result.text, promptConfig.anchorField);
    if (!salvaged) {
      throw new Error(
        `Response was truncated (stop reason: ${result.stopReason}) before the analysis was complete, so there is nothing usable to implement.`
      );
    }
    log(`   ⚠️  ${model.id} was truncated (${result.stopReason}); analysis was complete, so any partial edits were dropped and the prose kept.`);
    return { ...result, text: salvaged, truncatedButUsable: true };
  }

  log(`   ${result.provider}/${result.model} → ${result.text.length} chars (${result.sentImages} screenshot(s) accepted)`);
  return result;
}

/**
 * Ask every candidate model, in parallel. `allSettled`, not `all`: one lab
 * returning a 500 must not cost the whole generation when other proposals
 * arrived intact.
 */
export async function gatherProposals(promptConfig, models, deps = {}) {
  const log = deps.log ?? (() => {});
  log(`🔍 Stage 1 — asking ${models.length} model(s): ${models.map((m) => m.id).join(', ')}`);

  const settled = await Promise.allSettled(models.map((m) => suggest(promptConfig, m, deps)));

  const proposals = [];
  const failures = [];

  settled.forEach((outcome, i) => {
    const asked = models[i];
    if (outcome.status === 'fulfilled') {
      const text = outcome.value.text;
      const directEdits = extractDirectEdits(text);
      const escalation = parseEscalation(text);
      // Answers to the ESCALATION REVIEW field, if this run asked for any.
      // Empty on every run that didn't, which is most of them.
      const judgements = parseEscalationReview(text);
      proposals.push({
        ...asked,
        result: outcome.value,
        text,
        directEdits,
        briefFeedback: extractField(text, 'BRIEF FEEDBACK'),
        escalation,
        judgements,
      });
      if (escalation.opened) log(`   ${asked.id} opened an escalation: ${escalation.opened.title}`);
      for (const ref of escalation.supports) log(`   ${asked.id} backs ${ref.id}`);
      for (const j of judgements) log(`   ${asked.id} judged ${j.id}: ${j.judgement.toUpperCase()}`);
      if (directEdits) log(`   ${asked.id} also offered ${directEdits.edits.length} edit(s) and ${directEdits.creates.length} new file(s)`);
    } else {
      failures.push({
        ...asked,
        reason: oneLine(outcome.reason?.message ?? String(outcome.reason), 200),
        kind: outcome.reason?.kind ?? null,
        statusCode: outcome.reason?.statusCode ?? null,
      });
      log(`   ⚠️  ${asked.id} produced nothing — ${outcome.reason?.message ?? outcome.reason}`);
    }
  });

  log(`   ${proposals.length} proposal(s), ${failures.length} failure(s)\n`);
  return { proposals, failures };
}

// ---------------------------------------------------------------------------
// Stage 1b — rank
// ---------------------------------------------------------------------------

/**
 * The ranking rubric, by scope. `focused` is the original text, unchanged.
 * `ambitious` exists because the original was one of four places the
 * harness pulled every generation toward the smallest safe change (see
 * docs/Review-SWOT-2026-09.md F1): an ambitious run earns its headroom by
 * shipping cleanly twice, and then had the same rubric pick "a few
 * localised edits" from its fan-out.
 */
export const RANK_RUBRIC = {
  focused: `Judge only on the merit of the change itself:
- How much it improves the outcome the change claims to strengthen
- Whether it is genuinely implementable as a few localised edits
- Whether it risks breaking a frozen test invariant or a stated constraint
- Whether it fixes something real rather than adding decoration

Prefer a fix to something broken over an addition. Prefer a change that helps the common case over one that helps an edge case.`,
  ambitious: `This generation is explicitly AMBITIOUS: the recent generations all merged cleanly, and structural work is in scope. Judge on:
- How much it changes what the project can do or how it works, not how small it is — the smallest proposal is not the default winner here
- Whether it is ONE coherent idea that could be reversed in one revert if it turns out badly, rather than a collection of small ones or a change that quietly rewrites everything
- Whether it risks breaking a frozen test invariant or a stated constraint
- Whether it fixes something real or opens something new that the project's stated purpose actually calls for

Prefer the proposal with the largest genuine effect at an acceptable reversibility. Do not prefer a proposal merely because it is safer or smaller.`,
};

/**
 * Choose which proposal to implement, when more than one exists. The
 * ranker is given proposals with their authors withheld, so it judges the
 * idea rather than the brand — see learning/01-principles.md for the
 * tension this is a deliberate compromise on (one lab's taste decides
 * which lab's idea ships).
 *
 * @param {object} opts
 * @param {string} opts.projectDescription  One sentence, e.g. "a CLI tool
 *   for parsing log files" — used the same way generate-themes.mjs's
 *   buildThemesSystemPrompt() uses it.
 * @param {string} [opts.manifest] @param {string} [opts.testIndex]
 * @param {Array} opts.proposals
 * @param {string} [opts.rankModel]
 * @param {'focused'|'ambitious'} [opts.scope]  The run's scope. The rubric
 *   used to be scope-blind — it preferred "a few localised edits" and "a
 *   fix over an addition" on every run — so an ambitious generation, whose
 *   whole point is structural work, still had its smallest proposal chosen.
 *   Default 'focused', which keeps the prompt byte-identical to before.
 */
export async function rankProposals({ projectDescription, manifest = '', testIndex = null, proposals, rankModel = 'claude-opus-5', scope = 'focused' }, deps = {}) {
  const call = deps.call ?? callModelWithHeadroom;
  const log = deps.log ?? (() => {});

  if (proposals.length === 1) return { index: 0, reason: 'only one proposal' };

  const system = `You are choosing between improvement proposals for ${projectDescription}, written by different frontier models that each looked at the same code.

${RANK_RUBRIC[scope] ?? RANK_RUBRIC.focused}

Respond in EXACTLY this format:
CHOICE: <the number of the winning proposal>
REASON: <one or two sentences on why it beats the others>`;

  const blocks = proposals.map((p, i) => `## Proposal ${i + 1}\n${forRanking(p.text)}`).join('\n\n---\n\n');

  log(`⚖️  Stage 1b — ranking ${proposals.length} proposals with ${rankModel}`);

  let result;
  try {
    result = await call({
      model: rankModel,
      system,
      user: `# Repository map\n${manifest}\n${section('Frozen test invariants', testIndex)}\n# The proposals\n\n${blocks}\n\nWhich single proposal should be implemented?`,
      maxTokens: 2000,
    });
  } catch (err) {
    // Ranking fails safe, and a ranking the budget refused is no different
    // from one that came back unparseable. Any other error keeps its old
    // behaviour and propagates.
    if (err?.kind !== 'budget') throw err;
    log(`   💸 Ranking refused by the budget cap; falling back to the first model.\n`);
    return { index: 0, reason: 'ranking refused by the budget cap — fell back to the first model' };
  }

  const choice = Number(result.text.match(/^CHOICE:\s*(\d+)/im)?.[1]);
  const reason = oneLine(result.text.match(/^REASON:\s*(.+)$/im)?.[1] ?? '', 300);

  // Fail safe rather than closed: an unparseable ranking should not cost
  // the generation, so fall back to the first (typically newest) model.
  if (!Number.isInteger(choice) || choice < 1 || choice > proposals.length) {
    log(`   ⚠️  Ranking returned no usable choice; falling back to the first model.\n`);
    return { index: 0, reason: 'ranking unparseable — fell back to the first model' };
  }

  log(`   → proposal ${choice} from ${proposals[choice - 1].id}: ${reason}\n`);
  return { index: choice - 1, reason };
}

// ---------------------------------------------------------------------------
// Stage 2 / 4 — implement and refine
// ---------------------------------------------------------------------------

/**
 * Build the implementer's system prompt. Deliberately generic and
 * boilerplate-only — the actual constraints already shaped the proposal
 * at stage 1, and stage 3 is the real safety gate; this stage's one job is
 * faithful, minimal implementation.
 */
export function buildImplementSystemPrompt({ editableFiles, createOnlyDescription, implementationNotes = null }) {
  const editSpec = buildEditFormatSpec({
    createSection: createOnlyDescription
      ? { pathDescription: createOnlyDescription, examplePath: '<a new path matching that pattern>' }
      : null,
  });

  return `You are implementing an approved improvement. Another model proposed the change; your job is to apply it faithfully and safely.

You are not redesigning it. If the proposal is ambiguous, choose the smallest, most conservative reading that still delivers the intent.

Keep it focused: implement this improvement and nothing else. No drive-by refactors, no unrelated tidying, no reformatting of untouched code. Match the surrounding code's style, naming and comment density.
${implementationNotes ? `\n${implementationNotes}\n` : ''}
You may only edit these files:
${editableFiles.map((f) => `- ${f}`).join('\n')}

${editSpec}`;
}

/**
 * @param {object} promptConfig
 * @param {string} proposal
 * @param {{applyErrors?: string[], reviewFeedback?: string, rejectedRender?: object, attempt: number, author: string}} state
 */
export async function implement(promptConfig, proposal, { applyErrors, reviewFeedback, rejectedRender, attempt, author }, deps = {}) {
  const call = deps.call ?? callModelWithHeadroom;
  const log = deps.log ?? (() => {});
  const maxAttempts = deps.maxAttempts;

  const system = buildImplementSystemPrompt(promptConfig);
  const invariants = promptConfig.context.testIndex ? `\n# Frozen test invariants\n${promptConfig.context.testIndex}\n` : '';

  let correction = '';
  if (applyErrors) {
    correction = `
# YOUR PREVIOUS ATTEMPT COULD NOT BE APPLIED

${applyErrors.map((e) => `- ${e}`).join('\n')}

The usual cause is a SEARCH block that was not copied verbatim. Check
whitespace and indentation character by character against the source below,
and include more surrounding context where a snippet was ambiguous.
Produce the full corrected set of edit blocks.
`;
  } else if (reviewFeedback) {
    correction = `
# THE PREVIOUS ATTEMPT WAS REJECTED BY REVIEW

${reviewFeedback}

Address the required fixes above. Keep the same core improvement — do not
substitute a different idea. The source below is the ORIGINAL, unmodified
file content: your previous edits have been reverted, so write SEARCH
blocks against what you see here.
`;
  }

  const images = rejectedRender?.available ? rejectedRender.images : [];
  const renderBack = rejectedRender?.available
    ? `
# WHAT YOUR REJECTED ATTEMPT ACTUALLY LOOKED LIKE

The last ${rejectedRender.images.length} image(s) — ${rejectedRender.images.map((i) => i.label).join(', ')} — were
rendered from the working tree your previous edits produced. This is the
change the reviewer saw and turned down. Look at them before you write the
next version.
`
    : '';

  log(`🔧 Stage 2 — implementation on ${promptConfig.implementModel}` + (attempt > 1 ? ` (attempt ${attempt}/${maxAttempts})` : ''));

  const result = await call({
    model: promptConfig.implementModel,
    system,
    user: `${promptConfig.genLabel}

# The proposed improvement, from ${author}
${forRanking(proposal)}
${invariants}
# Current source
${promptConfig.context.sources ?? ''}
${correction}${renderBack}
Implement the proposal above using the required edit format.`,
    maxTokens: 16000,
    images,
  });

  if (result.truncated) {
    throw new Error(`Stage 2 response was truncated (stop reason: ${result.stopReason}) even after a headroom retry. Applying a partial edit set would risk corrupting a working project.`);
  }

  log(`   → ${result.text.length} chars`);
  return result;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * Every attempt a generation made, and how each one ended. Written on
 * success AND on total failure — the failures are the part worth keeping,
 * since the next generation reads this back and can see which ideas
 * already died and why.
 */
export function writeAttemptRecord({ repoRoot, generationsDir = 'docs/generations', genNumber, outcome, suggestResult, proposal, attempts, fanOut, implementedBy, implementModel, scope, escalations, contextSize, apiIssues = [], pullRequestUrl = null, spend = null, campaign = false, seatPromotion = null, run = null }) {
  const dir = path.join(repoRoot, generationsDir, `gen-${genNumber}`);
  fs.mkdirSync(dir, { recursive: true });
  const relative = `${generationsDir}/gen-${genNumber}/attempts.json`;

  const proposalSummary = oneLine(
    proposal?.match(/^CHANGE:\s*(.+)$/im)?.[1] ?? proposal?.split('\n').find((l) => l.trim()) ?? '',
    300
  );

  fs.writeFileSync(
    path.join(repoRoot, relative),
    JSON.stringify(
      {
        generation: genNumber,
        date: new Date().toISOString().slice(0, 10),
        // Which harness wrote this record — provenance for a vendored copy
        // that has no package manifest of its own. See harness/lib/version.mjs.
        harnessVersion: harnessVersion(),
        // Which run wrote this — the workflow run id plus attempt, or a
        // local rehearsal id (harness/lib/generation-id.mjs). The number
        // says where this sits in the sequence; this says which execution
        // it was, so a re-run is never mistaken for the original.
        run: run ?? null,
        outcome,
        scope: scope?.scope ?? null,
        scopeReason: scope?.reason ?? null,
        // True for a generation the owner ran on models named by hand
        // (harness/lib/campaign.mjs) rather than on a detected release.
        // Kept so release-driven history stays distinguishable.
        campaign: Boolean(campaign),
        // Set when the implement seat was filled by a rotating model that
        // earned it (harness/lib/seats.mjs's promotionCandidate()), not the
        // pinned default. Null otherwise.
        seatPromotion: seatPromotion ?? null,
        suggestModel: suggestResult ? `${suggestResult.model} (${suggestResult.provider})` : null,
        fanOut: fanOut ?? null,
        screenshotsSent: suggestResult?.sentImages ?? 0,
        implementModel: implementModel ?? null,
        implementedBy: implementedBy ?? null,
        selfImplemented: Boolean(implementedBy) && implementedBy !== implementModel,
        proposalSummary,
        escalations: escalations ?? null,
        contextSize: contextSize ?? null,
        // What this generation cost, in tokens, per model and per stage —
        // see harness/lib/spend.mjs. Null only for a record written by
        // something other than runGeneration().
        spend: spend ?? null,
        attempts,
        // Actionable API failures only — "you need to fix a key or your
        // billing" — deduplicated by provider+kind. See api-errors.mjs.
        // Everything else a call failed with is still in `attempts`' own
        // detail text; this is a filtered pointer into it, not a replacement.
        apiIssues: apiIssues ?? [],
        // Set later, by recordPullRequestUrl(), once the workflow step
        // downstream of this run has actually opened the PR — this
        // function runs before that exists and cannot know the URL yet.
        pullRequestUrl: pullRequestUrl ?? null,
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  return relative;
}

/**
 * Fill in the one field writeAttemptRecord() cannot know at the time it
 * runs: the pull request. Opening the PR happens in a workflow step
 * downstream of run-generation.mjs (typically an action like
 * peter-evans/create-pull-request, pushing the branch this run left
 * behind) — by the time that step has a URL, attempts.json already exists
 * and this run's process has already exited. So this is a second, tiny
 * write: read the record back, set one field, save it. See
 * harness/scripts/record-pull-request.mjs for the CLI a workflow calls
 * this from.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} [opts.generationsDir]
 * @param {string|number} opts.genNumber
 * @param {string} opts.pullRequestUrl
 * @returns {string} the relative path written
 */
export function recordPullRequestUrl({ repoRoot, generationsDir = 'docs/generations', genNumber, pullRequestUrl }) {
  const relative = `${generationsDir}/gen-${genNumber}/attempts.json`;
  const absolute = path.join(repoRoot, relative);

  let record;
  try {
    record = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (err) {
    throw new Error(
      `Cannot record a pull request URL for generation ${genNumber}: ${relative} doesn't exist or isn't valid JSON. ` +
      `This step runs after run-generation.mjs, which should have written it. (${err.message})`
    );
  }

  record.pullRequestUrl = pullRequestUrl;
  fs.writeFileSync(absolute, JSON.stringify(record, null, 2) + '\n', 'utf8');
  return relative;
}

/**
 * Every proposal the fan-out produced, winners and losers alike, one file
 * each under `gen-NNN/proposals/`. Until this existed only the winner's
 * text survived (in proposal.md); the losers were an id in fanOut.proposed
 * and their argument was gone. The curiosity design (§3.4) is explicit
 * that the four rejected proposals are four different reads of the same
 * repository, and where they diverge is where the repository is ambiguous
 * — and a later compare-two-implementations experiment needs them too.
 * Costs nothing: the fan-out was already paid for.
 *
 * Nothing reads these back into a prompt. The generation index and history
 * read proposal.md and attempts.json only, so the prompt is unchanged.
 *
 * @returns {string[]} the relative paths written
 */
export function writeFanOutProposals({ repoRoot, generationsDir = 'docs/generations', genNumber, proposals }) {
  const dir = path.join(repoRoot, generationsDir, `gen-${genNumber}`, 'proposals');
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const p of proposals) {
    const safe = String(p.id).replace(/[^A-Za-z0-9._-]+/g, '_');
    const relative = `${generationsDir}/gen-${genNumber}/proposals/${safe}.md`;
    fs.writeFileSync(
      path.join(repoRoot, relative),
      `# Generation ${genNumber} — proposal from \`${p.id}\` (${p.provider})\n\n` +
      `Every model asked this generation, not only the one whose proposal was chosen. ` +
      `See attempts.json's fanOut for which one was.\n\n\`\`\`\n${String(p.text).trim()}\n\`\`\`\n`,
      'utf8'
    );
    written.push(relative);
  }
  return written;
}

export function writeProposal({ repoRoot, generationsDir = 'docs/generations', genNumber, proposal, parsed, suggestResult, applied, review, attempts, implementedBy, implementModel, reviewModel, scope, briefFeedback }) {
  const dir = path.join(repoRoot, generationsDir, `gen-${genNumber}`);
  fs.mkdirSync(dir, { recursive: true });
  const relative = `${generationsDir}/gen-${genNumber}/proposal.md`;

  fs.writeFileSync(
    path.join(repoRoot, relative),
    `# Generation ${genNumber} — proposal

- **Date:** ${new Date().toISOString().slice(0, 10)}
- **Scope:** ${scope?.scope ?? 'focused'} — ${scope?.reason ?? 'default'}
- **Suggested by:** \`${suggestResult.model}\` (${suggestResult.provider})
- **Implemented by:** \`${implementedBy}\`${implementedBy !== implementModel ? ' — **the suggesting model wrote its own edits**' : ''}
- **Reviewed by:** \`${reviewModel}\`
- **Attempts:** ${attempts}
- **Summary:** ${parsed.summary}
- **Pillar:** ${parsed.pillar ?? ''}

## Rationale

${parsed.rationale}

## What the suggesting model said about its own brief

${briefFeedback || '(none given)'}

## Files changed

${applied.map((a) => `- \`${a.file}\` (−${a.removedLines}/+${a.addedLines} lines)`).join('\n')}

## The suggestion, verbatim

\`\`\`
${proposal.trim()}
\`\`\`

## Review

${review.raw.trim()}
`,
    'utf8'
  );

  return relative;
}

/**
 * Fold every asked model's escalation fields into the ledger, and report
 * what crossed the consensus line in this run specifically — not
 * everything currently flagged, so a notifier doesn't repeat the same
 * idea every run.
 */
export function recordEscalations(proposals, { repoRoot, ledgerPath, genNumber, threshold }) {
  const date = new Date().toISOString().slice(0, 10);
  const entries = proposals.map((p) => ({ model: p.id, provider: p.provider, parsed: p.escalation }));

  // Judgements first. An AGREE is a supporter like any other, so folding
  // them in before the consensus check means a resurfaced entry can cross
  // the bar in the same run it was finally asked about — which is the point
  // of asking.
  const judged = recordJudgements({
    generation: genNumber,
    date,
    entries: proposals.map((p) => ({ model: p.id, provider: p.provider, judgements: p.judgements })),
    ledger: loadLedger({ repoRoot, ledgerPath }),
  });

  const round = recordRound({
    generation: genNumber,
    date,
    entries,
    ledger: judged.ledger,
    threshold,
  });

  // Queueing is NOT done here: takeWorkOrder() does it at the top of the
  // run, before the fan-out, so an escalation accepted since the last run is
  // available to this one rather than the next.
  const ledger = round.ledger;

  const touched =
    round.opened.length + round.supported.length + round.dissented.length +
    judged.agreed.length + judged.disagreed.length + judged.irrelevant.length +
    judged.retired.length;
  if (touched > 0) {
    saveLedger(ledger, { repoRoot, ledgerPath });
  }

  return {
    opened: round.opened.map((o) => ({ id: o.id, title: o.title, by: `${o.model} (${o.provider})` })),
    supported: round.supported.map((s) => ({ id: s.id, by: `${s.model} (${s.provider})` })),
    dissented: round.dissented.map((s) => ({ id: s.id, by: `${s.model} (${s.provider})` })),
    flagged: round.flagged.map((e) => ({ id: e.id, title: e.title, target: e.target, notification: renderForNotification(e, { threshold }) })),
    judged: {
      agreed: judged.agreed.map((j) => ({ id: j.id, by: `${j.model} (${j.provider})` })),
      disagreed: judged.disagreed.map((j) => ({ id: j.id, by: `${j.model} (${j.provider})` })),
      irrelevant: judged.irrelevant.map((j) => ({ id: j.id, by: `${j.model} (${j.provider})` })),
      retired: judged.retired.map((e) => ({ id: e.id, title: e.title })),
    },
  };
}

/**
 * Take a work order for this generation, if one is queued — and say what is
 * awaiting judgement while the ledger is open.
 *
 * Both reads happen here, before the suggestion prompt is built, because
 * both change what that prompt says. The assignment is written to disk
 * immediately: that is what makes two runs racing for one order harmless,
 * since the second sees it assigned and takes the next item or none.
 *
 * Returns nulls for a project with no ledger, no accepted escalations, and
 * nothing overdue — which is every project until a human has actually
 * accepted something, and is what keeps the prompt byte-identical until
 * then.
 */
export function takeWorkOrder({ repoRoot, ledgerPath, genNumber, scope, resurfaceAfter, threshold }) {
  const loaded = loadLedger({ repoRoot, ledgerPath });
  const due = resurfaceDue(loaded, { currentGeneration: genNumber, resurfaceAfter, threshold });

  // Queue first, then assign, in that order and in one pass. An escalation a
  // human accepted since the last run is available to THIS run — queueing it
  // in a later step would cost a whole generation of delay for no reason,
  // and the delay would be invisible.
  const { ledger, queued } = queueWorkOrders(loaded);

  // Only an ambitious run takes a work order. A focused generation is a
  // small, localised improvement by definition, and an accepted escalation
  // about the harness itself is not that.
  const assignment = scope === 'ambitious'
    ? assignWorkOrder(ledger, { generation: genNumber })
    : { ledger, order: null };

  if (queued.length || assignment.order) saveLedger(assignment.ledger, { repoRoot, ledgerPath });

  return {
    order: assignment.order
      ? { id: assignment.order.id, title: assignment.order.title, target: assignment.order.target }
      : null,
    workOrderBrief: buildWorkOrderBrief(assignment.order),
    queued: queued.map((q) => ({ id: q.id, title: q.title })),
    due,
    // Rebuilt here rather than reusing the caller's, because only this
    // function knows which entries are due and the marker is what makes the
    // ESCALATION REVIEW field answerable. Used ONLY when something is
    // actually due — an ordinary run keeps the brief its caller built, so
    // the byte-identity of that path is a property of the code rather than
    // an argument about two calls agreeing.
    escalationBrief: due.length
      ? buildEscalationBrief(assignment.ledger, { threshold, awaitingJudgement: due })
      : null,
  };
}

/**
 * Record how the generation that carried a work order went — the label this
 * whole mechanism exists to produce.
 *
 * Called on every terminal outcome, crashes included. A run that was handed
 * an order and died still completes it with that outcome: leaving it
 * assigned forever would drain the queue without ever recording why.
 */
export function finishWorkOrder({ repoRoot, ledgerPath, genNumber, outcome }) {
  const { ledger, completed } = completeWorkOrder(loadLedger({ repoRoot, ledgerPath }), {
    generation: genNumber,
    outcome,
  });
  if (!completed) return null;
  saveLedger(ledger, { repoRoot, ledgerPath });
  return { id: completed.id, title: completed.title, outcome };
}

// ---------------------------------------------------------------------------
// Filesystem helpers for the attempt loop
// ---------------------------------------------------------------------------

export function snapshotEditableFiles(repoRoot, editableFiles) {
  const snapshot = new Map();
  for (const relative of editableFiles) {
    const absolute = path.join(repoRoot, relative);
    if (fs.existsSync(absolute)) snapshot.set(relative, fs.readFileSync(absolute, 'utf8'));
  }
  return snapshot;
}

export function restoreSnapshot(repoRoot, snapshot, createdPaths = []) {
  for (const [relative, content] of snapshot) {
    fs.writeFileSync(path.join(repoRoot, relative), content, 'utf8');
  }
  for (const relative of createdPaths) {
    const absolute = path.join(repoRoot, relative);
    if (fs.existsSync(absolute)) fs.unlinkSync(absolute);
  }
}

// ---------------------------------------------------------------------------
// The main loop
// ---------------------------------------------------------------------------

/**
 * Run one full generation: suggest, implement, review, refine.
 *
 * Unlike the reference implementation, this never throws for an ordinary
 * "nothing shipped" outcome (no proposal, or every attempt rejected) — it
 * returns a result object with `hasChanges` and `outcome`, and the CLI
 * layer decides what that means for its own exit code. It DOES throw for
 * a genuinely unexpected failure (a bug, an exception outside the
 * try/catch this function already wraps everything else in) — and before
 * it does, it writes a `crashed` attempt record with whatever state had
 * accumulated so far. That guarantee — a crash always leaves a record —
 * is the direct lesson of a real incident: a review call that died
 * mid-loop once erased its whole generation, because the record was only
 * ever written on the paths that returned cleanly. See
 * learning/01-principles.md's "20d" for the incident.
 *
 * @param {object} config
 * @param {string} config.repoRoot
 * @param {string} config.genNumber            e.g. "001"
 * @param {string} [config.generationsDir]      Default 'docs/generations'.
 * @param {string} config.agentBrief            Required — the project's filled-in agent-brief.md.
 * @param {string} config.reviewerBrief         Required — the project's filled-in reviewer-brief.md.
 * @param {string[]} config.editableFiles
 * @param {object} config.allowlist             edit-format.mjs's compileAllowlist() result.
 * @param {string} [config.createOnlyDescription]
 * @param {Array<{id: string, provider?: string}>} config.suggestModels
 * @param {string} [config.implementModel]      Default 'claude-opus-5'.
 * @param {string} [config.reviewModel]         Default 'claude-opus-5'.
 * @param {string} [config.rankModel]           Default implementModel.
 * @param {number} [config.maxAttempts]         Default 3.
 * @param {number} [config.suggestMaxTokens]    Default 32000.
 * @param {{scope: 'focused'|'ambitious', reason: string}} config.scope  Required
 *   — callers decide this (typically via context-pack.mjs's recommendScope())
 *   before calling, so this function stays fs-independent for that decision.
 * @param {Record<string,string>} [config.scopeText]  Default DEFAULT_SCOPE_TEXT.
 * @param {string} config.projectDescription    One sentence, used in the ranking prompt.
 * @param {string} [config.testDescription]     Passed to the reviewer.
 * @param {object} config.context               Pre-assembled context-pack blocks.
 * @param {{images: Array, source: string|null}} [config.screenshots]
 * @param {string} [config.ledgerPath]
 * @param {{models: number, labs: number}} [config.consensus]
 * @param {() => Promise<object>} [config.captureVisual]  Passed to review.mjs.
 * @param {string} [config.implementationNotes]
 * @param {{maxGenerationTokens?: number|null}} [config.budget]  A token cap
 *   for the whole generation (harness/lib/adapter.mjs's budgetConfig()).
 *   Checked twice: projected before the fan-out (outcome 'over-budget',
 *   nothing called), and actually between attempts (the loop stops with a
 *   'budget-exhausted' attempt and the run is abandoned). Null means no cap.
 * @param {{call?: Function, log?: (msg: string) => void}} [deps]
 * @returns {Promise<object>}
 */
export async function runGeneration(config, deps = {}) {
  const {
    repoRoot,
    genNumber,
    generationsDir = 'docs/generations',
    agentBrief,
    reviewerBrief,
    editableFiles,
    allowlist,
    createOnlyDescription,
    suggestModels,
    implementModel = 'claude-opus-5',
    reviewModel = 'claude-opus-5',
    rankModel = implementModel,
    maxAttempts = 3,
    suggestMaxTokens = 32000,
    scope,
    scopeText = DEFAULT_SCOPE_TEXT,
    projectDescription,
    testDescription = null,
    context,
    screenshots = { images: [], source: null },
    ledgerPath,
    consensus,
    resurfaceAfter,
    captureVisual,
    implementationNotes = null,
    budget = {},
    campaign = false,
    seatPromotion = null,
    goal = null,
    run = null,
  } = config;

  const rawCall = deps.call ?? callModelWithHeadroom;
  const log = deps.log ?? (() => {});

  // Every model call this generation makes goes through the ledger, tagged
  // with the stage that made it, so the attempt record can say what the
  // run cost and the cap below has something real to compare against.
  // The ledger holds the cap itself: every request is admitted against it
  // BEFORE it is sent, reserving its full output allowance, so parallel
  // suggestions and headroom retries are bounded too — not only the gaps
  // between attempts.
  const maxGenerationTokens = Number.isFinite(budget?.maxGenerationTokens) && budget.maxGenerationTokens > 0 ? budget.maxGenerationTokens : null;
  const spend = createSpendLedger({ maxTokens: maxGenerationTokens });
  const callFor = (site) => withSpend(rawCall, spend, site);
  const budgetExhausted = () => maxGenerationTokens !== null && spend.total() > maxGenerationTokens;

  if (!agentBrief || !agentBrief.trim()) throw new Error('runGeneration requires a non-empty agentBrief.');
  if (!reviewerBrief || !reviewerBrief.trim()) throw new Error('runGeneration requires a non-empty reviewerBrief.');
  if (!Array.isArray(suggestModels) || suggestModels.length === 0) {
    throw new Error('runGeneration requires at least one entry in suggestModels.');
  }
  if (!scope) throw new Error('runGeneration requires a scope decision — see recommendScope() in context-pack.mjs.');

  const genLabel = `Generation #${genNumber}`;
  const asking = suggestModels.map((m) => ({ ...m, provider: m.provider || resolveProvider(m.id) }));

  log(`🚀 Generation ${genNumber}`);
  log(`   suggest:   ${asking.map((m) => `${m.id} (${m.provider})`).join(', ')}`);
  log(`   implement: ${implementModel}`);
  log(`   review:    ${reviewModel}\n`);

  // Before the prompt is built, because both of these change what it says.
  // Nulls for a project whose ledger holds nothing accepted and nothing
  // overdue — which is every project until a human has actually decided
  // something, and is what keeps an ordinary run's prompt byte-identical to
  // one from before any of this existed.
  const { order, workOrderBrief, due, escalationBrief } = takeWorkOrder({
    repoRoot, ledgerPath, genNumber, scope: scope.scope, resurfaceAfter, threshold: consensus,
  });
  if (order) log(`📋 Carrying work order ${order.id} — ${order.title}`);
  if (due.length) log(`❓ Asking about ${due.length} escalation(s) nobody has engaged with: ${due.map((e) => e.id).join(', ')}`);

  const promptConfig = {
    agentBrief,
    goal,
    scopeText: scopeText[scope.scope] ?? scopeText.focused,
    editableFiles,
    createOnlyDescription,
    suggestMaxTokens,
    context: {
      ...context,
      ...(escalationBrief ? { escalations: escalationBrief } : {}),
      workOrder: workOrderBrief,
      escalationReview: buildEscalationReviewField(due),
    },
    screenshots,
    genLabel,
    implementModel,
  };

  const pristine = snapshotEditableFiles(repoRoot, editableFiles);

  // Projected, before anything is spent: the suggestion prompt is the same
  // for every model, so its size times the fan-out is the floor of what
  // this run will cost. A run that cannot fit under the cap is refused
  // here, recorded, and reported — not discovered after N labs were paid.
  if (maxGenerationTokens !== null) {
    const promptChars = buildSuggestSystemPrompt(promptConfig).length + buildSuggestUserPrompt(promptConfig).length;
    const projected = projectedFanOut({ promptChars, models: asking.length, maxTokens: maxGenerationTokens });
    if (projected.over) {
      const detail = `projected ${projected.estimatedTokens.toLocaleString()} input tokens across ${asking.length} model(s) exceeds budget.max_generation_tokens (${maxGenerationTokens.toLocaleString()}); nothing was called`;
      log(`💸 Over budget before the fan-out — ${detail}`);
      const recordPath = writeAttemptRecord({
        repoRoot, generationsDir, genNumber, campaign, seatPromotion, run,
        outcome: 'over-budget',
        suggestResult: null,
        proposal: null,
        attempts: [{ attempt: 1, by: null, outcome: 'over-budget', detail: oneLine(detail, 400) }],
        fanOut: { asked: asking.map((m) => `${m.id} (${m.provider})`), proposed: [], failed: [] },
        implementedBy: null,
        implementModel,
        scope,
        spend: spend.summary(),
      });
      finishWorkOrder({ repoRoot, ledgerPath, genNumber, outcome: 'over-budget' });
      return {
        outcome: 'over-budget',
        hasChanges: false,
        scope,
        attemptRecordPath: recordPath,
        summary: oneLine(detail, 200),
        askedModels: asking,
        spend: spend.summary(),
      };
    }
  }

  const { proposals, failures } = await gatherProposals(promptConfig, asking, { call: callFor('suggest'), log });

  if (proposals.length === 0) {
    const recordPath = writeAttemptRecord({
      repoRoot, generationsDir, genNumber, campaign, seatPromotion, run,
      outcome: 'no-proposal',
      suggestResult: null,
      proposal: null,
      attempts: failures.map((f, i) => ({ attempt: i + 1, by: `${f.id} (${f.provider})`, outcome: 'suggestion-failed', detail: f.reason })),
      fanOut: { asked: asking.map((m) => `${m.id} (${m.provider})`), proposed: [], failed: failures.map((f) => `${f.id}: ${f.reason}`) },
      implementedBy: null,
      implementModel,
      scope,
      apiIssues: summarizeApiIssues(failures),
      spend: spend.summary(),
    });

    // Assigned before the fan-out, so an order can be outstanding even on a
    // run where no model answered at all.
    finishWorkOrder({ repoRoot, ledgerPath, genNumber, outcome: 'no-proposal' });

    return {
      outcome: 'no-proposal',
      hasChanges: false,
      scope,
      attemptRecordPath: recordPath,
      summary: oneLine(`no usable proposal — ${failures.map((f) => `${f.id}: ${f.reason}`).join('; ')}`, 200),
      askedModels: asking,
      failures,
      spend: spend.summary(),
    };
  }

  // Before ranking, and before anything below can throw. An escalation is
  // an opinion about the harness, not about the change, so it's worth
  // exactly as much from a proposal that loses the ranking or dies in
  // review as from the one that ships — recording it here means the
  // ledger survives an abandoned generation, which is the run most likely
  // to produce one.
  const escalationRound = recordEscalations(proposals, { repoRoot, ledgerPath, genNumber, threshold: consensus });

  // Same seam, same reasoning: keep every proposal's text before anything
  // below can throw or discard.
  const proposalFiles = writeFanOutProposals({ repoRoot, generationsDir, genNumber, proposals });

  // `created` lives out here rather than in the attempt loop so the catch
  // below can see it: a crash after edits were applied (a reviewer API
  // error, a bug in writeProposal) used to leave those edits in the tree.
  const crashState = { suggestResult: null, proposal: null, fanOut: null, attempts: [], by: null, created: [] };

  // The one way back to the tree this run started from, whatever happens.
  // Idempotent, so the catch, the normal paths and a signal handler can all
  // call it without coordinating. Handed to deps.onCleanup so a CLI can run
  // it on SIGINT/SIGTERM — a cancelled CI job or a Ctrl+C mid-review is a
  // crash the catch never sees.
  let restored = false;
  const restoreTree = () => {
    if (restored) return;
    restored = true;
    restoreSnapshot(repoRoot, pristine, crashState.created);
  };
  const releaseCleanup = deps.onCleanup?.(restoreTree) ?? (() => {});

  try {
    const ranking = await rankProposals({ projectDescription, manifest: context.manifest, testIndex: context.testIndex, proposals, rankModel, scope: scope.scope }, { call: callFor('rank'), log });
    const winner = proposals[ranking.index];
    const suggestResult = winner.result;
    const proposal = winner.text;

    const fanOut = {
      asked: asking.map((m) => `${m.id} (${m.provider})`),
      proposed: proposals.map((p) => p.id),
      offeredEdits: proposals.filter((p) => p.directEdits).map((p) => p.id),
      failed: failures.map((f) => `${f.id}: ${f.reason}`),
      chosen: `${winner.id} (${winner.provider})`,
      rankedBy: proposals.length > 1 ? rankModel : null,
      rankingReason: ranking.reason,
      proposalFiles,
      briefFeedback: Object.fromEntries(proposals.filter((p) => p.briefFeedback).map((p) => [p.id, p.briefFeedback])),
    };
    crashState.suggestResult = suggestResult;
    crashState.proposal = proposal;
    crashState.fanOut = fanOut;

    let applyErrors = null;
    let reviewFeedback = null;
    let rejectedRender = null;
    const attemptLog = crashState.attempts;

    // A call the cap refused (spend.mjs's admit()) ends the attempt loop the
    // same way the between-attempts check does: recorded, and the run
    // abandoned — not a crash, because nothing went wrong except the money
    // running out. Anything else is re-thrown to the crash handler.
    const stopForBudget = (err, attempt, by) => {
      if (err?.kind !== 'budget') throw err;
      log(`💸 Attempt ${attempt} (${by}) stopped: ${err.message}`);
      attemptLog.push({ attempt, by, outcome: 'budget-exhausted', detail: oneLine(err.message, 400) });
    };

    // Who implements, in order. When the suggesting model wrote its own
    // edits they are tried first and do not consume one of the pinned
    // implementer's attempts.
    const plan = [];
    if (winner.directEdits) plan.push({ by: `${winner.id} (${winner.provider})`, direct: true });
    for (let i = 0; i < maxAttempts; i++) plan.push({ by: implementModel, direct: false });

    for (const [index, step] of plan.entries()) {
      const attempt = index + 1;
      crashState.by = step.by;

      // The running check. The first attempt always runs — the fan-out was
      // already projected to fit — but a refine loop can spend the cap
      // several times over, and a cap that only ever counted the first call
      // would not be one.
      if (attempt > 1 && budgetExhausted()) {
        const detail = `spent ${spend.total().toLocaleString()} tokens, over budget.max_generation_tokens (${maxGenerationTokens.toLocaleString()}); no further attempts`;
        log(`💸 Attempt ${attempt} (${step.by}) not started: ${detail}`);
        attemptLog.push({ attempt, by: step.by, outcome: 'budget-exhausted', detail: oneLine(detail, 400) });
        break;
      }

      restoreSnapshot(repoRoot, pristine, crashState.created);
      crashState.created = [];

      let parsed;
      if (step.direct) {
        log(`✍️  Stage 2 — edits written by ${step.by} itself`);
        parsed = winner.directEdits;
      } else {
        let implemented;
        try {
          implemented = await implement(
            { ...promptConfig, implementModel, implementationNotes },
            proposal,
            { applyErrors, reviewFeedback, rejectedRender, attempt, author: `${winner.id} (${winner.provider})` },
            { call: callFor('implement'), log, maxAttempts }
          );
        } catch (err) {
          stopForBudget(err, attempt, step.by);
          break;
        }
        parsed = parseResponse(implemented.text, ['PILLAR']);
      }
      crashState.created = parsed.creates.map((c) => c.file);

      const outcome = applyEdits(parsed.edits, { repoRoot, allowlist, creates: parsed.creates, createDescription: createOnlyDescription });

      if (outcome.errors.length) {
        log(`⚠️  Attempt ${attempt} (${step.by}): edits did not apply`);
        attemptLog.push({ attempt, by: step.by, outcome: 'edits-did-not-apply', detail: oneLine(outcome.errors.join('; '), 400) });
        applyErrors = step.direct ? null : outcome.errors;
        reviewFeedback = null;
        rejectedRender = null;
        continue;
      }

      log(`   applied ${outcome.applied.length} edit(s) to ${outcome.filesChanged.join(', ')}`);
      log(`🔎 Stage 3 — review`);

      const askReviewer = () => reviewChanges({
        reviewerBrief,
        genLabel,
        diff: renderForReview(parsed),
        filesChanged: outcome.filesChanged,
        repoRoot,
        testDescription,
        captureVisual,
        reviewModel,
        goal,
        call: callFor('review'),
      });

      let review;
      try {
        review = await askReviewer();
        // A review that could not be read as one complete verdict
        // (truncated, contradictory, malformed) is a rejection — but a
        // rejection of the REVIEW, not of the change, and handing the
        // implementer "try again" with nothing to fix wastes an attempt on a
        // formatting slip. So the same diff is shown to the reviewer once
        // more. Bounded: one re-ask per attempt, and the reservation in
        // spend.mjs still applies.
        if (review.problem) {
          log(`⚠️  Attempt ${attempt} (${step.by}): the review could not be trusted (${review.problem}); asking the reviewer once more`);
          review = await askReviewer();
        }
      } catch (err) {
        // Refused by the cap with edits already applied: they are not
        // reviewed, so they do not ship — the abandoned path restores them.
        stopForBudget(err, attempt, step.by);
        break;
      }

      if (!review.approved) {
        const unreadable = Boolean(review.problem);
        log(`❌ Attempt ${attempt} (${step.by}): ${unreadable ? 'review unreadable' : 'rejected'} — ${review.reason}\n`);
        attemptLog.push({
          attempt, by: step.by,
          outcome: unreadable ? 'review-unparseable' : 'rejected-by-review',
          detail: oneLine(review.reason || 'no reason given', 400),
        });
        reviewFeedback = unreadable
          ? `The reviewer's response could not be read as one complete verdict (${review.problem}), twice. No required fix was reliably stated; what it did say follows. Re-check the change against the proposal and the source.\n\n${review.feedback}`
          : review.feedback;
        rejectedRender = review.visual;
        applyErrors = null;
        continue;
      }

      // Approved.
      const implementedBy = step.by;
      const summary = oneLine(parsed.summary || `Generation ${genNumber} improvement`, 80);
      attemptLog.push({ attempt, by: step.by, outcome: 'approved', detail: summary });

      const proposalPath = writeProposal({
        repoRoot, generationsDir, genNumber, proposal, parsed, suggestResult,
        applied: outcome.applied, review, attempts: attempt, implementedBy,
        implementModel, reviewModel, scope, briefFeedback: winner.briefFeedback,
      });

      const attemptRecordPath = writeAttemptRecord({
        repoRoot, generationsDir, genNumber, campaign, seatPromotion, run,
        outcome: 'approved', suggestResult, proposal, attempts: attemptLog,
        fanOut, implementedBy, implementModel, scope, escalations: escalationRound,
        apiIssues: summarizeApiIssues(failures),
        spend: spend.summary(),
      });

      log(`\n✅ Approved on attempt ${attempt}: ${review.reason}`);
      log(`   implemented by ${implementedBy}`);
      log(`💸 ${spend.total().toLocaleString()} tokens across ${spend.calls.length} call(s)`);

      // The outcome label this generation's work order was waiting for.
      const workOrder = finishWorkOrder({ repoRoot, ledgerPath, genNumber, outcome: 'approved' });
      if (workOrder) log(`📋 Work order ${workOrder.id} completed: approved`);

      return {
        outcome: 'approved',
        workOrder,
        hasChanges: true,
        scope,
        summary,
        suggestModel: suggestResult.model,
        suggestProvider: suggestResult.provider,
        implementedBy,
        selfImplemented: implementedBy !== implementModel,
        filesChanged: outcome.filesChanged,
        proposalPath,
        attemptRecordPath,
        reviewVerdict: review.verdict,
        attempts: attempt,
        briefFeedback: winner.briefFeedback,
        escalations: escalationRound,
        fanOut,
        spend: spend.summary(),
      };
    }

    // Never approved. Leave the tree exactly as we found it, except for
    // the record of what was tried — that file is the whole value of a
    // failed run.
    restoreTree();
    const attemptRecordPath = writeAttemptRecord({
      repoRoot, generationsDir, genNumber, campaign, seatPromotion, run,
      outcome: 'abandoned', suggestResult, proposal, attempts: attemptLog,
      fanOut, implementedBy: null, implementModel, scope, escalations: escalationRound,
      apiIssues: summarizeApiIssues(failures),
      spend: spend.summary(),
    });

    const workOrder = finishWorkOrder({ repoRoot, ledgerPath, genNumber, outcome: 'abandoned' });
    if (workOrder) log(`📋 Work order ${workOrder.id} completed: abandoned`);

    return {
      outcome: 'abandoned',
      workOrder,
      hasChanges: false,
      scope,
      suggestModel: suggestResult.model,
      suggestProvider: suggestResult.provider,
      attempts: attemptLog.length,
      attemptRecordPath,
      briefFeedback: winner.briefFeedback,
      escalations: escalationRound,
      fanOut,
      spend: spend.summary(),
    };
  } catch (err) {
    // A genuinely unexpected failure. Put the tree back first — edits from
    // an attempt that was mid-review are not a change anyone approved — and
    // then write down whatever state had accumulated before re-throwing, so
    // the generation this run was supposed to be leaves a record instead of
    // silently not existing. See this function's own doc comment for the
    // incident this guards against. A restore that itself fails must not
    // hide the original error, so it is recorded beside it instead.
    let restoreError = null;
    try { restoreTree(); } catch (e) { restoreError = e; }
    const attemptRecordPath = writeAttemptRecord({
      repoRoot, generationsDir, genNumber, campaign, seatPromotion, run,
      outcome: 'crashed',
      suggestResult: crashState.suggestResult,
      proposal: crashState.proposal,
      attempts: [...crashState.attempts, {
        attempt: crashState.attempts.length + 1,
        by: crashState.by,
        outcome: 'crashed',
        detail: oneLine(`${err?.message ?? String(err)}${restoreError ? ` (and the working tree could NOT be restored: ${restoreError.message})` : ''}`, 400),
      }],
      fanOut: crashState.fanOut,
      implementedBy: null,
      implementModel,
      scope,
      escalations: escalationRound,
      // The crash itself, alongside any suggestion-stage failures that
      // happened before it — a bad implement-model key crashes the whole
      // run, but a bad key on one of several suggesting labs doesn't, so
      // both sources matter here.
      apiIssues: summarizeApiIssues([
        ...failures,
        { id: crashState.by, provider: err?.provider, kind: err?.kind, statusCode: err?.statusCode },
      ]),
      spend: spend.summary(),
    });
    log(`📓 Recorded the crash in ${attemptRecordPath}`);
    // A run that was handed a work order and died still completes it, with
    // that outcome. Leaving it assigned forever would drain the queue
    // without ever recording why.
    finishWorkOrder({ repoRoot, ledgerPath, genNumber, outcome: 'crashed' });
    err.attemptRecordPath = attemptRecordPath;
    err.treeRestored = !restoreError;
    throw err;
  } finally {
    releaseCleanup();
  }
}
