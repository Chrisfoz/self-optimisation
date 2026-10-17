#!/usr/bin/env node

/**
 * Loads a project's project-adapter.yml — the file that answers "which
 * paths may this project's agent edit, which providers should it watch,
 * what commands must pass" for one specific installation. See
 * examples/carrotgame/project-adapter.yml for a real, worked instance and
 * Portable-Harness-Design.md §5 for the schema this was validated against.
 *
 * THIS IS THE ONLY FILE IN THE HARNESS THAT KNOWS ABOUT YAML. Every other
 * kernel component (llm-provider.mjs, edit-format.mjs,
 * model-release-detector.mjs, probe-models.mjs) takes plain JS objects and
 * has zero npm dependencies — that stays true. `js-yaml` is scoped to this
 * one file on purpose: it is the one place a project's own config has to be
 * parsed from a human-editable format, and everywhere else in the harness
 * should keep working even if this file, or the dependency it needs, is
 * unavailable for some reason. Callers treat a missing or unparseable
 * adapter as "no adapter" (see loadAdapter's return value), not as a fatal
 * error — CLI flags and environment variables remain a complete fallback
 * for every value this file can supply. That's deliberate: a project
 * without a project-adapter.yml yet, or one just trying the harness for the
 * first time, is not blocked from running anything in it.
 */

import fs from 'fs';
import path from 'path';

/**
 * Load and parse a project-adapter.yml.
 *
 * `js-yaml` is imported dynamically, INSIDE this function, after the
 * existence check below — not as a static top-level import. That's not a
 * style choice: a static top-level `import 'js-yaml'` here would make it
 * a hard dependency of every caller of this module, including
 * check-model-releases.mjs, which imports adapter.mjs unconditionally.
 * Every project that never creates a project-adapter.yml — which is a
 * completely valid, supported way to use this harness — would then need
 * `npm install` for a dependency it never actually exercises. Deferring the
 * import until the file is confirmed to exist keeps that promise true: no
 * project-adapter.yml, no dependency on js-yaml being installed, ever.
 *
 * @param {string} [filePath]  Defaults to project-adapter.yml in the
 *   current working directory — the target project's root, the same
 *   assumption harness/scripts/check-model-releases.mjs already makes for
 *   its snapshot file.
 * @returns {Promise<object|null>}  The parsed adapter, or null if the file
 *   doesn't exist. Never throws on a missing file; DOES throw on a file
 *   that exists but fails to parse — a malformed adapter that gets silently
 *   ignored is worse than a loud failure, since a silently-ignored one
 *   falls back to defaults that may be wrong for this specific project in a
 *   way nobody would notice until an autonomous run did the wrong thing.
 */
export async function loadAdapter(filePath = path.join(process.cwd(), 'project-adapter.yml')) {
  if (!fs.existsSync(filePath)) return null;

  // js-yaml v5 ships named exports only, no default — `load()` is always
  // the safe variant (no arbitrary JS type tags), which is what a
  // project's own config file should be parsed with regardless.
  const { load: parseYaml } = await import('js-yaml');

  const raw = fs.readFileSync(filePath, 'utf8');
  let parsed;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(`${filePath} exists but could not be parsed as YAML: ${err.message}`);
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`${filePath} exists but did not parse to an object (got ${JSON.stringify(parsed)}).`);
  }

  return parsed;
}

/**
 * Parse adapter YAML from a string — for callers that hold the text of a
 * particular git ref rather than a file on disk (the guard comparing the
 * goal before and after a change). Same lazy js-yaml import, same
 * fail-loud-on-malformed rule as loadAdapter().
 */
export async function parseAdapterText(text) {
  const { load: parseYaml } = await import('js-yaml');
  const parsed = parseYaml(text);
  if (parsed === null || typeof parsed !== 'object') throw new Error('adapter text did not parse to an object');
  return parsed;
}

/**
 * The committed goal (docs/curiosity/C1-committed-goal.md): what this
 * project is trying to become, stated once by a human, frozen, and shown
 * to every stage. `Usefulness` has no referent without it.
 *
 * Returns null when no goal is configured — everything then works exactly
 * as before, and the byte-identity tests hold. Throws when `project.goal`
 * is present without a `statement`: a half-specified goal silently ignored
 * is worse than none. `holds` and `away_from` are capped at 8 entries of
 * 300 characters each, so a goal cannot quietly become a second brief.
 *
 * @returns {{statement: string, holds: string[], awayFrom: string[]}|null}
 */
