#!/usr/bin/env node

/**
 * Which lab sits in which seat — and the one rule the literature says
 * matters: the judge should not share a family with the thing it judges.
 *
 * learning/07-whats-actually-new.md §5: self-preference bias in an LLM
 * judge is driven substantially by perplexity — a judge finds its own
 * family's output more fluent and rates it higher — so withholding the
 * authors' names (which rankProposals() already does) blunts the bias
 * without removing it. The mechanical fix is a judge from a different
 * family. That review named it "the most actionable finding from the whole
 * review" and it was still not done: rankModel defaulted to implementModel.
 *
 * Two seats judge. The RANK seat picks which proposal to implement, and it
 * fails safe (an unparseable ranking falls back to the first proposal), so a
 * cross-family default drawn from the model snapshot costs at worst one
 * ranking. The REVIEW seat is the safety gate and fails closed, so it is
 * NOT auto-assigned to a model nobody has vetted; it stays pinned, and this
 * file's job for it is to say, loudly, when it shares the implementer's
 * family.
 *
 * Pure. The snapshot and the "is a key present" check are passed in.
 */

import { resolveProvider } from './llm-provider.mjs';
import { isChatModel } from './model-release-detector.mjs';

/** The lab a model id resolves to, or null when the id matches no registered pattern. */
export function familyOf(model) {
  try {
    return resolveProvider(model);
  } catch {
    return null;
  }
}

/**
 * Describe the three pinned seats by family and say which judges share
 * the implementer's.
 *
 * @returns {{implement: string|null, review: string|null, rank: string|null, reviewSharesFamily: boolean, rankSharesFamily: boolean}}
 */
export function seatFamilies({ implementModel, reviewModel, rankModel }) {
  const implement = familyOf(implementModel);
  const review = familyOf(reviewModel);
  const rank = familyOf(rankModel);
  return {
    implement, review, rank,
    reviewSharesFamily: Boolean(implement) && review === implement,
    rankSharesFamily: Boolean(implement) && rank === implement,
  };
}

/**
 * Choose a ranker from a different family than the implementer, using the
 * detector's snapshot (`{[provider]: string[]}`) as the only catalogue the
 * harness can consult without a network call.
 *
 * Preference order within the candidates: providers in `prefer` first (a
 * project can name its trusted second lab), then any other provider with a
 * key present. Within a provider, the ids are chat-capable ones sorted
 * descending — the same arbitrary-but-stable tie-break the detector uses
 * when a lab publishes no creation date. Returns null when no other family
 * is reachable, and the caller keeps today's behaviour.
 *
 * @param {object} opts
 * @param {string} opts.implementModel
 * @param {object} opts.snapshot        The parsed .agent/model-snapshot.json, or {}.
 * @param {(provider: string) => boolean} opts.hasKey
 * @param {string[]} [opts.prefer]
 * @returns {{id: string, provider: string}|null}
 */
export function pickCrossFamilyRanker({ implementModel, snapshot = {}, hasKey, prefer = [] }) {
  const implement = familyOf(implementModel);
  const providers = Object.keys(snapshot ?? {}).filter((p) => !p.startsWith('_') && p !== implement && Array.isArray(snapshot[p]) && hasKey(p));
  const ordered = [
    ...prefer.filter((p) => providers.includes(p)),
    ...providers.filter((p) => !prefer.includes(p)).sort(),
  ];
  for (const provider of ordered) {
    const ids = snapshot[provider].filter((id) => typeof id === 'string' && isChatModel(id)).sort((a, b) => b.localeCompare(a));
    if (ids.length) return { id: ids[0], provider };
  }
  return null;
}

/**
 * The one-line description a run logs and init prints, so the family
 * split is visible every time rather than discoverable by reading three
 * config fields.
 */
export function describeSeats({ implementModel, reviewModel, rankModel }) {
  const f = seatFamilies({ implementModel, reviewModel, rankModel });
  const line = `implement ${implementModel} (${f.implement ?? '?'}) · review ${reviewModel} (${f.review ?? '?'}) · rank ${rankModel} (${f.rank ?? '?'})`;
  const warnings = [];
  if (f.reviewSharesFamily) {
    warnings.push(
      `the review seat shares the implementer's family (${f.implement}). A shared blind spot stays blind — ` +
      `set roles.review.model to another lab's model you trust. See learning/07-whats-actually-new.md §5.`
    );
  }
  if (f.rankSharesFamily) {
    warnings.push(`the rank seat shares the implementer's family (${f.implement}); a judge prefers its own family's prose.`);
  }
  return { line, warnings, ...f };
}
