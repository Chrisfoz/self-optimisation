# Adding a provider

The principles behind this checklist — and the incidents that produced each
one — are in [`../../learning/02-blueprint.md`](../../learning/02-blueprint.md#5b-onboarding-a-new-provider-into-the-rotating-seat)
§5b and [`../../learning/01-principles.md`](../../learning/01-principles.md)
principles 6, 6b, 6c and 6d. Read those first if you haven't onboarded a lab
before — this file is the mechanical steps against *this* harness's actual
API, not a restatement of why they matter.

## The mechanical steps

1. **Create `harness/providers/<lab>.mjs`.** Look at
   [`anthropic.mjs`](anthropic.mjs) (a bespoke entry) or
   [`moonshot.mjs`](moonshot.mjs) (built from the shared
   [`openAiCompatible()`](_openai-compatible.mjs) factory) as templates —
   most new labs speak some OpenAI-shaped dialect and want the factory, not a
   bespoke `body`/`parse` pair.

2. **Call `registerProvider(name, config)`** as the file's only top-level
   side effect. Required fields: `envKey`, `hostname`, `path`, `headers`,
   `body`, `parse`. Optional: `pattern` (for id-based fallback resolution —
   see below), `truncationReasons` (defaults to none, which means a
   truncated response from this provider will never be detected as
   truncated — almost certainly not what you want), `retryWithAdjustedBody`
   (a hook for a quirk discovered only from a live 4xx — see
   `llm-provider.mjs`'s doc on that field).

3. **Probe the real call shape live, with a real key, before wiring it into
   anything that spends money unattended.** A model id existing in a
   catalogue is not the same as it answering the request shape this file
   sends — a reasoning-tier or otherwise differently-served model can 404 on
   the exact endpoint every other model in the same family accepts. Send a
   trivial request through the file you just wrote and confirm you get
   `{text: "..."}` back before it's ever called from an unattended run.

4. **Add the file to `harness/providers/index.mjs`** if this provider should
   ship by default, or leave it out and have the target project's own setup
   import it directly — a project's `providers.watched` list (see
   `harness/project-adapter.example.yml`) only needs the labs it
   actually watches imported.

5. **Add the env var to whatever secret store the target CI uses**, and
   document it. A lab whose models can trigger a run but whose key is
   missing produces a run that cannot execute — loud is better than
   confusing, but neither is as good as documented in advance.

## Two things worth getting right before you ship it

**`pattern` is the fallback, not the primary dispatch mechanism.** Wherever
a model id is discovered — a release-detection catalogue, a forced override
— it should carry its provider explicitly alongside it, and callers should
prefer that explicit tag over calling `resolveProvider()` at all.
`resolveProvider()`'s pattern table exists for the case where nobody said,
which in practice is mostly a manual/forced run. This is why
`providers/zai.mjs`'s pattern can honestly admit it's "a genuine guess" for
an id another lab's marketplace also reships under the same bare name — the
guess is a fallback of a fallback, not the thing doing the real work.

A pinned seat is the one place a person, rather than a catalogue, supplies
the id — so it can say who serves it too: `roles.<seat>.provider` in
`project-adapter.yml` is pinned onto the exact id at startup
(`pinModelProvider()`), ahead of the pattern table. That is what keeps a
model released under a name no pattern anticipated usable without editing a
regex in this repository, which is the only sort of change this harness must
never require in order to run a model that shipped this morning. Your
`pattern` still earns its place for every id nobody named a lab for.

**Any per-provider quirk gets a named hook, not a branch on provider name
elsewhere.** If you find yourself wanting to add `if (resolved === 'yourlab')`
to `llm-provider.mjs`, stop — that's exactly the shape of bug this split was
built to prevent. Add a field to `registerProvider`'s config shape instead
(see `retryWithAdjustedBody` for the existing example), so the quirk lives on
the provider that has it and the core stays provider-blind. Two real quirks
already live in this pattern: `providers/openai.mjs`'s legacy
`max_completion_tokens` fallback, and `providers/zai.mjs`'s forced
`reasoning_effort` (via `extraBody`, since that field exists for exactly
this — a lab-specific request field with nowhere else to live without
special-casing every other OpenAI-shaped entry for one lab's requirement).
