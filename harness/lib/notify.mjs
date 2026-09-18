#!/usr/bin/env node

/**
 * The notifier — plain-language reporting for a generation, and for an
 * escalation that reached consensus. Ported from carrotgame's
 * scripts/send-digest-email.mjs, scripts/send-escalation-email.mjs and
 * scripts/lib/format-digest.mjs (the reference implementation).
 *
 * The core insight, unchanged: a status-report template (icons, a "Gates:"
 * list, a one-line "Change:" field) can say WHAT happened but never WHY it
 * matters, because that's a fact about the specific run, not something a
 * fixed template can hold. This asks a model to read the same real record
 * a person would and explain it the way you'd explain it to someone who
 * cares about the outcome but wasn't watching — with a **reliable fallback
 * to a terse but complete format** if that call fails for any reason. A
 * missed notification is worse than an unpolished one.
 *
 * Two things stay computed from real job results, never left for the
 * model to infer or paraphrase — see the reference implementation's own
 * incident: a real run had an automated file-allowlist check fail while
 * the AI review had genuinely APPROVED the change, and a model asked to
 * write the digest invented "the reviewer said no" despite the real
 * verdict being right there in its prompt. `gatesBlock()` and
 * `blockedByLine()` below are why that can't happen here: they compute
 * the answer in code and hand it to the model as a stated fact, not a gap
 * to fill in.
 *
 * Genericised the same way as everything content-bearing in this harness:
 * the reference implementation's system prompt hardcodes "Chris" and "two
 * children's browser games" plus two real, well-received calibration
 * examples from carrotgame's own history. `buildDigestSystemPrompt()`
 * takes a recipient name, a project description, and an OPTIONAL list of
 * calibration examples — a fresh project with no history yet still gets a
 * working prompt from the (already generic) rules alone, and can add its
 * own real examples once it has some, the same way carrotgame's did.
 */

import { callModelWithHeadroom } from './llm-provider.mjs';

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

const DIGEST_RULES = `Rules:
- Lead with the interesting, human-relevant fact — never "Generation N completed" or a subject line restated as the first sentence.
- Explain what changed in terms a non-technical reader would understand, not a diff or a field name.
- Explain WHY it matters, not just that a gate passed.
- If something notable happened (first attempt approved, the model wrote its own code, a rejection and retry, nothing was produced at all), say so in plain words and explain what it means — do not just label it.
- Name the model and lab, but do not lead with it.
- No bullet or icon gate lists as the main content. Prose first. A short factual line or two at the end (links, generation number) is fine.
- Keep it to 2-4 short paragraphs. Clear beats exhaustive.
- Do not invent facts. If the source material does not say why something failed, say that plainly rather than guessing.
- The review's verdict and the reason merge did or didn't happen are two SEPARATE facts — a change can be reviewed and APPROVED and still not merge, because of an unrelated later gate. Never say "the reviewer rejected it" unless the source material's review verdict literally says rejected. The "why merge did or did not happen" line in the facts is computed directly from the real job results — trust it over any inference you might otherwise draw from a failed gate.

Respond in EXACTLY this format, nothing before SUBJECT or after the body:
SUBJECT: <one line, plain language, not a status code>
BODY:
<the email body>`;

/**
 * @param {object} opts
 * @param {string} opts.recipientName      e.g. "Chris".
 * @param {string} opts.projectDescription One sentence, e.g. "a project that
 *   lets AI models propose changes to a CLI tool, gated by a second AI's
 *   review and a full test suite."
 * @param {string[]} [opts.calibrationExamples]  Real, well-received email
 *   bodies (or excerpts) from this project's own history. Optional —
 *   omit until the project has some.
 */
export function buildDigestSystemPrompt({ recipientName, projectDescription, calibrationExamples = [] }) {
  const examples = calibrationExamples.length
    ? `\n\nReal example(s) of the register to match, from this project, well received:\n\n---\n${calibrationExamples.map((e, i) => `EXAMPLE ${i + 1}:\n"${e}"`).join('\n\n')}\n---\n`
    : '';

  return `You are writing an email to ${recipientName}, the creator of ${projectDescription}. They read every one of these emails and want to actually understand what happened, not skim a status report.

Write the way you would explain it to a friend who is smart but was not watching the run — not the way a CI job prints a log.${examples}

${DIGEST_RULES}`;
}

export function buildGenerationDigestPrompt(facts) {
  return `# What happened this run\n\n${facts}\n\nWrite the email.`;
}

