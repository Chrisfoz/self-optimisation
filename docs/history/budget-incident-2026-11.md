# Proposals spent the implementer's budget (fixed in 0.3.3)

## What happened

| Run | Suggesters | Reported spend | Outcome |
|---|---|---|---|
| networkinAI gen-015 | 5 × `pre-mock_ptu_auth_v2_*` (qwen) | 6,207,710 tokens (1,240,542 input each) | implement refused by the 2M cap; nothing built |
| Hospital of the Future gen-022 | 1 × `pre-mock_ptu_auth_v2_cross_site_denied` (qwen) | 2,363,015 tokens (2,361,856 of them cache reads) | implement refused; nothing built |

All six "proposals" were the same canned sentence, 这是一个模拟的文本生成结果
("this is a simulated text generation result"). The models were Qwen
test endpoints in its public `/models` listing. The release detector
treated them as new frontier models, and the probe passed them because they
answered. Their reported input was about 4× the prompt's real size: the
same project's real suggesters used about 310k tokens (networkinAI gen-013)
and about 563k (Hospital gen-020).

## Why the harness let it happen

1. **No filter for test endpoints.** The name filter covered embeddings,
   speech and so on, but not `mock`.
2. **Reachable was treated as working.** The probe asked for "OK" and never
   checked the reply.
3. **Any text counted as a proposal.** Canned text won the ranking by
   default and went to the implementer.
4. **One budget pool.** Suggestions could spend the whole cap, so the
   implementer (the only stage that produces code) was refused.
5. **Admission estimated at chars ÷ 4 and believed whatever the provider
   reported afterwards.** Cache reads counted at full weight.

## What 0.3.3 changes

- `model-release-detector.mjs`: the segments `mock`, `fake`, `dummy`, `stub`
  and `placeholder` mark an id as not a chat model.
- `probe-models.mjs`: `checkProbeReply()` drops a model whose probe reply
  does not contain OK.
- `orchestrator.mjs`: `looksLikeProposal()` turns a reply with none of the
  requested fields (and no edit blocks) into a suggestion failure.
- `spend.mjs`: two pools. Discovery (`suggest` and `rank`) is capped at
  `budget.discovery_share` (default 0.4). The build stage gets the rest,
  plus anything discovery left unused, and is never charged for a
  discovery overrun.
- Before the fan-out, the harness asks only as many suggesters as the pool
  can afford. The others are recorded as `fanOut.skippedForBudget`.
- Admission estimates at chars ÷ 3. Cache reads count at 0.1× and writes at
  1.25× (`spend.costTokens`). A reported input more than 2.5× the estimate
  is listed in `spend.implausibleUsage`.
- `context.strategy` defaults to `auto`: full source under 400k characters,
  the code map above that.

Replayed in `tests/lib/orchestrator.test.mjs` and `tests/lib/spend.test.mjs`.