export function goalConfig(adapter) {
  const goal = adapter?.project?.goal;
  if (goal === undefined || goal === null) return null;
  const statement = typeof goal === 'string' ? goal.trim() : typeof goal.statement === 'string' ? goal.statement.trim() : '';
  if (!statement) throw new Error('project.goal is present but has no statement — write one, or remove the goal.');
  const list = (v) => (Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 8).map((x) => x.slice(0, 300));
  return {
    statement: statement.slice(0, 1000),
    holds: typeof goal === 'string' ? [] : list(goal.holds),
    awayFrom: typeof goal === 'string' ? [] : list(goal.away_from),
  };
}

/**
 * Provider names this adapter says to watch, or null if the adapter has no
 * opinion (missing file, or no `providers.watched` section) — callers
 * should fall back to their own default (e.g. "every registered provider")
 * rather than treating null as "watch nothing".
 *
 * Accepts both shapes seen in the wild: a bare list of names
 * (`['anthropic', 'openai']`) and the more explicit list of objects
 * (`[{lab: 'anthropic', env_var: 'ANTHROPIC_API_KEY'}]`) used in
 * examples/carrotgame/project-adapter.yml — the env var name itself is
 * documentation for a human reading the file, since llm-provider.mjs's
 * getProvider() already knows each registered provider's real envKey.
 */
export function watchedProviders(adapter) {
  const watched = adapter?.providers?.watched;
  if (!watched) return null;
  return watched.map((entry) => (typeof entry === 'string' ? entry : entry.lab));
}

/** Path to the model-release snapshot file, or null if unset. */
export function snapshotPath(adapter) {
  return adapter?.providers?.snapshot_path ?? null;
}

/** Max fan-out for newly released models, or null if unset. */
export function maxFanout(adapter) {
  const value = adapter?.providers?.max_fanout;
  return Number.isFinite(value) ? value : null;
}

/** Editable-path allowlist config, ready for edit-format.mjs's compileAllowlist(). */
export function constitutionAllowlist(adapter) {
  return {
    allowedPaths: adapter?.constitution?.allowed_paths ?? [],
    createOnlyPaths: adapter?.constitution?.create_only_paths ?? [],
  };
}

/**
 * Guard rule config, ready for harness/lib/glob.mjs's globToRegExp() to
 * turn frozenPaths/appendOnlyPaths into the RegExp[] guard.mjs's
 * checkGuardedPaths() expects. Returned as raw glob strings here rather
 * than pre-converted — same reasoning as constitutionAllowlist() staying
 * raw: this file's job is YAML -> plain JS, not YAML -> a specific
 * consumer's internal shape.
 */
export function guardConfig(adapter) {
  return {
    frozenPaths: adapter?.constitution?.frozen_paths ?? [],
    appendOnlyPaths: adapter?.constitution?.append_only_paths ?? [],
    frozenFields: adapter?.constitution?.frozen_fields ?? {},
    maxFiles: Number.isFinite(adapter?.constitution?.churn_ceiling?.max_files)
      ? adapter.constitution.churn_ceiling.max_files
      : null,
    maxLines: Number.isFinite(adapter?.constitution?.churn_ceiling?.max_lines)
      ? adapter.constitution.churn_ceiling.max_lines
      : null,
  };
}

/**
 * The two approval classes a project may choose between, and the one that
 * anything unrecognised falls back to.
 *
 * `human-approval-required` means the loop pushes its agent branch, runs
 * every gate against it, and then opens a pull request for a person to
 * merge. `autonomous-merge` means the loop merges and tags the branch
 * itself once every gate has passed (harness/lib/promote.mjs).
 *
 * DEFAULT_APPROVAL_CLASS is the human one on purpose, and every unknown
 * value resolves to it rather than to autonomous merge: a typo, an older
 * adapter written before this field was read by anything, or a value some
 * future console writes that this version doesn't know must never be the
 * reason a project starts merging its own changes unattended. Fail closed
 * is the whole convention here (learning/01-principles.md, 13) — this is
 * the field where it matters most.
 */
export const APPROVAL_CLASSES = ['human-approval-required', 'autonomous-merge'];
export const DEFAULT_APPROVAL_CLASS = 'human-approval-required';

/**
 * Normalise any value into one of APPROVAL_CLASSES.
 *
 * Exported separately from approvalClass() below because
 * harness/lib/scaffold.mjs needs the same fail-closed rule when it renders
 * a workflow from an answers object that never went through a
 * project-adapter.yml — one definition, one test, one behaviour.
 *
 * @param {unknown} value
 * @returns {'human-approval-required'|'autonomous-merge'}
 */