export function buildEscalationDigestPrompt(facts) {
  return (
    `# An escalation reached consensus\n\n${facts}\n\n` +
    `Write the email explaining what is being asked, why it matters enough that ` +
    `independent models flagged it, and what the reader needs to do about it ` +
    `(review the escalation ledger, decide, and record the decision so future ` +
    `models are shown the answer instead of re-arguing it).`
  );
}

/** @returns {{subject: string, body: string}} */
export function parseEmailResponse(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Empty response — nothing to parse.');
  }

  const subject = text.match(/^SUBJECT:\s*(.+)$/m)?.[1]?.trim();
  const body = text.match(/^BODY:\s*\n([\s\S]*)$/m)?.[1]?.trim();

  if (!subject) throw new Error('No SUBJECT: line found in the response.');
  if (!body) throw new Error('No BODY: section found in the response.');
  if (body.length < 40) throw new Error('BODY is too short to be a real email.');

  return { subject, body };
}

// ---------------------------------------------------------------------------
// Computed facts — never left for a model to infer
// ---------------------------------------------------------------------------

const gateIcon = (result) => (result === 'success' ? '✅' : result === 'skipped' ? '⏭️' : '❌');

/** @param {Array<{name: string, result: string}>} gates */
export function gatesBlock(gates) {
  return ['Gates:', ...gates.map((g) => `  ${gateIcon(g.result)} ${g.name}`)].join('\n');
}

/**
 * Why merge did or did not happen — computed from real gate results and the
 * run's own pull request, never asked of a model. Walks the gates in order
 * and reports the first one that didn't succeed, using that gate's own
 * `note` if it supplied one (the way a project explains "this gate is
 * unrelated to the AI review", matching the reference implementation's own
 * guard-vs-review distinction). Only when nothing failed does an open pull
 * request get to explain the outcome — a failing gate always outranks it,
 * because "it's waiting for you" is the wrong thing to tell someone whose
 * run actually broke.
 *
 * @param {{merged: boolean, gates: Array<{name: string, result: string, note?: string}>, pullRequestUrl?: string}} opts
 */
/**
 * A URL safe to put in an email, or null. Same rule as run-history.mjs's
 * `safeUrl()` and for the same reason, kept local rather than imported so
 * the notification path stays independent of the page renderer: `gh pr
 * create` emitting anything but a URL as its last line should degrade to
 * "no link", never to a link that goes somewhere else.
 */
