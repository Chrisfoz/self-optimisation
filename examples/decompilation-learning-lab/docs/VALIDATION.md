# Validation — 17 October 2026

Environment: Linux x86-64, Python 3.12.14, Node 24.19.0, GCC 13.3.0,
GNU binutils, js-yaml 5.3.0. The workflow uses Node 22; remote execution has
not yet been observed at the time this record is written.

| Check | Observed result |
|---|---|
| Eight Python tests | Passed: domain coverage, correct reconstruction, incorrect starter, per-input non-regression, compilation error, strict exit status and replay integrity |
| Three harness integration tests | Passed: adapter/allowlist, source-context exclusion, manual workflow and bounded configuration |
| Actual reference executable | Built from original fixture and stripped; run across all 128 inputs |
| Scripted replay | Starter 14/128; partial 67/128 rejected for regressions; zero 6/128 rejected; supplied ground truth 128/128 accepted |
| Function `.text` comparison | Final supplied reconstruction matches; measured separately from behavior |
| Portable harness pin | All 90 installed source files verified against SHA-256 lock; downloaded bytes also checked against upstream Git blob hashes |
| Adapter validation | Passed; expected warnings for missing OpenAI and Anthropic keys |
| Real rehearsal CLI with no keys | Validation, three preflight commands and release detector ran; detector skipped both labs; no generation or model call occurred |
| Tracked source after rehearsal | Only the empty initial model snapshot was committed by the existing harness; candidate stayed unchanged |

This validates the mechanics and installation. It does not establish how well
an AI model reconstructs the function. The next experiment requires live model
credentials and the acceptance evidence described in PLAN.md.

The replay report is a generated HTML file. Its data and structure are checked;
browser-based visual inspection was unavailable in the creation environment.

The non-regression gate compares against the candidate in git HEAD during
uncommitted harness attempts. Outside a Git checkout it falls back to the frozen
starter. Assessment cases are inspectable and may appear in runtime feedback;
they are not a secret benchmark. Timeout and environment scrubbing are not an
execution sandbox.