export function normalizeApprovalClass(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return APPROVAL_CLASSES.includes(trimmed) ? trimmed : DEFAULT_APPROVAL_CLASS;
}

/**
 * Which approval class this project chose — read from
 * `constitution.approval_class`, which is where
 * examples/carrotgame/project-adapter.yml already puts it, with a
 * top-level `approval_class` accepted as a fallback because
 * harness/project-adapter.example.yml documented it there while the field
 * was RESERVED.
 *
 * Consumed by harness/lib/scaffold.mjs, which selects between the generated
 * workflow's pull-request and autonomous-merge paths from it. Deliberately
 * NOT consumed at runtime by promote.mjs: which path exists is a property
 * of the workflow file that got generated, not something a script decides
 * mid-run from a file the agent's own branch could in principle have
 * edited.
 */
export function approvalClass(adapter) {
  return normalizeApprovalClass(
    adapter?.constitution?.approval_class ?? adapter?.approval_class
  );
}

/**
 * Memory config — where the escalation ledger and themes reviews live, and
 * the consensus bar. Consumed by harness/lib/orchestrator.mjs's
 * runGeneration() (the ledger path and consensus bar), by
 * harness/lib/themes.mjs's loadLatestThemesReview() on the read side
 * (themesDir), and by harness/scripts/generate-themes-review.mjs on the
 * write side — which is what finally reads `themesCadence`, previously
 * parsed here, unit-tested, and used by nothing.
 */
export function memoryConfig(adapter) {
  return {
    ledgerPath: adapter?.memory?.escalation_ledger ?? null,
    consensus: {
      models: Number.isFinite(adapter?.memory?.escalation_consensus?.models)
        ? adapter.memory.escalation_consensus.models
        : null,
      labs: Number.isFinite(adapter?.memory?.escalation_consensus?.labs)
        ? adapter.memory.escalation_consensus.labs
        : null,
    },
    // How long an escalation may sit below the consensus bar, untouched,
    // before the next fan-out is asked about it by name. Null means "use
    // escalations.mjs's own default" — see DEFAULT_RESURFACE_AFTER there
    // for why silence needed a mechanism at all.
    resurfaceAfter: Number.isFinite(adapter?.memory?.escalation_consensus?.resurface_after)
      ? adapter.memory.escalation_consensus.resurface_after
      : null,
    themesDir: adapter?.memory?.themes_review?.dir ?? null,
    themesCadence: Number.isFinite(adapter?.memory?.themes_review?.cadence_generations)
      ? adapter.memory.themes_review.cadence_generations
      : null,
  };
}

/**
 * Where a project keeps its filled-in brief files — see
 * harness/templates/agent-brief.md.tmpl and reviewer-brief.md.tmpl. These
 * are read as plain text and become system prompts directly (see
 * orchestrator.mjs's own doc comment for why: the brief IS the prompt, not
 * a summary of it read separately).
 */
export function briefPaths(adapter) {
  return {
    agentBriefPath: adapter?.roles?.agent_brief_path ?? null,
    reviewerBriefPath: adapter?.roles?.reviewer_brief_path ?? null,
  };
}

/** Which models fill which seat, and how many refine attempts are allowed. Consumed by orchestrator.mjs's runGeneration(). */
export function rolesConfig(adapter) {
  return {
    suggestMaxTokens: Number.isFinite(adapter?.roles?.suggest?.max_output_tokens)
      ? adapter.roles.suggest.max_output_tokens
      : null,
    implementMaxTokens: Number.isFinite(adapter?.roles?.implement?.max_output_tokens)
      ? adapter.roles.implement.max_output_tokens
      : null,
    implementModel: adapter?.roles?.implement?.model ?? null,
    // Anthropic's output_config.effort for the implement and review seats
    // (low | medium | high | xhigh | max). Null sends nothing, and the lab's
    // default applies. See providers/anthropic.mjs for why it is opt-in.
    implementEffort: adapter?.roles?.implement?.effort ?? null,
    // Anthropic prompt caching on the implementer's stable prompt. On unless
    // set to false (see providers/anthropic.mjs's userBlocks()).
    implementPromptCache: adapter?.roles?.implement?.prompt_cache ?? null,
    reviewEffort: adapter?.roles?.review?.effort ?? null,
    reviewModel: adapter?.roles?.review?.model ?? null,
    rankModel: adapter?.roles?.rank?.model ?? null,
    // The lab serving each pinned model, when the installation named one
    // rather than leaving it to be guessed from the id. Null is the normal
    // case and means "resolve by pattern" — see llm-provider.mjs's
    // pinModelProvider() for why naming it has to be possible at all.
    implementProvider: adapter?.roles?.implement?.provider ?? null,
    reviewProvider: adapter?.roles?.review?.provider ?? null,
    rankProvider: adapter?.roles?.rank?.provider ?? null,
    maxAttempts: Number.isFinite(adapter?.roles?.refine?.max_attempts)
      ? adapter.roles.refine.max_attempts
      : null,
    // Seat promotion by track record (harness/lib/seats.mjs's
    // promotionCandidate()). Null means never promote — the default, since
    // this hands the implement seat to a model nobody pinned.
    promotionThreshold: Number.isFinite(adapter?.roles?.promotion?.implement_after_self_implemented_approvals) && adapter.roles.promotion.implement_after_self_implemented_approvals > 0
      ? adapter.roles.promotion.implement_after_self_implemented_approvals
      : null,
  };
}

