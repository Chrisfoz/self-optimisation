# Campaigns

Real generations, with real model calls, run through `harness/` on purpose to
find out what the fake-model test suite cannot — written up whether or not
they went well.

| Date | Projects | Generations | Write-up |
|---|---|---|---|
| 2026-09-11 | Germ Fighter (browser game), ICD mapper (Python CLI) | 4 rehearsed locally, all approved, 2 repaired in the loop after their own tests failed; then 3 on GitHub Actions, each ending in a pull request | [the first real campaigns](2026-09-11-first-real-campaigns.md) |

Each dated folder holds the records exactly as the harness wrote them
(`attempts.json`, `baseline-metrics.json`, `metrics.json`,
`comparison.json`), the project's generated `REPORT.md`, and the installation
that produced them. Source code, diffs and proposal texts are included only
where the project is public.