function emailUrl(url) {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

export function blockedByLine({ merged, gates, pullRequestUrl }) {
  if (merged) return 'It merged — nothing was blocked.';
  const firstFailure = gates.find((g) => g.result !== 'success' && g.result !== 'skipped');
  if (firstFailure) return firstFailure.note || `Blocked by the "${firstFailure.name}" gate.`;
  // Nothing failed and it did not merge: under the default merge model that
  // is not a mystery, it is the design. Without this branch the digest told
  // the owner "we don't know why" about the one outcome the whole
  // pull-request path exists to produce.
  if (pullRequestUrl) {
    return `Nothing was blocked. Every gate passed and the change is waiting for YOU — it is an open pull request (${pullRequestUrl}), and this project merges only when a person says so.`;
  }
  return 'Not merged, and none of the individual gate results explain why — describe this as genuinely unclear rather than guessing a cause.';
}

// ---------------------------------------------------------------------------
// Core: plain-language with a reliable fallback
// ---------------------------------------------------------------------------

/**
 * Ask a model to write the email; on ANY failure (a bad response, an API
 * error, a truncation), fall back to a caller-supplied terse-but-complete
 * version instead of sending nothing. This is the one mechanism both
 * `buildGenerationDigestEmail()` and `buildEscalationNoticeEmail()` share.
 */
async function composeWithFallback({ systemPrompt, userPrompt, buildFallback, digestModel = 'claude-opus-5', maxTokens = 2000, call = callModelWithHeadroom, log = () => {} }) {
  try {
    const result = await call({ model: digestModel, system: systemPrompt, user: userPrompt, maxTokens });
    if (result.truncated) {
      throw new Error(`Response was truncated (stop reason: ${result.stopReason}) even after a headroom retry.`);
    }
    const parsed = parseEmailResponse(result.text);
    log('✅ Plain-language email written.');
    return { ...parsed, plainLanguage: true };
  } catch (err) {
    log(`⚠️  Plain-language email failed (${err.message}); sending the terse fallback instead.`);
    return { ...buildFallback(), plainLanguage: false };
  }
}

// ---------------------------------------------------------------------------
// Generation digest
// ---------------------------------------------------------------------------

/**
 * @param {object} r  Everything about this generation the digest needs.
 * @param {string} r.genLabel
 * @param {string} r.scope
 * @param {boolean} r.merged
 * @param {string} r.suggestModel @param {string} r.suggestProvider
 * @param {string} r.implementModel @param {boolean} r.selfImplemented
 * @param {string} r.summary
 * @param {Array<{name: string, result: string, note?: string}>} r.gates
 * @param {string} [r.briefFeedback]
 * @param {number} [r.spendTokens]  Tokens spent across every call this
 *   generation made (harness/lib/spend.mjs). Omitted when unknown; never
 *   rendered as zero, since zero would read as "free".
 * @param {number} [r.escalationsOpened] @param {number} [r.escalationsFlagged]
 * @param {string} [r.minorityReport]  Open escalations with a strong case
 *   and no backing, already rendered (escalations.mjs's
 *   renderMinorityReport()). The owner only ever hears about an escalation
 *   once it has reached consensus, so the high-conviction idea one model
 *   argued hard for and nobody engaged with never reaches them — and that is
 *   precisely the item a human spots faster than three models will. Omitted
 *   entirely when there is nothing to report, which is the common case.
 * @param {string} [r.pullRequestUrl]  The pull request this run opened, when
 *   the project uses `human-approval-required`. Its presence is what makes
 *   an unmerged run "waiting for you" rather than "not merged".
 * @param {string} [r.runUrl]  The workflow run, for anyone who wants the log.
 * @param {string} [r.attemptsJson] @param {string} [r.proposalMd]  Raw file contents, if available.
 * @param {string} r.recipientName @param {string} r.projectDescription
 * @param {string[]} [r.calibrationExamples]
 * @param {string} [r.digestModel]
 * @param {{call?: Function, log?: (msg: string) => void}} [deps]
 */
export async function buildGenerationDigestEmail(r, deps = {}) {
  // Three outcomes, not two. "⚠️ NOT MERGED" on a run that passed every gate
  // and opened a pull request reads as a failure, and it is the opposite:
  // under `human-approval-required` — the default — it is the loop finishing
  // its job and handing the decision over. An owner who learns to skim
  // "NOT MERGED" as "nothing for me" stops opening the one email that is
  // entirely for them.
  const pullRequestUrl = emailUrl(r.pullRequestUrl);
  const runUrl = emailUrl(r.runUrl);
  // A gate can still fail AFTER the pull request is opened — `records` is the
  // live example: it runs `always()`, is continue-on-error, and loses a push
  // race to the default branch now and then. Without this clause such a run
  // was headed "waiting for you" and told the model "every gate passed",
  // while blockedByLine() in the same prompt said "blocked by the records
  // gate". Contradictory computed facts are the one thing this file exists
  // to prevent, so `waiting` obeys the precedence blockedByLine() already
  // uses: a real failure outranks an open pull request.
  const blockingGate = (r.gates || []).find((g) => g.result !== 'success' && g.result !== 'skipped');
  const waiting = !r.merged && Boolean(pullRequestUrl) && !blockingGate;
  const statusWord = r.merged ? '✅ MERGED' : waiting ? '📋 WAITING FOR YOU' : '⚠️ NOT MERGED';
  const bannerLine = `${statusWord} — ${r.genLabel} (${r.scope} scope)`;
  // The decision needs one click, from the email, on a phone. Anything that
  // makes the owner go and find the pull request is a reason to do it later.
  // Keyed on the URL alone, not on `waiting`: a run that opened a pull
  // request and then had a later gate fail still gets the link — it just
  // gets an honest banner above it.
  const linkLines = [
    ...(pullRequestUrl ? [`Review it:      ${pullRequestUrl}`] : []),
    ...(runUrl ? [`Workflow run:   ${runUrl}`] : []),
  ];
  const creditLines = [
    `Suggested by:   ${r.suggestModel || 'n/a'} (${r.suggestProvider || 'n/a'})`,
    `Implemented by: ${r.implementModel || 'n/a'}${r.selfImplemented ? '  ← the suggesting model wrote its own edits' : ''}`,
  ];
  const escalationsLine = `Escalations: ${r.escalationsOpened || 0} new case(s) opened` +
    ((r.escalationsFlagged || 0) > 0 ? `, ${r.escalationsFlagged} reached consensus — see the separate notice` : '.');
  const spendKnown = Number.isFinite(r.spendTokens) && r.spendTokens > 0;
  const spendLine = spendKnown ? `Spent: ${r.spendTokens.toLocaleString()} tokens across every model call this generation made` : null;

  const buildFallback = () => ({
    subject: (waiting
      ? `Waiting for your review: ${r.genLabel} — ${r.summary || 'a change passed every gate'}`
      : `${statusWord}: ${r.genLabel} — ${r.summary || 'no change approved'}`).slice(0, 200),
    body: [
      bannerLine, ``, ...creditLines,
      `Change: ${r.summary || '(no change was approved)'}`,
      ...(linkLines.length ? [``, ...linkLines] : []), ``,
      gatesBlock(r.gates), ``,
      `What the suggesting model said about its own brief:`, `  ${r.briefFeedback || '(none given)'}`, ``,
      escalationsLine,
      ...(spendLine ? [spendLine] : []),
      ...(r.minorityReport ? [``, r.minorityReport] : []),
    ].join('\n'),
  });

  const facts = [
    `Generation: ${r.genLabel}`,
    `Scope: ${r.scope}`,
    `Merged: ${r.merged}`,
    `Suggested by: ${r.suggestModel || 'n/a'} (${r.suggestProvider || 'n/a'})`,
    `Implemented by: ${r.implementModel || 'n/a'}${r.selfImplemented ? ' — the suggesting model wrote its own edits itself' : ''}`,
    `Summary as recorded: ${r.summary || '(no change was approved)'}`,
    `Gate results: ${r.gates.map((g) => `${g.name}=${g.result}`).join(', ')}`,
    `Why merge did or did not happen (computed from the real job results, not a guess — trust this over any inference from the gate list): ${blockedByLine({ merged: r.merged, gates: r.gates, pullRequestUrl })}`,
    waiting
      ? `THIS RUN IS WAITING ON THE READER. Every gate passed and a pull request is open at ${pullRequestUrl}. Say so plainly and early — what the change is, and that merging it is their call. Do not describe this as a failure or as "not merged", and do not speculate about why it did not merge.`
      : '',
    `What the suggesting model said about its own brief: ${r.briefFeedback || '(none given)'}`,
    `New escalations opened this run: ${r.escalationsOpened || 0}`,
    `Escalations that reached consensus this run: ${r.escalationsFlagged || 0} (sent as a separate notice if any)`,
    spendLine ? `Cost: ${r.spendTokens.toLocaleString()} tokens (input plus output, every call). Mention it in one short sentence.` : '',
    r.attemptsJson ? `\nFull attempt record:\n${r.attemptsJson}` : '',
    r.proposalMd ? `\nFull proposal, including the suggesting model's own analysis:\n${r.proposalMd}` : '',
  ].filter(Boolean).join('\n');

  const systemPrompt = buildDigestSystemPrompt(r);
  const composed = await composeWithFallback({
    systemPrompt, userPrompt: buildGenerationDigestPrompt(facts), buildFallback,
    digestModel: r.digestModel, ...deps,
  });

  if (!composed.plainLanguage) return composed;

  return {
    subject: composed.subject.slice(0, 200),
    body: [
      bannerLine, ``, ...creditLines,
      ...(linkLines.length ? [``, ...linkLines] : []), ``, composed.body, ``,
      gatesBlock(r.gates), ``, escalationsLine,
      ...(spendLine ? [spendLine] : []),
      // Appended after the model-written body rather than folded into it:
      // this is a standing list a human skims, not part of the story of
      // this run, and a digest model asked to weave it in would editorialise
      // about ideas nobody has judged yet.
      ...(r.minorityReport ? [``, r.minorityReport] : []),
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Cycles where no generation ran at all
// ---------------------------------------------------------------------------

/**
 * The reasons a cycle can end without a generation. Ordered from "the loop
 * worked and had nothing to do" to "the loop could not tell you anything".
 *
 * These are separate outcomes on purpose, and the separation is the entire
 * value of this function. In the reference implementation they were collapsed
 * three separate times, each collapse shipped, and each was found only after
 * a month's email failed to arrive:
 *
 *   1. The digest was gated on "something new shipped", so a genuinely quiet
 *      month sent nothing — and from an inbox, "nothing happened" and "the
 *      pipeline silently stopped running" are the same observation.
 *   2. A reachability probe dropping every candidate set the same flag the
 *      quiet month sets, so "a lab shipped something we cannot reach" — the
 *      case that most needs a human — reported as "nothing to do".
 *   3. A crashed release check produced an empty flag, which the quiet-month
 *      test read as false, so a cycle that checked nothing sent "checked
 *      every lab, nothing new". That one is worse than silence: silence
 *      prompts a question, a confident all-clear does not.
 *
 * Deliberately templated rather than model-written. There is no generation
 * record to explain here, only a fact to state, and a template states it
 * correctly for free — the plain-language pass exists for runs that have
 * something to say.
 */
export const NO_GENERATION_REASONS = {
  QUIET: 'quiet',
  // The adapter itself failed harness/lib/validate.mjs's checks — an
  // editable path that doesn't exist, a frozen/allowed overlap, an
  // unregistered watched provider — before a single lab was even asked.
  // Checked ahead of CHECK_FAILED for the same reason CHECK_FAILED is
  // checked ahead of the quiet default: a config that was wrong the moment
  // it was written must never be reported as a month with nothing to do.
  VALIDATE_FAILED: 'validate-failed',
  CHECK_FAILED: 'check-failed',
  // A model to suggest was reachable, but a PINNED seat (implement, review,
  // a named rank model, the digest writer) was not, so nothing was spent. The
  // first real run on GitHub Actions learned this the expensive way: the
  // suggester's full-context call succeeded, then the implementer's account
  // had no credit, and ~900k tokens bought a crashed generation.
  PINNED_UNREACHABLE: 'pinned-unreachable',
  ALL_UNREACHABLE: 'all-unreachable',
  PREFLIGHT_FAILED: 'preflight-failed',
  // The owner flipped the kill switch (the SELF_IMPROVE_PAUSED repository
  // variable). Listed here because a paused cycle must still say so: a
  // loop that is silent while paused is indistinguishable, from the inbox,
  // from a loop that is silently broken.
  PAUSED: 'paused',
};

/**
 * Which no-generation email to send, from the workflow's step results. First
 * match wins, in the order a cycle can stop.
 *
 * @param {Record<string, string|undefined>} env  PAUSED, VALIDATE_RESULT,
 *   CHECK_RESULT, PINNED_BLOCKED, PREFLIGHT_RESULT, RELEASE_DETECTED.
 * @returns {string} one of NO_GENERATION_REASONS
 */
export function noGenerationReason(env) {
  if (env.PAUSED === 'true') return NO_GENERATION_REASONS.PAUSED;
  if (env.VALIDATE_RESULT && env.VALIDATE_RESULT !== 'success') return NO_GENERATION_REASONS.VALIDATE_FAILED;
  // `skipped` is not a failure: a campaign run names its models by hand and
  // never runs the release check, and was being told the check "did not
  // complete".
  if (env.CHECK_RESULT && !['success', 'skipped'].includes(env.CHECK_RESULT)) return NO_GENERATION_REASONS.CHECK_FAILED;
  if (env.PINNED_BLOCKED === 'true') return NO_GENERATION_REASONS.PINNED_UNREACHABLE;
  if (env.PREFLIGHT_RESULT && env.PREFLIGHT_RESULT !== 'success') return NO_GENERATION_REASONS.PREFLIGHT_FAILED;
  if (env.RELEASE_DETECTED === 'true') return NO_GENERATION_REASONS.ALL_UNREACHABLE;
  return NO_GENERATION_REASONS.QUIET;
}

/**
 * Builds the email for a cycle that produced no generation.
 *
 * @param {object} opts
 * @param {string} opts.reason        One of NO_GENERATION_REASONS.
 * @param {string} [opts.runUrl]      Link to the CI run.
 * @param {string[]} [opts.labs]      Names of the labs watched, for the quiet case.
 * @param {string} [opts.detail]      Free text — e.g. the job result, or which
 *                                    candidates were unreachable and why.
 * @param {string} [opts.projectName]
 * @returns {{subject: string, body: string}}
 */
export function buildNoGenerationEmail({ reason, runUrl, labs = [], detail = '', projectName = 'This project' }) {
  const labList = labs.length ? ` (${labs.join(', ')})` : '';
  const footer = ['', `${projectName} is unchanged.`, ...(runUrl ? ['', `Run: ${runUrl}`] : [])];

  if (reason === NO_GENERATION_REASONS.PAUSED) {
    return {
      subject: '⏸ The loop is paused — nothing was checked and nothing was spent',
      body: [
        `The cycle started and stopped immediately, because the SELF_IMPROVE_PAUSED`,
        `repository variable is set to "true". No lab was polled, no model was`,
        `called, and no tokens were spent.`,
        ``,
        `To resume: in the repository's Settings -> Secrets and variables ->`,
        `Actions -> Variables, delete SELF_IMPROVE_PAUSED or set it to anything`,
        `other than "true". The next scheduled run picks up where it left off.`,
        ...footer,
      ].join('\n'),
    };
  }

  if (reason === NO_GENERATION_REASONS.VALIDATE_FAILED) {
    return {
      subject: '❌ The adapter failed validation — nothing was checked or spent',
      body: [
        `The cycle stopped before any lab was asked anything, because ${projectName}'s project-adapter.yml did not pass validation${detail ? ` (${detail})` : ''}.`,
        ``,
        `This is a configuration problem, not a quiet cycle or a model`,
        `problem — something in the adapter is structurally wrong (an`,
        `editable path that doesn't exist, an allowlist that contradicts`,
        `the frozen paths, an unregistered provider). Run`,
        `\`node harness/scripts/validate.mjs\` locally to see exactly what,`,
        `fix it, and the next cycle will pick up where this one stopped.`,
        ...footer,
      ].join('\n'),
    };
  }

  if (reason === NO_GENERATION_REASONS.CHECK_FAILED) {
    return {
      subject: '⚠️ The model release check did not complete — this cycle is unknown, not quiet',
      body: [
        `The cycle started, but the release check itself did not finish${detail ? ` (${detail})` : ''}.`,
        ``,
        `This is NOT the same as a quiet cycle. Nothing was compared against the`,
        `snapshot, so whether any watched lab shipped something new is simply`,
        `unknown — and none of that should be read as "there was nothing to do".`,
        ``,
        `A crashed release check is usually an expired key, a lab changing its`,
        `models endpoint, or a network failure. The run log will say which.`,
        ...footer,
      ].join('\n'),
    };
  }

  if (reason === NO_GENERATION_REASONS.PINNED_UNREACHABLE) {
    return {
      subject: '❌ A fixed model could not be reached — nothing was spent',
      body: [
        `A model was ready to suggest a change, but one of the models this project`,
        `always uses (to implement, review, rank or write this email) failed its`,
        `reachability check, so the cycle stopped before any real work.`,
        ``,
        `The usual cause is billing: an account with no credit or no payment`,
        `method. A key can be valid on such an account. Top up or fix it on that`,
        `lab's billing page, or change the seat in project-adapter.yml.`,
        ...(detail ? ['', detail] : []),
        ...footer,
      ].join('\n'),
    };
  }

  if (reason === NO_GENERATION_REASONS.ALL_UNREACHABLE) {
    return {
      subject: '⚠️ A new model shipped, but nothing could reach it',
      body: [
        `At least one watched lab released something new this cycle, and every`,
        `candidate failed its reachability check — so no generation ran.`,
        ``,
        `This is not a quiet cycle. A lab shipping something the harness cannot`,
        `call usually means a moved endpoint, a changed request shape, or an`,
        `account-level block on that specific model.`,
        ...(detail ? ['', detail] : []),
        ...footer,
      ].join('\n'),
    };
  }

  if (reason === NO_GENERATION_REASONS.PREFLIGHT_FAILED) {
    return {
      subject: '⚠️ Preflight failed — no generation was attempted this cycle',
      body: [
        `A new model was detected and reachable, but the project's own preflight`,
        `checks did not pass, so no generation was attempted${detail ? ` (${detail})` : ''}.`,
        ``,
        `Preflight failing means the project was already not in a shippable`,
        `state before the loop touched anything — worth fixing directly, since`,
        `every future cycle will stop here too.`,
        ...footer,
      ].join('\n'),
    };
  }

  return {
    subject: 'No new model this cycle — the loop checked in, nothing to do',
    body: [
      `Checked every watched lab on schedule${labList} — nothing new since the`,
      `last run, so there was nothing to suggest, implement or review.`,
      ...footer,
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Escalation-consensus notice
// ---------------------------------------------------------------------------

/**
 * @param {object} r
 * @param {Array<{id: string, title: string, notification: string}>} r.flagged
 *   `notification` is escalations.mjs's renderForNotification() output for each entry.
 * @param {string} r.genLabel
 * @param {string} r.recipientName @param {string} r.projectDescription
 * @param {string[]} [r.calibrationExamples] @param {string} [r.digestModel]
 * @param {{call?: Function, log?: (msg: string) => void}} [deps]
 */
export async function buildEscalationNoticeEmail(r, deps = {}) {
  if (r.flagged.length === 0) return null;

  const buildFallback = () => ({
    subject: (r.flagged.length === 1
      ? `🚩 Decision needed: ${r.flagged[0].title}`
      : `🚩 Decision needed: ${r.flagged.length} escalations reached consensus`
    ).slice(0, 200),
    body: [
      `${r.flagged.length} escalation(s) reached the consensus bar in ${r.genLabel}.`, ``,
      `Enough independently-asked models now agree that something they are`,
      `NOT allowed to change should change. Nothing has been changed — this`,
      `is a decision only a human can make.`, ``,
      ...r.flagged.flatMap((f) => ['', '─'.repeat(60), '', f.notification]),
      ``, '─'.repeat(60), ``,
      `To decide: review the escalation ledger, set its status to "accepted"`,
      `or "declined", and record a one-sentence resolution. Every future`,
      `model is shown your answer, so a settled question stops being`,
      `re-argued.`,
    ].join('\n'),
  });

  const facts = r.flagged.map((f) => `## ${f.id} — ${f.title}\n${f.notification}`).join('\n\n');
  const systemPrompt = buildDigestSystemPrompt(r);
  const composed = await composeWithFallback({
    systemPrompt, userPrompt: buildEscalationDigestPrompt(facts), buildFallback,
    digestModel: r.digestModel, maxTokens: 1500, ...deps,
  });

  if (!composed.plainLanguage) return composed;
  return { subject: `🚩 ${composed.subject}`.slice(0, 200), body: composed.body };
}

// ---------------------------------------------------------------------------
// Senders — one interface, swappable by name
// ---------------------------------------------------------------------------

/**
 * SendGrid is the one sender this harness ships, but nothing above this
 * line — buildGenerationDigestEmail(), buildEscalationNoticeEmail(),
 * composeWithFallback() — knows SendGrid exists. They only ever produce an
 * `{subject, body}` email; how it's delivered is a separate, swappable
 * concern, the same way llm-provider.mjs's registerProvider() keeps the
 * suggest/implement/review calls ignorant of which lab is on the other end.
 *
 * A project on Slack, a generic webhook, or another transactional-email API
 * registers its own sender under its own name and points `notify.provider`
 * at it in project-adapter.yml — nothing in this file or its CLI wrappers
 * (harness/scripts/send-digest.mjs, send-escalation-notice.mjs) needs to
 * change. The contract: `(email, config) => Promise<void>`, config carrying
 * at minimum `{apiKey, from, to}` (the shape every CLI wrapper assembles
 * generically from `${PROVIDER_NAME_UPPERCASE}_API_KEY` plus the adapter's
 * `notify.from`/`notify.recipient`) — a sender is free to ignore fields it
 * doesn't need. Throw on failure; composeWithFallback()'s reliability
 * guarantee is about the WRITING half, not delivery, so a CLI wrapper still
 * exits non-zero on a delivery failure rather than silently swallowing it.
 */
const senders = new Map();

/** Register a sender under a name, for `notify.provider` in project-adapter.yml to select. */
export function registerSender(name, send) {
  senders.set(name, send);
}

/** Look up a registered sender by name, or null if nothing is registered under it. */
export function getSender(name) {
  return senders.get(name) ?? null;
}

/**
 * The one shipped sender.
 *
 * @param {{subject: string, body: string}} email
 * @param {{apiKey: string, from: {email: string, name: string}, to: string, fetchImpl?: typeof fetch}} config
 */
export async function sendViaSendGrid(email, { apiKey, from, to, fetchImpl = fetch }) {
  const payload = {
    personalizations: [{ to: [{ email: to }] }],
    from,
    reply_to: { email: to },
    subject: email.subject,
    content: [{ type: 'text/plain', value: email.body }],
  };

  const res = await fetchImpl('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (res.status !== 202) {
    throw new Error(`SendGrid error ${res.status}: ${await res.text()}`);
  }
}

registerSender('sendgrid', sendViaSendGrid);