/**
 * The three settings of the ambition dial, and the one anything
 * unrecognised falls back to.
 *
 *   focused    every generation is focused: one small, localised change.
 *   earned     (DEFAULT) focused until the track record earns an ambitious
 *              generation — context-pack.mjs's recommendScope().
 *   ambitious  every generation is ambitious: structural work, several
 *              files, several hundred lines, every run.
 *
 * Unknown values resolve to `earned`, not to `ambitious`: a typo must
 * never be the reason a project starts attempting structural change on
 * every run. See docs/Ambition-Control.md for the risks of each setting
 * and why rollback exists alongside this dial.
 */
export const AMBITION_LEVELS = ['focused', 'earned', 'ambitious'];
export const DEFAULT_AMBITION = 'earned';

/** @returns {'focused'|'earned'|'ambitious'} */
export function normalizeAmbition(value) {
  const trimmed = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return AMBITION_LEVELS.includes(trimmed) ? trimmed : DEFAULT_AMBITION;
}

/**
 * Configuration for context-pack.mjs's builders — the pieces that are
 * always project-specific (a generations directory, an architecture doc,
 * a test-file list, a purposes map for the repo manifest, a platform-notes
 * paragraph). Every field is optional; each corresponding builder already
 * degrades gracefully (returns null, or an empty section) when its input
 * is unset — see context-pack.mjs's own functions.
 */
export function contextConfig(adapter) {
  return {
    generationsDir: adapter?.context?.generations_dir ?? null,
    // Where the record of what each run actually OBSERVED lives — see
    // context-pack.mjs's buildRuntimeEvidence() and
    // docs/curiosity/C10-runtime-evidence.md. Null means "use the default";
    // a project that never writes any evidence simply never gets the
    // section, which is exactly today's prompt.
    runtimeEvidenceDir: adapter?.context?.runtime_evidence_dir ?? null,
    architectureNotesPath: adapter?.context?.architecture_notes?.path ?? null,
    architectureNotesMarker: adapter?.context?.architecture_notes?.append_only_marker ?? null,
    testFiles: adapter?.context?.test_files ?? [],
    purposes: adapter?.context?.purposes ?? {},
    platformNotes: adapter?.context?.platform_notes ?? null,
    historyLimit: Number.isFinite(adapter?.context?.history_limit) ? adapter.context.history_limit : null,
    // Rows of the generation index shown one per generation; older ones are
    // summarised as counts. Null: context-pack.mjs's default.
    indexRows: Number.isFinite(adapter?.context?.index_rows) ? adapter.context.index_rows : null,
    scopeRequired: Number.isFinite(adapter?.context?.scope_required) ? adapter.context.scope_required : null,
    // The ambition dial — see normalizeAmbition() above. Read at RUN time
    // by run-generation.mjs (unlike approval_class, which is baked into the
    // workflow), because it changes what a run attempts, not what a run is
    // permitted to do: the gates are the same at every setting.
    ambition: normalizeAmbition(adapter?.context?.ambition),
    // How the suggestion stage sees the source. 'full-dump' (the default, and
    // where any unrecognised value lands) sends every editable file in full.
    // 'scoped' sends a code map instead; each suggesting model chooses which
    // files to read in full, up to scoped.max_source_chars (code-map.mjs,
    // orchestrator.mjs's suggest()).
    strategy: adapter?.context?.strategy === 'scoped' ? 'scoped' : 'full-dump',
    scopedMaxSourceChars: Number.isFinite(adapter?.context?.scoped?.max_source_chars) ? adapter.context.scoped.max_source_chars : 200000,
    mapMaxChars: Number.isFinite(adapter?.context?.scoped?.map_max_chars) ? adapter.context.scoped.map_max_chars : null,
  };
}

