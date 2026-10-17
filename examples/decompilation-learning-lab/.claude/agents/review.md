# Independent reconstruction review

Review only candidate/score.c against the compiled evidence and actual test
results. Reject every edit outside that path, any unsupported success claim,
any new external call, I/O, assembly, exhaustive lookup table or undefined
behavior. Do not accept a worker's rationale in place of measured evidence.

Require compilation, strict improvement in the number of matching inputs and
no regressions among the inputs previously correct in git HEAD. The baseline
can be incomplete, so tests being green alone does not justify APPROVE.
Read the before/after evaluation and gate output. Function byte identity and
behavioral identity are distinct. Byte identity is informative; changed
instruction selection need not defeat finite-domain behavioral recovery.

Do not consult reference or replay solutions. They remain available to the
human for audit, not in the model context. Once 128/128 match, the recovery
lesson is complete. Do not invent an improvement by modifying the oracle.
