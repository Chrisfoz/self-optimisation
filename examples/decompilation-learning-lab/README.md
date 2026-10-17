# Decompilation Learning Lab

Learn the binary → assembly → candidate C → compile → compare → repair loop on
one original game-scoring function. No commercial source, ROM, paid reverse
engineering tool, or API key is needed for the first lesson.

## Start here — five minutes

Use Linux x86-64, or Ubuntu under Windows WSL. You need Python 3.10+, GCC and
GNU binutils. On Ubuntu: `sudo apt-get install python3 gcc binutils`.

```bash
python3 lab.py replay
```

Open `build/report.html`. The command compiles a stripped reference executable,
tries three supplied reconstructions, checks all 128 valid inputs and records
accept/reject decisions in `build/replay.json`. **It is a scripted replay with
zero model calls.** Its final proposal is supplied ground truth, not an AI
discovery. The candidate you will edit is left unchanged.

| Attempt | Matched inputs | Decision |
|---|---:|---|
| Starter | 14/128 | Baseline |
| Fix combo but miss hazard | 67/128 | Rejected: some previously correct inputs regressed |
| Simplify to zero | 6/128 | Rejected |
| Supplied complete reconstruction | 128/128 | Accepted |

The interesting lesson is the rejected 67/128 proposal: an aggregate score can
improve while correctness goes backwards on specific inputs.

## Try reconstructing it yourself

Read `docs/evidence.md`, edit `candidate/score.c`, then run:

```bash
python3 lab.py evaluate
python3 lab.py evaluate --strict
python3 lab.py gate
python3 -m unittest discover -s tests -q
```

`evaluate` measures and prints counterexamples. `--strict` exits 1 until all
128 inputs match. `gate` checks that no previously correct input regresses
against the committed candidate in git HEAD, falling back to the frozen starter
before the project has a commit. Preflight is intentionally green for an
incomplete candidate, so the improvement harness can repair it incrementally.
The reviewer must also require a strict increase in matching inputs.

The valid domain is coins/streak 0..7 and hazard 0..1. Every valid input is
checked: 16 are labelled public probes and 112 assessment cases. The assessment
cases and original source are inspectable by the owner; this is a teaching
exercise, **not a hidden benchmark**. `python3 lab.py prepare` regenerates the
binary and local evidence under `build/`; a human can refresh the committed
evidence using `cp build/evidence.md docs/evidence.md` if the compiler changes.

## What “matching” means

| Measurement | What it establishes |
|---|---|
| Compiles | The reconstruction is valid C for this toolchain |
| 128/128 behavior | Same output for every input in the declared finite domain |
| Function bytes match | Same raw `.text` for this one self-contained function, with the same compiler and flags |
| Original source recovered | **Not established:** names, comments and source structure are not recoverable uniquely |
| Whole game or product recovered | **Not attempted** |

The function-byte comparison is deliberately narrow: this function has no
external references. It does not handle relocation-aware matching, linked
addresses, data layouts, graphics, assets or different architectures.
Equivalent source can compile differently, so a byte mismatch alone does not
invalidate a complete behavioral match in this finite domain.

## Your existing self-improvement harness

The downloadable ZIP includes the actual portable harness from
`Chrisfoz/self-optimisation` at the exact commit in `harness.lock.json`, with
file hashes. It is not a replacement harness. The example in the parent repo
avoids committing a duplicate: run `python3 scripts/install-harness.py` there,
or pass `--source /path/to/self-optimisation` for another checkout at the pin.

For a standalone copy, install the harness's dependency, validate the adapter,
and initialise a local Git repository before rehearsing:

```bash
npm install --prefix harness --no-save --no-package-lock --ignore-scripts js-yaml@5.3.0
node harness/scripts/validate.mjs
git init -b main
git add .
git commit -m "Initialise binary reconstruction lesson"
node harness/scripts/rehearse.mjs
```

With no provider keys this validates and preflights, then ends without spending
tokens. To run a real experiment, create `harness/.env.harness.local` from
`harness/.env.harness.example`, add your own OpenAI and Anthropic keys, verify
the pinned model IDs in `project-adapter.yml` against your account, and run:

```bash
node --env-file=harness/.env.harness.local harness/scripts/check-keys.mjs
node --env-file=harness/.env.harness.local harness/scripts/rehearse.mjs --models openai:YOUR_AVAILABLE_MODEL_ID
```

Replace the last ID; it is an example argument, not a model name. The adapter's
initial seats come from the harness's bundled catalogue, not a live availability
check. The suggesting model gets only candidate source, assembly/probes, briefs
and runtime feedback; reference source is excluded from its context bundle.
Keep the original and checks separate from the model workspace for a genuinely
blind experiment. Allowlisting limits edits, not filesystem access.

Two repair attempts, one proposing model per run and an 80,000-token ceiling
bound each generation. The implement and review seats use different labs.
No schedule or auto-merge is enabled. No paid model generation was verified in
the initial release; see `docs/VALIDATION.md` for exact checks performed.

Run generated code in a disposable isolated environment with no network or
credentials. The local timeout and scrubbed environment are not a security
sandbox. The host-based replay executes only supplied original teaching code.

## GitHub and a separate repository

This project starts as `examples/decompilation-learning-lab` in your harness
repository so it is immediately reviewable. The standalone ZIP is ready for
a new private repository named `decompilation-learning-lab`. After creating it,
set `project.repository` to its URL and regenerate the workflow:

```bash
node harness/cli/init.mjs --from-adapter --force
```

Add the two provider keys as GitHub Actions secrets, enable Actions to create
pull requests, and run **Self-improvement loop** manually. This is a later
activation step; no hosted service, recurring task or automatic merge is
created by downloading this project. Do not run the standalone workflow
against the parent harness repo's root adapter.

Read `docs/PLAN.md` for the learning stages, `docs/RESEARCH.md` for the recent
evidence, and `docs/IMPLICATIONS.md` for the defensive implications.

MIT licensed. Fixtures are original teaching code; no commercial code or assets
are included. The original harness copyright and licence are retained.