/**
 * Deployment config — ready for harness/lib/verify-deployment.mjs's
 * verifyDeployment() and harness/lib/promote.mjs's promote(). `strategy`
 * defaults to 'none' (not null) since verifyDeployment() treats an unset
 * strategy the same as an explicit 'none' — a project that hasn't
 * configured this yet gets the honest no-op, not a crash.
 *
 * `registry` and `artifact` are only meaningful when `strategy` selects
 * them; each sub-object is returned with every field present (null where
 * unset) rather than omitted, so a caller can spread it straight into
 * verifyRegistry()/verifyArtifact() without an extra existence check.
 */
export function deploymentConfig(adapter) {
  return {
    strategy: adapter?.deployment?.verify_strategy ?? 'none',
    // Matches examples/carrotgame/project-adapter.yml's existing field name
    // — that file predates this accessor, so the accessor conforms to it
    // rather than the reverse.
    siteUrl: adapter?.deployment?.production_url ?? null,
    watchedFiles: adapter?.deployment?.watched_files ?? null,
    runner: adapter?.deployment?.ci?.runner ?? 'ubuntu-latest',
    registry: {
      ecosystem: adapter?.deployment?.registry?.ecosystem ?? null,
      package: adapter?.deployment?.registry?.package ?? null,
      groupId: adapter?.deployment?.registry?.group_id ?? null,
      artifactId: adapter?.deployment?.registry?.artifact_id ?? null,
      version: adapter?.deployment?.registry?.version ?? null,
      versionFile: adapter?.deployment?.registry?.version_file ?? null,
      registryUrl: adapter?.deployment?.registry?.registry_url ?? null,
    },
    artifact: {
      buildCommand: adapter?.deployment?.artifact?.build_command ?? null,
      path: adapter?.deployment?.artifact?.path ?? null,
      smokeCommand: adapter?.deployment?.artifact?.smoke_command ?? null,
    },
  };
}

/**
 * The quality-dimension evaluator plugins this project runs — the
 * measurements that are explicitly NOT gates. See
 * harness/plugins/evaluators/README.md for the interface, and
 * Portable-Harness-Design.md §8.2 for why this is a plugin category rather
 * than something the harness ships opinions about.
 *
 * Note where this sits: `evaluation.test_commands` are the gates (baked into
 * the generated workflow's test steps, and allowed to fail a generation);
 * `evaluation.evaluators` are the dimensions (run afterwards, never able to
 * fail anything). Neighbours in the file, opposites in what they may do.
 *
 * Entries missing a `module` are dropped here rather than reaching the
 * loader: an entry with nothing to load is a typo in the adapter, and the
 * loader's error message would blame the plugin for it.
 *
 * @returns {Array<{module: string, name: string|null, config: object}>}
 */
export function evaluatorConfig(adapter) {
  const list = adapter?.evaluation?.evaluators;
  if (!Array.isArray(list)) return [];
  return list
    .filter((e) => e && typeof e.module === 'string' && e.module.trim())
    .map((e) => ({
      module: e.module.trim(),
      name: typeof e.name === 'string' && e.name.trim() ? e.name.trim() : null,
      config: e.config && typeof e.config === 'object' ? e.config : {},
    }));
}

/**
 * The optional visual-capture plugin — the project-supplied hook that
 * renders the working tree AFTER a generation's edits are applied and
 * attaches the images to the review call (`harness/lib/review.mjs`'s
 * `captureVisual`, which has defaulted to "no visual capture configured for
 * this project" since the port).
 *
 * Same interface as an evaluator plugin (harness/plugins/evaluators/README.md)
 * and loaded the same way, because it IS one — the only difference is when
 * it runs and who reads the result. An evaluator runs after the generation
 * and its images reach the NEXT suggestion prompt; this runs inside the
 * generation and its images reach THIS review. See docs/Tool-Use-Design.md
 * §5 for why the review seat's tools are deliberately a different, smaller,
 * read-only set than the implementer's.
 *
 * Null when unconfigured, which is what keeps the review prompt identical to
 * one from before this existed.
 *
 * @returns {{module: string, name: string|null, config: object}|null}
 */
