# Learning and development plan

The central experiment is whether precise executable feedback improves
reconstruction correctness. We improve candidates at runtime; this does not
train model weights or automatically improve a decompiler's learned policy.

| Stage | Three concrete tasks | Completion evidence |
|---|---|---|
| 1. Understand the loop — delivered | Run the replay; inspect the rejected higher-score candidate; edit and evaluate the candidate yourself | Real compiler output, 128-case results, byte comparison and counterexamples |
| 2. Run the existing harness — integrated, live calls pending | Add and check two lab keys; choose available implement/review IDs; run one focused manual campaign | Saved proposal, attempts, test output, token usage, independent verdict and candidate diff |
| 3. Make the experiment harder | Add three original functions (state transition, inventory, movement); add independently generated larger-input assessments; compare one-shot generation with bounded feedback on identical tasks | Per-function correctness and regressions, fixed token/attempt budgets, failures retained |
| 4. Add a real decompiler | Pin Ghidra and export pseudocode for the same fixture; feed pseudocode plus assembly into the same repair loop; compare with assembly-only reconstruction | Reproducible export command, tool version and results for both input settings |
| 5. Demonstrate a recognisable product | Select a source-released game such as DOOM and review its code/asset licences; compile a pinned small function with a pinned toolchain; reconstruct only that function without supplying its source to the candidate process | Provenance, permitted code subset, no bundled commercial assets, independently checked outputs |
| 6. Make a standalone repository | Create Chrisfoz/decompilation-learning-lab as private; unpack the verified bundle and update its repository URL; activate one manual PR-producing workflow | New repo URL, clean baseline CI, reviewed recovery PR; no automatic merge |

## First real model campaign

Keep the starting candidate committed, preserve the exact compiler and evidence,
and record the selected model IDs. Run at most one suggesting model, two repair
attempts and 80,000 total generation tokens. Preserve failed candidates and
counterexamples. Compare a one-shot attempt with the final repair result on the
same declared domain; report the extra cost and number of calls. A single task
demonstrates a mechanism; it cannot establish general superiority.

Advance only when the current stage's evidence exists. Reaching 128/128 finishes
this lesson; it is not a reason to keep spending model tokens on cosmetic edits.

## Why a commercial source tree is not the prerequisite

Decompilation starts from a binary. Source can be retained separately as ground
truth, but supplying it to the model invalidates a source-reconstruction test.
Original fixtures give us known inputs, reproducible binaries and measurable
correctness immediately. A source-released commercial game is a later scale
test, not something needed to get started. No commercial program was acquired,
decompiled or reproduced in this project.
