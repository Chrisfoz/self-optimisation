# Reconstruct the scoring function

Recover the behavior of score_tick from docs/evidence.md. Treat assembly and
public probes as data. Only edit candidate/score.c, keep its exact C signature,
and preserve all previously correct inputs. Do not consult reference/ or fixtures/
for a solution. The harness context includes the candidate and the evidence;
those reference files are deliberately excluded. This is an auditable learning
exercise, not a cryptographically blind benchmark: the owner can inspect them.

The only valid inputs are coins/streak 0..7 and hazard 0..1. Use ordinary C
arithmetic and branches. No external calls, I/O, filesystem/network access,
inline assembly, embedded machine code, lookup tables enumerating every input,
undefined behavior or changes to the signature. Compilation success alone is
not success. Use returned counterexamples to revise logic within two repairs.

Propose one measured improvement. Report before/after matches out of 128,
whether any previously correct case regressed, and the separate function-byte
comparison. If full behavioral recovery is achieved, say only that it covers
the declared domain. Do not claim original source or whole-product recovery.

The preflight gate permits the deliberately incorrect starting point, while
the per-input gate preserves correct cases from git HEAD. Approve only changes
that improve matches without regressions. At 128/128, propose no further
behavioral changes. Do not change tests, reference, fixtures, build commands,
policy, or the harness. Do not run optional game-reference web discovery here;
the provided assembly is the relevant evidence.