export function visualCaptureConfig(adapter) {
  const raw = adapter?.evaluation?.visual_capture;
  if (!raw || typeof raw !== 'object' || typeof raw.module !== 'string' || !raw.module.trim()) return null;
  return {
    module: raw.module.trim(),
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null,
    config: raw.config && typeof raw.config === 'object' ? raw.config : {},
  };
}

/**
 * Notify config — ready for harness/lib/notify.mjs. `provider` names a
 * sender registered via notify.mjs's registerSender() — 'sendgrid' ships
 * built in; Slack/webhook/another email API are added by a project
 * registering its own sender under its own name and pointing `provider` at
 * it, not by this file knowing their shapes. `escalationNotice` defaults to
 * true: a project that hasn't turned this off gets notified about a
 * consensus escalation, which is the safer default for something a human
 * has to act on. `calibrationExamplesPaths` are files (relative to the
 * project root) whose contents get passed to notify.mjs's
 * buildDigestSystemPrompt() as calibrationExamples — real, well-received
 * email bodies from this project's own history that calibrate the model's
 * register. Optional; omitted entirely by a fresh project with no history
 * yet, same as buildDigestSystemPrompt() already defaults to.
 */
export function notifyConfig(adapter) {
  return {
    channel: adapter?.notify?.channel ?? null,
    provider: adapter?.notify?.provider ?? null,
    recipient: adapter?.notify?.recipient ?? null,
    recipientName: adapter?.notify?.recipient_name ?? null,
    from: adapter?.notify?.from ?? null,
    digestModel: adapter?.notify?.digest_model ?? null,
    escalationNotice: adapter?.notify?.escalation_notice ?? true,
    calibrationExamplesPaths: adapter?.notify?.calibration_examples ?? [],
  };
}

/**
 * `evaluation.test_commands`, read back — the one deliberate exception to
 * the "recorded, never read back" rule this same field carries in
 * `harness/project-adapter.example.yml`'s closing section. That rule is
 * about the GENERATED WORKFLOW having exactly one source of truth for what
 * CI runs, so a compromised agent branch can never make preflight and the
 * post-change test step disagree about what "the tests" means. A local
 * rehearsal (`harness/scripts/rehearse.mjs`) isn't CI and produces no
 * generated file to be the other source of truth — reading the adapter
 * here is the ONLY way it can know what to run at all, and it reads the
 * base branch's copy for both its preflight and post-change runs within
 * one invocation, so the risk that rule guards against doesn't apply.
 * The shared workflow is the other exception, for the same reason: it has
 * no generated steps to bake the commands into, so
 * harness/lib/workflow-config.mjs reads them once per run, from the default
 * branch before any agent change, and both test gates use that saved copy.
 * Nothing else may treat this as authoritative for what CI executes.
 */
export function evaluationConfig(adapter) {
  const e = adapter?.evaluation ?? {};
  const raw = e.test_commands;
  const passthrough = e.test_env_passthrough;
  return {
    testCommands: Array.isArray(raw) ? raw.filter((c) => typeof c === 'string' && c.trim()) : [],
    // LIVE: run test_commands inside the generation, after each attempt's
    // edits apply and before the review, so a failure is repaired in the
    // loop rather than discovered after it (harness/lib/test-runner.mjs).
    // On unless explicitly false — it costs no tokens, only test time.
    testInLoop: e.test_in_loop !== false,
    testTimeoutSeconds: Number.isFinite(e.test_timeout_seconds) && e.test_timeout_seconds > 0 ? e.test_timeout_seconds : 600,
    // Names of environment variables the in-loop tests may see even though
    // they look like credentials. Empty by default: the tests run on code
    // no reviewer has seen yet, in a process holding every lab's key.
    testEnvPassthrough: Array.isArray(passthrough) ? passthrough.filter((n) => typeof n === 'string' && n) : [],
  };
}

/**
 * The token cap one generation may spend, or null for no cap. Consumed by
 * harness/lib/orchestrator.mjs's runGeneration(): projected before the
 * fan-out and checked between attempts. Tokens rather than money on
 * purpose — see harness/lib/spend.mjs for why — and a cap here bounds one
 * run, not a month: set a spending limit at each provider as well.
 */
export function budgetConfig(adapter) {
  const raw = adapter?.budget?.max_generation_tokens;
  return {
    maxGenerationTokens: Number.isFinite(raw) && raw > 0 ? raw : null,
  };
}
