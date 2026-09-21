/**
 * Pure rendering functions behind `harness/cli/init.mjs` — building the
 * three files a new installation needs (`project-adapter.yml`, a generated
 * `.github/workflows/*.yml`, and a short install README) from one answers
 * object, with no filesystem or stdin access of their own. Same split as
 * everywhere else in this harness: a `lib/` file that takes plain data and
 * returns plain data/strings, testable without mocking I/O, and a `cli/`
 * (here) or `scripts/` file that owns prompting, reading, and writing.
 *
 * `init.mjs` is the only caller that needs to know what a real terminal or
 * a real project layout looks like; everything here just needs the answers
 * it already collected.
 */

import { dump as dumpYaml } from 'js-yaml';
import { normalizeApprovalClass, normalizeAmbition } from './adapter.mjs';

/**
 * The exact js-yaml version the generated workflow installs at run time.
 * Exact, not a range: the job installing it holds a write token, and a
 * floating version is a supply-chain door into every gate. Kept beside
 * package.json's own pin — bump both together.
 */
export const JS_YAML_VERSION = '5.3.0';

/**
 * The Node major the generated workflow runs the harness on. Must satisfy
 * package.json's `engines` minimum — tests/lib/ci-config.test.mjs checks
 * the two agree, because they drifted once already (the template said 20
 * long after nothing here had been tested on it).
 */
export const NODE_VERSION = '22';

/**
 * The parts of `harness/templates/workflow.yml.tmpl` a copied-in workflow and
 * the shared workflow (renderSharedWorkflow()) disagree on, kept here as the
 * copied-in text. The template holds a {{TOKEN}} for each, so one file stays
 * the source of both and neither can drift from the other.
 */
const DISPATCH_TRIGGER = `  workflow_dispatch:
    inputs:
      scope:
        description: 'Force focused or ambitious (blank lets the harness decide)'
        required: false
        type: choice
        options: ['', focused, ambitious]
      models:
        description: 'Campaign mode: comma-separated model ids to run a generation on NOW, instead of waiting for a release. Use lab:model-id when the id does not name its own lab (e.g. qwen:deepseek-v4.1-flash). Recorded as campaign: true.'
        required: false
        type: string
      check_keys:
        description: 'Check the API keys and stop. No model is called and nothing is spent. Runs INSTEAD of a generation.'
        required: false
        type: boolean
        default: false`;

const CONCURRENCY_BLOCK = `# One run at a time, per repository. Two overlapping runs would compute the
# same next generation number, race for the same branch and both push to
# the default branch. Queued rather than cancelled: a run that is already
# spending should finish and record what it spent. (The numbering step also
# claims its branch atomically, so even without this nothing is overwritten.)
concurrency:
  group: self-improvement-\${{ github.repository }}
  cancel-in-progress: false`;

// First line unindented: the template supplies the six spaces before the token.
// `--prefix harness`, not a bare root install. Half of WORKPLAN I10, and the
// half that is one line: a root `npm install` here is silently the PROJECT's
// dependency install, and it has been tested doing real damage — a project
// that depends on js-yaml 4 directly had its copy replaced for the rest of
// the run (`yaml.safeLoad` became undefined), and a project with a hoisted
// js-yaml 3 under @istanbuljs/load-nyc-config, which is the common jest
// shape, had the same done to it. Installing into harness/node_modules
// leaves the project's own tree alone, and Node still resolves it because
// resolution walks up from harness/lib/. The shared workflow never had this
// problem: it installs into its own directory under RUNNER_TEMP.
//
// What remains of I10 is the other half — running `evaluation.setup_commands`
// before this step, so a project that needs its own dependencies installed
// says so once rather than relying on this line to do it by accident.
const COPIED_HARNESS_SETUP = `- name: Install harness dependencies
        shell: bash
        run: npm install --prefix harness --no-save --no-package-lock --ignore-scripts js-yaml@{{JS_YAML_VERSION}}`;

/** The repository path of the shared workflow, in the harness's own repository. */
export const SHARED_WORKFLOW_PATH = '.github/workflows/self-improve.yml';

/** Where a shared installation calls the harness from, unless told otherwise (a fork, say). */
export const SHARED_HARNESS_REPOSITORY = 'Chrisfoz/self-optimisation';

const SHARED_HEADER = `# THE SHARED WORKFLOW. Rendered from harness/templates/workflow.yml.tmpl by
# harness/scripts/render-shared-workflow.mjs. Never edit this file by hand:
# tests/lib/shared-workflow.test.mjs fails when it and the template disagree.
#
# Projects call this file at one pinned commit instead of carrying their own
# copy of harness/ (renderCallerWorkflow() in harness/lib/scaffold.mjs writes
# that caller). It fetches the harness from the repository and commit it was
# called at, reads each project's project-adapter.yml once from the default
# branch, and then runs the same steps a copied-in workflow runs. The notes
# below were written for the copied-in file and hold here too, with two
# differences worth stating before you read them:
#
#   * The MERGE MODEL. Note 1 below says exactly one of the two paths is
#     rendered into the file. That is true of a copied-in workflow and NOT
#     true of this one: both paths are here, each gated on APPROVAL_CLASS,
#     which the config step reads from the calling project's own
#     project-adapter.yml on every run. The field is guarded — a generation
#     cannot edit it — but in this file the answer is in that project's
#     adapter rather than in the YAML you are reading.
#   * The project values. A copied-in workflow has them baked in; this one
#     reads them per run from the project it was called by.
#
`;

const SHARED_TRIGGER = `  # Called by each project's own short workflow, which pins this file to one
  # commit, holds the schedule and the concurrency group, and passes its
  # secrets with \`secrets: inherit\`.
  workflow_call:
    inputs:
      scope:
        description: 'Force focused or ambitious (blank lets the harness decide)'
        required: false
        type: string
        default: ''
      models:
        description: 'Campaign mode: comma-separated model ids to run a generation on NOW, instead of waiting for a release. Use lab:model-id when the id does not name its own lab (e.g. qwen:deepseek-v4.1-flash). Recorded as campaign: true.'
        required: false
        type: string
        default: ''
      check_keys:
        description: 'Check the API keys and stop. No model is called and nothing is spent. Runs INSTEAD of a generation.'
        required: false
        type: boolean
        default: false
      runner:
        description: 'The runner image the loop runs on.'
        required: false
        type: string
        default: ubuntu-latest`;

const SHARED_CONCURRENCY = `# No concurrency group here: the calling workflow holds it. A called
# workflow in the same group as its caller would wait for itself forever.`;

// First line unindented, like COPIED_HARNESS_SETUP.
const SHARED_HARNESS_SETUP = `# The harness comes from the repository and commit this workflow file was
      # called at (job.workflow_repository, job.workflow_sha), fetched by SHA
      # and checked after checkout, so a project runs exactly the code it
      # pinned and nothing a tag or branch could move under it. It lives under
      # RUNNER_TEMP, outside the project, where the project's own tests,
      # linters and commits never see it.
      - name: Fetch the harness this workflow was called at
        shell: bash
        env:
          HARNESS_REPOSITORY: \${{ job.workflow_repository }}
          HARNESS_SHA: \${{ job.workflow_sha }}
        run: |
          if ! printf '%s' "$HARNESS_SHA" | grep -Eq '^[0-9a-f]{40}$'; then
            echo "::error::Could not tell which harness commit this workflow was called at."
            exit 1
          fi
          if ! printf '%s' "$HARNESS_REPOSITORY" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'; then
            echo "::error::Could not tell which repository this workflow was called from."
            exit 1
          fi
          dir="$RUNNER_TEMP/self-optimisation"
          git init -q "$dir"
          git -C "$dir" fetch -q --depth 1 "https://github.com/$HARNESS_REPOSITORY" "$HARNESS_SHA"
          git -C "$dir" -c advice.detachedHead=false checkout -q FETCH_HEAD
          if [ "$(git -C "$dir" rev-parse HEAD)" != "$HARNESS_SHA" ]; then
            echo "::error::The fetched harness is not the commit this workflow was called at."
            exit 1
          fi
          echo "HARNESS_DIR=$dir/harness" >> "$GITHUB_ENV"

      - name: Install harness dependencies
        shell: bash
        run: npm install --prefix "$RUNNER_TEMP/self-optimisation" --no-save --ignore-scripts js-yaml@{{JS_YAML_VERSION}}

      # Read once, here, from the default branch this job checked out, before
      # any agent change exists; every later step uses what this saves
      # (harness/lib/workflow-config.mjs). Before the pause check, so a paused
      # run still knows whether to send its digest. continue-on-error: an
      # unreadable adapter stops the run at the validate step below, and
      # reaches the digest the same way an invalid one does.
      - name: Read this project's configuration
        id: config
        shell: bash
        continue-on-error: true
        run: node "$HARNESS_DIR"/scripts/workflow-config.mjs`;

/** Single-quote a path/command for safe use in a bash argument list — the same escaping bash itself expects. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Indent every line of a (possibly multi-line) block by `spaces`, skipping empty lines. */
function indentBlock(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.length ? pad + line : line))
    .join('\n');
}

/**
 * Every provider whose API key this installation actually needs a secret
 * for — which is NOT the same set as `providers.watched`.
 *
 * `watched` is the detector's scope: which labs get polled for a model that
 * hasn't been seen before, and therefore which labs can win the rotating
 * suggest seat. The implement, review and rank seats are pinned to a model
 * the project chose, and that model may well belong to a lab nobody is
 * watching — pinning the reviewer to `claude-opus-5` while watching only
 * OpenAI is a perfectly reasonable configuration, and the default one
 * (`claude-opus-5` for all three pinned seats) does exactly this for any
 * project that doesn't watch Anthropic.
 *
 * Injecting only the watched labs' secrets is why that configuration used
 * to fail at runtime, mid-run, *after* the suggest call had already been
 * paid for: the improve step had no key for the lab it was about to call.
 * The union is what the workflow needs; `--providers` keeps using the
 * watched list alone, since that genuinely is the detector's scope.
 *
 * A secret that is injected but never set resolves to an empty string in
 * GitHub Actions rather than erroring, so a superset is safe; a subset is
 * not.
 *
 * @param {object} a  Answers object — `providers` (watched) and the
 *   optional `roleProviders` init.mjs resolved from the pinned role models.
 * @returns {Array<{name: string, envKey: string}>} deduped by `name`,
 *   watched labs first, then any extra labs a pinned role model needs.
 */
export function requiredProviders(a) {
  const seen = new Set();
  const out = [];
  for (const p of [...(a.providers || []), ...(a.roleProviders || [])]) {
    if (!p || !p.name || seen.has(p.name)) continue;
    seen.add(p.name);
    out.push({ name: p.name, envKey: p.envKey });
  }
  return out;
}

/**
 * Build the `project-adapter.yml` object for a new installation. Every
 * field init.mjs didn't ask about gets the same default
 * `harness/project-adapter.example.yml` documents, so a generated file is
 * never missing a key the harness's own code expects to be able to read
 * (via harness/lib/adapter.mjs's accessors, which already treat a missing
 * field as "unset," but an explicit default here is more honest about what
 * this project actually got configured with than silence would be).
 *
 * @param {object} a  Answers collected by init.mjs — see that file's own
 *   doc comment for the full shape.
 */
export function buildAdapterObject(a) {
  const adapter = {
    project: {
      id: a.projectId,
      repository: a.repository || undefined,
      default_branch: a.defaultBranch || 'main',
      // The committed goal (docs/curiosity/C1) — present only when the
      // owner wrote one. Frozen: the guard refuses a diff that changes it.
      ...(a.goalStatement ? { goal: { statement: a.goalStatement, holds: a.goalHolds || [], away_from: a.goalAwayFrom || [] } } : {}),
    },
    // Provenance: which harness produced this file. Read by nothing at run
    // time; written so `init --check-upgrade` and a human can tell whether
    // this installation carries a fix that shipped after it was scaffolded.
    // init.mjs supplies it from harness/VERSION via harness/lib/version.mjs.
    harness: {
      version: a.harnessVersion || 'unknown',
      // A shared installation: which harness commit the project's workflow
      // calls, instead of a copy of harness/ in the repository. Read back by
      // `init --from-adapter` to regenerate that workflow at the same pin.
      ...(a.sharedHarness
        ? { shared: { repository: a.sharedHarness.repository || SHARED_HARNESS_REPOSITORY, ref: a.sharedHarness.ref, ...(a.sharedHarness.label ? { label: a.sharedHarness.label } : {}) } }
        : {}),
    },
    providers: {
      watched: a.providers.map((p) => p.name),
      snapshot_path: a.snapshotPath || '.agent/model-snapshot.json',
      max_fanout: Number.isFinite(a.maxFanout) ? a.maxFanout : 8,
    },
    constitution: {
      allowed_paths: a.allowedPaths || [],
      create_only_paths: a.createOnlyPaths || [],
      frozen_paths: a.frozenPaths || [],
      append_only_paths: a.appendOnlyPaths || [],
      frozen_fields: a.frozenFields || {},
      churn_ceiling: {
        max_files: Number.isFinite(a.churnMaxFiles) ? a.churnMaxFiles : 50,
        max_lines: Number.isFinite(a.churnMaxLines) ? a.churnMaxLines : 10000,
      },
      // LIVE, and normalised rather than echoed: this is the field
      // renderWorkflowTemplate() selects the generated workflow's merge
      // path from, so writing back an unrecognised value would leave a
      // file claiming a merge model the workflow beside it doesn't
      // implement. Anything unknown resolves to human-approval-required —
      // see adapter.mjs's normalizeApprovalClass() for why that direction.
      approval_class: normalizeApprovalClass(a.approvalClass),
    },
    roles: {
      agent_brief_path: a.agentBriefPath || '.claude/agents/improve.md',
      reviewer_brief_path: a.reviewerBriefPath || '.claude/agents/review.md',
      suggest: { max_output_tokens: Number.isFinite(a.suggestMaxTokens) ? a.suggestMaxTokens : 32000 },
      // `provider` is written only when someone named a lab explicitly. A
      // model id whose lab is obvious from its name resolves by pattern and
      // gains nothing from the extra line; one whose lab is NOT obvious —
      // the whole point of pinning a model released after this harness was
      // written — could not be used at all without it. See
      // llm-provider.mjs's pinModelProvider().
      implement: { model: a.implementModel || 'claude-opus-5', ...(a.implementProvider ? { provider: a.implementProvider } : {}) },
      review: { model: a.reviewModel || 'claude-opus-5', ...(a.reviewProvider ? { provider: a.reviewProvider } : {}) },
      // Unset on purpose when init left it blank: run-generation.mjs then
      // picks a model from a different family than the implementer at run
      // time (harness/lib/seats.mjs). Writing the implementer here instead
      // would silently re-create the shared-family judge the blank avoids.
      rank: { model: a.rankModel || null, ...(a.rankModel && a.rankProvider ? { provider: a.rankProvider } : {}) },
      refine: { max_attempts: Number.isFinite(a.maxAttempts) ? a.maxAttempts : 3 },
    },
    memory: {
      escalation_ledger: a.ledgerPath || 'docs/escalations/ledger.json',
      escalation_consensus: {
        models: Number.isFinite(a.consensusModels) ? a.consensusModels : 3,
        labs: Number.isFinite(a.consensusLabs) ? a.consensusLabs : 2,
        resurface_after: Number.isFinite(a.resurfaceAfter) ? a.resurfaceAfter : 5,
      },
      themes_review: {
        dir: a.themesDir || 'docs/themes',
        cadence_generations: Number.isFinite(a.themesCadence) ? a.themesCadence : 10,
      },
    },
    context: {
      generations_dir: a.generationsDir || 'docs/generations',
      runtime_evidence_dir: a.runtimeEvidenceDir || 'docs/runtime',
      strategy: a.contextStrategy || 'full-dump',
      test_files: a.testFiles || [],
      purposes: a.purposes || {},
      history_limit: Number.isFinite(a.historyLimit) ? a.historyLimit : 3,
      scope_required: Number.isFinite(a.scopeRequired) ? a.scopeRequired : 2,
      // LIVE, read at run time, normalised rather than echoed so a typo
      // never lands on "ambitious". See docs/Ambition-Control.md.
      ambition: normalizeAmbition(a.ambition),
    },
    deployment: {
      verify_strategy: a.deploymentStrategy || 'none',
      ci: { runner: a.runner || 'ubuntu-latest' },
    },
    // LIVE: run-generation.mjs reads it. A per-generation token cap, set by
    // default because an unattended loop's cost scales with other people's
    // release schedules — a busy month is N proposers, and nothing else in
    // the pipeline bounds it. 2,000,000 is a few times a typical generation
    // with three proposers; a project with a large source bundle raises it.
    budget: {
      max_generation_tokens: Number.isFinite(a.maxGenerationTokens) ? a.maxGenerationTokens : 2000000,
    },
    // RECORDED, and deliberately never read back — see the closing section
    // of harness/project-adapter.example.yml for the reasoning. Both of
    // these are baked into the generated workflow (the cron into
    // `on.schedule`, the commands into the two test steps), and a value
    // baked into a generated file should have exactly one source of truth
    // at run time: that file. They are written here anyway so the adapter
    // stays an honest record of what this project was scaffolded with,
    // rather than silently missing it.
    cadence: {
      trigger: 'model-release',
      schedule_cron: a.cadenceCron || '0 0 1 * *',
      // Whether that cron was actually rendered into the workflow, or left
      // commented out pending a rehearsal (console/DESIGN.md §Step 9). The
      // difference matters to anyone reading this file to find out why
      // nothing has run.
      scheduled: a.includeSchedule !== false,
    },
    // In a SHARED installation both lists are LIVE instead: the shared
    // workflow reads them once per run, from the default branch, before any
    // agent change (harness/lib/workflow-config.mjs), because it has no
    // generated steps of its own to bake them into.
    evaluation: {
      test_commands: a.testCommands || [],
      preflight_required: true,
      ...(a.setupCommands?.length ? { setup_commands: a.setupCommands } : {}),
    },
  };

  if (a.deploymentStrategy === 'url' && a.deploymentUrl) {
    adapter.deployment.production_url = a.deploymentUrl.productionUrl;
    adapter.deployment.watched_files = a.deploymentUrl.watchedFiles || [];
  }
  if (a.deploymentStrategy === 'registry' && a.deploymentRegistry) {
    const r = a.deploymentRegistry;
    adapter.deployment.registry = {
      ecosystem: r.ecosystem,
      ...(r.ecosystem === 'maven' ? { group_id: r.groupId, artifact_id: r.artifactId } : { package: r.package }),
      ...(r.versionFile ? { version_file: r.versionFile } : {}),
      ...(r.registryUrl ? { registry_url: r.registryUrl } : {}),
    };
  }
  if (a.deploymentStrategy === 'artifact' && a.deploymentArtifact) {
    const art = a.deploymentArtifact;
    adapter.deployment.artifact = {
      ...(art.buildCommand ? { build_command: art.buildCommand } : {}),
      ...(art.path ? { path: art.path } : {}),
      ...(art.smokeCommand ? { smoke_command: art.smokeCommand } : {}),
    };
  }

  if (a.notify) {
    adapter.notify = {
      channel: 'email',
      provider: a.notify.provider || 'sendgrid',
      recipient: a.notify.recipient,
      recipient_name: a.notify.recipientName || undefined,
      from: { email: a.notify.fromEmail, name: a.notify.fromName || undefined },
      digest_model: a.notify.digestModel || 'claude-opus-5',
      escalation_notice: a.notify.escalationNotice ?? true,
      calibration_examples: [],
    };
  }

  return adapter;
}

/**
 * The inverse of buildAdapterObject(): the answers object an existing
 * `project-adapter.yml` implies, so the generated workflow and install
 * README can be rendered FROM the adapter (`init --from-adapter`) instead of
 * from a fresh round of questions.
 *
 * Why it exists: the install README tells an owner to change
 * `constitution.approval_class` "and re-run init with --force" — which asked
 * every question again and overwrote the adapter they had just edited. The
 * adapter is the source of truth; this makes it one.
 *
 * Pure. Provider facts that need the registry come in as functions, so this
 * file stays free of it (the same reason init.mjs, not this file, resolves
 * roleProviders).
 *
 * @param {object} adapter  A parsed project-adapter.yml.
 * @param {object} deps
 * @param {(name: string) => string} deps.providerEnvKey    Lab name → its API-key variable.
 * @param {(model: string) => string|null} deps.modelProvider  Model id → lab name, or null if unknown.
 * @returns {object} answers, in the shape init.mjs builds
 */
export function answersFromAdapter(adapter, { providerEnvKey, modelProvider }) {
  const a = adapter ?? {};
  const project = a.project ?? {};
  const constitution = a.constitution ?? {};
  const roles = a.roles ?? {};
  const memory = a.memory ?? {};
  const consensus = memory.escalation_consensus ?? {};
  const context = a.context ?? {};
  const deployment = a.deployment ?? {};
  const num = (v) => (Number.isFinite(v) ? v : undefined);
  const lab = (name) => ({ name, envKey: providerEnvKey(name) });

  const roleModels = [roles.implement?.model, roles.review?.model, roles.rank?.model, ...(a.notify ? [a.notify.digest_model || 'claude-opus-5'] : [])];
  const roleProviders = [...new Set(roleModels.filter(Boolean).map((m) => modelProvider(m)).filter(Boolean))].map(lab);

  const answers = {
    harnessVersion: a.harness?.version,
    projectId: project.id,
    repository: project.repository,
    defaultBranch: project.default_branch || 'main',
    goalStatement: project.goal?.statement,
    goalHolds: project.goal?.holds,
    goalAwayFrom: project.goal?.away_from,
    providers: (a.providers?.watched ?? []).map(lab),
    roleProviders,
    snapshotPath: a.providers?.snapshot_path,
    maxFanout: num(a.providers?.max_fanout),
    allowedPaths: constitution.allowed_paths ?? [],
    createOnlyPaths: constitution.create_only_paths ?? [],
    frozenPaths: constitution.frozen_paths ?? [],
    appendOnlyPaths: constitution.append_only_paths ?? [],
    frozenFields: constitution.frozen_fields,
    churnMaxFiles: num(constitution.churn_ceiling?.max_files),
    churnMaxLines: num(constitution.churn_ceiling?.max_lines),
    approvalClass: constitution.approval_class,
    agentBriefPath: roles.agent_brief_path,
    reviewerBriefPath: roles.reviewer_brief_path,
    suggestMaxTokens: num(roles.suggest?.max_output_tokens),
    implementModel: roles.implement?.model,
    implementProvider: roles.implement?.provider ?? '',
    reviewModel: roles.review?.model,
    reviewProvider: roles.review?.provider ?? '',
    rankModel: roles.rank?.model ?? '',
    rankProvider: roles.rank?.provider ?? '',
    maxAttempts: num(roles.refine?.max_attempts),
    ledgerPath: memory.escalation_ledger,
    consensusModels: num(consensus.models),
    consensusLabs: num(consensus.labs),
    resurfaceAfter: num(consensus.resurface_after),
    themesDir: memory.themes_review?.dir,
    themesCadence: num(memory.themes_review?.cadence_generations),
    generationsDir: context.generations_dir,
    runtimeEvidenceDir: context.runtime_evidence_dir,
    contextStrategy: context.strategy,
    testFiles: context.test_files,
    purposes: context.purposes,
    historyLimit: num(context.history_limit),
    scopeRequired: num(context.scope_required),
    ambition: context.ambition,
    deploymentStrategy: deployment.verify_strategy || 'none',
    runner: deployment.ci?.runner,
    maxGenerationTokens: num(a.budget?.max_generation_tokens),
    cadenceCron: a.cadence?.schedule_cron,
    // Absent means the adapter predates the flag: keep the schedule, as
    // buildAdapterObject() would have written it.
    includeSchedule: a.cadence?.scheduled !== false,
    testCommands: a.evaluation?.test_commands ?? [],
    setupCommands: a.evaluation?.setup_commands ?? [],
  };
  if (a.harness?.shared) {
    const s = a.harness.shared;
    answers.sharedHarness = { repository: s.repository, ref: s.ref, ...(s.label ? { label: s.label } : {}) };
  }

  if (deployment.verify_strategy === 'url' && deployment.production_url) {
    answers.deploymentUrl = { productionUrl: deployment.production_url, watchedFiles: deployment.watched_files ?? [] };
  }
  if (deployment.verify_strategy === 'registry' && deployment.registry) {
    const r = deployment.registry;
    answers.deploymentRegistry = { ecosystem: r.ecosystem, package: r.package, groupId: r.group_id, artifactId: r.artifact_id, versionFile: r.version_file, registryUrl: r.registry_url };
  }
  if (deployment.verify_strategy === 'artifact' && deployment.artifact) {
    const art = deployment.artifact;
    answers.deploymentArtifact = { buildCommand: art.build_command, path: art.path, smokeCommand: art.smoke_command };
  }
  if (a.notify) {
    const n = a.notify;
    answers.notify = {
      provider: n.provider || 'sendgrid',
      envKey: `${String(n.provider || 'sendgrid').toUpperCase()}_API_KEY`,
      recipient: n.recipient,
      recipientName: n.recipient_name,
      fromEmail: n.from?.email,
      fromName: n.from?.name,
      digestModel: n.digest_model,
      escalationNotice: n.escalation_notice,
    };
  }
  return answers;
}

/**
 * Render a full `project-adapter.yml` file: a short header pointing back
 * at the fully-commented example this was generated from (every RESERVED
 * field and the reasoning behind each LIVE one lives there, not
 * re-explained here), followed by the real YAML.
 */
export function renderAdapterYaml(answers) {
  const header = [
    '# Generated by harness/cli/init.mjs — review before your first real run.',
    '# harness/project-adapter.example.yml has the full, commented schema this',
    '# was built from, including every RESERVED field init.mjs did not ask about.',
    '# examples/carrotgame/project-adapter.yml is a real, fully-populated instance',
    '# of the same schema if you want to see every field reasoned about at once.',
    '',
  ].join('\n');
  return header + dumpYaml(buildAdapterObject(answers), { lineWidth: -1 });
}

/**
 * The `on.schedule:` block, or a comment saying there deliberately isn't
 * one and how to add it.
 *
 * `console/DESIGN.md` §Step 9's two-phase onboarding turns a GitHub
 * constraint into the safety property: `workflow_dispatch` only works for a
 * workflow already on the default branch, so "open a PR, rehearse before
 * merging" is not something the platform permits. Shipping without a
 * `schedule:` block instead means merging switches nothing on — the
 * rehearsal is a button press, and the cron arrives afterward as its own
 * one-line change. Until then there is no cron in the repository to fire,
 * which makes "the schedule stays off until a rehearsal passes" a fact
 * about the file rather than a promise about the process.
 *
 * The `init` CLI defaults this ON, because someone running a CLI in their
 * own repo has already done the equivalent of merging; the console defaults
 * it off for its first pull request.
 */
function scheduleBlock(answers) {
  const cron = answers.cadenceCron || '0 0 1 * *';
  if (answers.includeSchedule === false) {
    return [
      "  # No `schedule:` block yet, on purpose — this workflow runs only when",
      '  # you ask it to, from the Actions tab. Rehearse it once by hand, read',
      '  # the run end to end, and only then add the cron below as its own',
      '  # small change:',
      '  #',
      '  # schedule:',
      `  #   - cron: '${cron}'`,
    ].join('\n');
  }
  return ['  schedule:', `    - cron: '${cron}'`].join('\n');
}

/**
 * The steps between "tests passed" and "report what happened" — the merge
 * model, rendered as YAML rather than branched at runtime.
 *
 * Exactly one of the two paths ends up in the generated file, so which
 * merge model a repository got is answerable by reading its workflow
 * instead of by cross-referencing an adapter field against harness code.
 * The steps the other path would have used simply don't exist, and the
 * gate-collecting step downstream already tolerates that: an `outcome`
 * expression for a step that isn't in the file resolves to the empty
 * string, which it skips.
 *
 * `human-approval-required` (the default) pushes, gates, opens the pull
 * request, and records its URL back into that generation's attempts.json
 * via harness/scripts/record-pull-request.mjs — the write
 * `writeAttemptRecord()` cannot do itself, because the PR doesn't have a
 * URL until after run-generation.mjs has exited (console/DESIGN.md §8.4).
 * It runs no deployment verification: nothing has been deployed yet, and
 * won't be until a person merges.
 *
 * `autonomous-merge` is the original path — promote.mjs merges and tags,
 * then verify-deployment.mjs checks what that shipped.
 */
function mergeSteps(answers, { shared = false } = {}) {
  const approvalClass = normalizeApprovalClass(answers.approvalClass);
  // The shared workflow renders both paths, each gated on the approval class
  // the run read from the project's adapter. Anything but autonomous-merge
  // takes the pull-request path, as normalizeApprovalClass() already made sure.
  const defaultBranch = shared ? '${{ env.DEFAULT_BRANCH }}' : answers.defaultBranch || 'main';
  const branchLabel = shared ? 'the default branch' : defaultBranch;
  const generationsDir = shared ? '${{ env.GENERATIONS_DIR }}' : answers.generationsDir || 'docs/generations';
  const harness = shared ? '"$HARNESS_DIR"' : 'harness';
  const onlyWhen = (merges) => (shared ? ` && env.APPROVAL_CLASS ${merges ? '==' : '!='} 'autonomous-merge'` : '');

  const merge = `- name: Merge and tag, if every gate passed
        id: promote
        if: steps.tests.outcome == 'success'${onlyWhen(true)}
        shell: bash
        continue-on-error: true
        env:
          GEN_NUMBER: \${{ steps.gen.outputs.number }}
          BASE_BRANCH: ${defaultBranch}
        run: node ${harness}/scripts/promote.mjs

      - name: Verify the deployment
        id: verify
        if: steps.promote.outcome == 'success'
        shell: bash
        continue-on-error: true
        run: node ${harness}/scripts/verify-deployment.mjs --evidence "$RUNNER_TEMP/deploy-evidence.json"`;

  // `gh` is pre-installed on GitHub-hosted runners and authenticates from
  // GH_TOKEN, which is why this path needs no third-party action and no
  // credential beyond the job's own token. The title and body are built
  // from env: values inside the script — SUMMARY is model-generated text
  // and must never reach a `run:` block through `${{ }}` interpolation.
  const pr = `- name: Open a pull request, if every gate passed
        id: pr
        if: steps.tests.outcome == 'success'${onlyWhen(false)}
        shell: bash
        continue-on-error: true
        env:
          GH_TOKEN: \${{ github.token }}
          BASE_BRANCH: ${defaultBranch}
          BRANCH: \${{ steps.gen.outputs.branch }}
          GEN_NUMBER: \${{ steps.gen.outputs.number }}
          SUMMARY: \${{ steps.improve.outputs.summary }}
          RUN_URL: \${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
          GENERATIONS_DIR: ${generationsDir}
        run: |
          body=$(printf '%s\\n' \\
            "Opened by the self-improvement loop. Every gate passed against this branch —" \\
            "preflight, the independent review, the guarded-path check, and this project's" \\
            "own tests. The merge is yours." \\
            "" \\
            "- Summary: $SUMMARY" \\
            "- Proposal: \\\`$GENERATIONS_DIR/gen-$GEN_NUMBER/proposal.md\\\`" \\
            "- Attempt record: \\\`$GENERATIONS_DIR/gen-$GEN_NUMBER/attempts.json\\\`" \\
            "- Workflow run: $RUN_URL")
          url=$(gh pr create \\
            --base "$BASE_BRANCH" \\
            --head "$BRANCH" \\
            --title "Generation $GEN_NUMBER: $SUMMARY" \\
            --body "$body" | tail -n 1)
          # gh exiting 0 is not the same as gh having printed a pull
          # request URL. A trailing warning line, or a version that prints
          # the URL somewhere other than last, leaves $url holding prose —
          # which then reaches attempts.json and the run history page as
          # this generation's "pull request". Tested: gh writing a warning
          # and exiting 0 set url="Warning: using default branch".
          # Refusing here makes it a failed gate with a reason in the log,
          # which the digest reports; writing it makes a broken link the
          # owner finds later. A FAILING gh needs no check of its own:
          # shell: bash runs with -eo pipefail, so the assignment already
          # dies and the step is already recorded as a failed gate.
          case "$url" in
            https://*) echo "url=$url" >> "$GITHUB_OUTPUT" ;;
            *) echo "gh pr create exited 0 but its last line was not a URL: $url" >&2; exit 1 ;;
          esac

      # The one field writeAttemptRecord() cannot fill in itself: the PR
      # has no URL until the step above returns one, by which point
      # run-generation.mjs has long exited. Its own step, not part of the
      # one above, so a failure to record is visibly a failure to record
      # rather than a pull request that looks like it was never opened.
      # Written into the working tree only: the persist step commits the
      # whole record to ${branchLabel}, URL included, after this.
      - name: Record the pull request URL in this generation's attempt record
        if: steps.pr.outputs.url
        shell: bash
        continue-on-error: true
        env:
          GEN_NUMBER: \${{ steps.gen.outputs.number }}
          PR_URL: \${{ steps.pr.outputs.url }}
          GENERATIONS_DIR: ${generationsDir}
        run: node ${harness}/scripts/record-pull-request.mjs "$GEN_NUMBER" "$PR_URL" --generations-dir "$GENERATIONS_DIR"`;

  if (shared) return `${pr}\n\n      ${merge}`;
  return approvalClass === 'autonomous-merge' ? merge : pr;
}

/**
 * Fill `harness/templates/workflow.yml.tmpl`'s `{{PLACEHOLDER}}` tokens
 * (plain `{{ }}`, never GitHub's own `${{ }}` expression syntax — the two
 * don't collide as substrings, so a literal `.replaceAll` per token is
 * enough; no template engine needed).
 */
function renderWorkflow(template, answers, shared) {
  // The union, not just the watched labs — see requiredProviders()'s own
  // doc for why a pinned reviewer on an unwatched lab used to fail at
  // runtime, after the suggest call had already been paid for.
  const providerEnvLines = indentBlock(
    requiredProviders(answers).map((p) => `${p.envKey}: \${{ secrets.${p.envKey} }}`).join('\n'),
    10
  );
  // The shared workflow runs the commands the config step saved from the
  // default branch; preflight installs the project's dependencies first.
  const projectCommands = (kind) => `node "$HARNESS_DIR"/scripts/run-project-commands.mjs ${kind}`;
  const testCommandLines = indentBlock(shared ? projectCommands('test') : (answers.testCommands || []).join('\n'), 10);
  const preflightCommandLines = shared
    ? indentBlock(`${projectCommands('setup')}\n${projectCommands('test')}`, 10)
    : testCommandLines;
  const harnessDir = shared ? '"$HARNESS_DIR"' : 'harness';
  const notifyGate = shared ? " && env.NOTIFY_CONFIGURED == 'true'" : '';
  // Everything the agent may change — edited in place or newly created. The
  // harness's own records are not in this list on purpose: they go to the
  // default branch via persist-records.mjs, on every outcome.
  const editablePathsGitAdd = shared ? '"${editable_paths[@]}"' : [...new Set([...(answers.allowedPaths || []), ...(answers.createOnlyPaths || [])])]
    .map(shellQuote).join(' ');

  // The template places {{NOTIFY_STEPS}} after a literal 6-space prefix on
  // its own line, so this block's FIRST line must have no leading spaces
  // (the template already supplies them) while every line after a '\n'
  // must carry its own real indentation — a plain template literal, not
  // indentBlock(), since the two step blocks' relative indentation needs
  // to be exact rather than uniformly shiftable.
  let notifySteps = '';
  if (answers.notify) {
    // The notify key, then every lab key: both notify scripts ask a model
    // (notify.digest_model) to write the email, and with no key for it every
    // digest silently fell back to the terse template.
    const notifyEnvLine = [
      `${answers.notify.envKey}: \${{ secrets.${answers.notify.envKey} }}`,
      ...requiredProviders(answers).map((p) => `          ${p.envKey}: \${{ secrets.${p.envKey} }}`),
    ].join('\n');
    // Deliberately NOT gated on a generation number existing. The cycles
    // with no generation are exactly the ones whose silence is hardest to
    // read: a crashed release check, a lab shipping something nothing could
    // reach, a preflight failure. send-digest.mjs picks the right message
    // from CHECK_RESULT / PREFLIGHT_RESULT / RELEASE_DETECTED when
    // GEN_NUMBER is absent. "It is visible as a red step in the Actions run"
    // is not a substitute — nobody is watching the Actions tab, which is
    // why the digest exists at all.
    notifySteps = `- name: Send the generation digest
        if: always()${notifyGate}
        shell: bash
        env:
          ${notifyEnvLine}
          GEN_NUMBER: \${{ steps.gen.outputs.number }}
          PAUSED: \${{ steps.pause.outputs.paused }}
          VALIDATE_RESULT: \${{ steps.validate.outcome }}
          CHECK_RESULT: \${{ steps.check.outcome }}
          PREFLIGHT_RESULT: \${{ steps.preflight.outcome }}
          RELEASE_DETECTED: \${{ steps.check.outputs.release-detected }}
          NO_GENERATION_DETAIL: \${{ steps.probe.outputs.dropped }}
          PINNED_BLOCKED: \${{ steps.probe.outputs.pinned-blocked }}
          LABS_WATCHED: ${shared ? '${{ env.PROVIDERS_CSV }}' : answers.providers.map((p) => p.name).join(',')}
          RUN_URL: \${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
          GATES: \${{ steps.gates.outputs.json }}
          MERGED: \${{ steps.gates.outputs.merged }}
          # The pull request this run opened, so the email that asks for a
          # decision can link to the thing being decided. Absent on the
          # autonomous-merge path — that step is not in the file — where the
          # expression resolves to '' and the digest says "merged" instead.
          PR_URL: \${{ steps.pr.outputs.url }}
          SUGGEST_MODEL: \${{ steps.probe.outputs.model }}
          SUGGEST_PROVIDER: \${{ steps.probe.outputs.provider }}
          IMPLEMENT_MODEL: \${{ steps.improve.outputs.implement-model }}
          SELF_IMPLEMENTED: \${{ steps.improve.outputs.self-implemented }}
          SUMMARY: \${{ steps.improve.outputs.summary }}
          BRIEF_FEEDBACK: \${{ steps.improve.outputs.brief-feedback }}
          ESC_OPENED: \${{ steps.improve.outputs.escalations-opened }}
          ESC_FLAGGED: \${{ steps.improve.outputs.escalations-flagged }}
          SPEND_TOKENS: \${{ steps.improve.outputs.spend-tokens }}
        run: node ${harnessDir}/scripts/send-digest.mjs

      - name: Send an escalation notice, if anything was flagged
        if: always()${notifyGate} && steps.improve.outputs.escalations-flagged != '0'
        shell: bash
        env:
          ${notifyEnvLine}
          GEN_NUMBER: \${{ steps.gen.outputs.number }}
          FLAGGED: \${{ steps.improve.outputs.escalations-flagged-json }}
        run: node ${harnessDir}/scripts/send-escalation-notice.mjs`;
  }

  // Replacement VALUES here contain literal `${{ ... }}` GitHub Actions
  // syntax — passing them as the string form of String.replace()'s second
  // argument would let `$`-prefixed sequences be read as replacement
  // patterns (`$&`, `$1`, ...). None of ours happen to collide today, but
  // a function replacer sidesteps that class of bug entirely rather than
  // relying on today's strings staying accident-free.
  const sub = (str, token, value) => str.replaceAll(token, () => value);

  // Only the pull-request path needs to create one, and a workflow should
  // not hold a permission its own steps never use.
  const permissionLines =
    !shared && normalizeApprovalClass(answers.approvalClass) === 'autonomous-merge'
      ? '  contents: write'
      : ['  contents: write', '  pull-requests: write'].join('\n');

  // LF only. A Windows checkout with core.autocrlf hands this a CRLF
  // template, and every block spliced in below is LF — the result was a
  // file with mixed line endings that a reader cannot see and a diff tool
  // reports as a rewrite of every line.
  let out = template.replace(/\r\n/g, '\n');
  // The structural blocks first: the harness setup step carries a token of
  // its own ({{JS_YAML_VERSION}}) for the substitutions below to fill.
  // A value the shared workflow's config step should have exported. Unset
  // means that step failed, and the command stops rather than guessing.
  const configured = (name) => `\${${name}:?the project configuration was not read}`;
  out = out.replace('{{TRIGGERS}}', () => (shared ? SHARED_TRIGGER : `${scheduleBlock(answers)}\n${DISPATCH_TRIGGER}`));
  out = out.replace('{{CONCURRENCY_BLOCK}}', () => (shared ? SHARED_CONCURRENCY : CONCURRENCY_BLOCK));
  // replaceAll, not replace: the check-keys job needs the same setup steps,
  // so this token appears twice in the template and filling only the first
  // left a literal {{HARNESS_SETUP_STEPS}} in the generated YAML.
  out = out.replaceAll('{{HARNESS_SETUP_STEPS}}', () => (shared ? SHARED_HARNESS_SETUP : COPIED_HARNESS_SETUP));
  // {{PROJECT_SETUP_STEPS}} — `evaluation.setup_commands`, for a COPIED
  // installation. A shared installation already runs them, per run, from the
  // project's adapter on the default branch (run-project-commands.mjs setup
  // inside its preflight), so it renders nothing here and keeps its single
  // source of truth. For a copied workflow this is the only step that
  // installs what the project's own test command needs, and its absence is
  // what WORKPLAN I10 was about: preflight exited 127 on a real install.
  //
  // Whole line removed when the list is empty, rather than left as an empty
  // step: a `run:` with no commands is a YAML error, and a project whose
  // suite needs no install should not carry a no-op step for ever.
  out = out.replace(
    /^\{\{PROJECT_SETUP_STEPS\}\}\n/m,
    () => (!shared && answers.setupCommands?.length
      ? [
          "      - name: Install the project's own dependencies",
          '        shell: bash',
          '        run: |',
          indentBlock(answers.setupCommands.join('\n'), 10),
          '',
        ].join('\n')
      : ''),
  );
  // The configuration step writes project-config.json only when it read the
  // adapter cleanly, so a project whose adapter could not be read stops at
  // this gate, and reaches the digest the same way, as one that is invalid.
  out = sub(out, '{{VALIDATE_RUN}}', shared
    ? 'test -s "$RUNNER_TEMP/project-config.json" && node "$HARNESS_DIR"/scripts/validate.mjs'
    : 'node harness/scripts/validate.mjs');
  out = sub(out, '{{HARNESS}}', harnessDir);
  out = sub(out, '{{INPUTS}}', shared ? 'inputs' : 'github.event.inputs');
  out = sub(out, '{{DEFAULT_BRANCH_LABEL}}', shared ? 'the default branch' : answers.defaultBranch || 'main');
  out = sub(out, '{{EDITABLE_PATHS_PREAMBLE}}', shared ? 'mapfile -t editable_paths < "$RUNNER_TEMP/editable-paths"\n          ' : '');
  out = sub(out, '{{PREFLIGHT_COMMAND_LINES}}', preflightCommandLines);
  out = sub(out, '{{NODE_VERSION}}', NODE_VERSION);
  out = sub(out, '{{PERMISSION_LINES}}', permissionLines);
  out = sub(out, '{{RUNNER}}', shared ? '${{ inputs.runner }}' : answers.runner || 'ubuntu-latest');
  out = sub(out, '{{PROVIDER_ENV_LINES}}', providerEnvLines);
  out = sub(out, '{{PROVIDERS_CSV}}', shared ? '"$PROVIDERS_CSV"' : answers.providers.map((p) => p.name).join(','));
  out = sub(out, '{{SNAPSHOT_PATH}}', shared ? `"${configured('SNAPSHOT_PATH')}"` : answers.snapshotPath || '.agent/model-snapshot.json');
  out = sub(out, '{{TEST_COMMAND_LINES}}', testCommandLines);
  out = sub(out, '{{EDITABLE_PATHS_GIT_ADD}}', editablePathsGitAdd);
  out = sub(out, '{{THEMES_CADENCE}}', shared
    ? 'N (memory.themes_review.cadence_generations)'
    : String(Number.isFinite(answers.themesCadence) ? answers.themesCadence : 10));
  out = sub(out, '{{JS_YAML_VERSION}}', JS_YAML_VERSION);
  out = sub(out, '{{GENERATIONS_DIR}}', shared ? `"${configured('GENERATIONS_DIR')}"` : shellQuote(answers.generationsDir || 'docs/generations'));
  out = sub(out, '{{DEFAULT_BRANCH}}', shared ? configured('DEFAULT_BRANCH') : answers.defaultBranch || 'main');
  // Same first-line-unindented convention as {{NOTIFY_STEPS}} below: the
  // template supplies the 6 spaces before the token, so this block's own
  // first line must not.
  out = out.replace('{{MERGE_STEPS}}', () => mergeSteps(answers, { shared }));
  // The check-keys job needs the notify key too, since a blank one is the
  // quietest failure this system has. Its own token rather than reusing
  // notifyEnvLine: that one also carries every lab key, which this job's
  // {{PROVIDER_ENV_LINES}} has already supplied.
  out = out.replace(
    /^[ ]*\{\{NOTIFY_ENV_LINE\}\}\n/m,
    () => (answers.notify ? `          ${answers.notify.envKey}: ${'$'}{{ secrets.${answers.notify.envKey} }}\n` : ''),
  );
  out = out.replace('{{NOTIFY_STEPS}}', () => notifySteps);
  return shared ? SHARED_HEADER + out : out;
}

/** A copied-in installation's `.github/workflows/self-improve.yml`, with every project value baked in. */
export function renderWorkflowTemplate(template, answers) {
  return renderWorkflow(template, answers, false);
}

/**
 * The shared workflow the harness's own repository serves at
 * SHARED_WORKFLOW_PATH, from the same template. Nothing project-specific is
 * baked in: it is read per run from the calling project's adapter by
 * harness/scripts/workflow-config.mjs. Every registered lab's key is wired,
 * because which labs a project watches is only known at run time; a secret
 * a project never set resolves to an empty string.
 *
 * @param {string} template
 * @param {{providers: Array<{name: string, envKey: string}>}} opts  Every registered lab.
 */
export function renderSharedWorkflow(template, { providers }) {
  return renderWorkflow(template, {
    providers,
    roleProviders: [],
    notify: { provider: 'sendgrid', envKey: 'SENDGRID_API_KEY' },
  }, true);
}

/**
 * A shared installation's `.github/workflows/self-improve.yml`: the schedule,
 * the Run workflow button and the concurrency group, calling the shared
 * workflow at one commit. Pinned by full SHA, never a tag or branch, for the
 * reason the generated workflow pins its actions by SHA: a ref that can be
 * moved would run whatever it was moved to, inside every gate, in every
 * project at once. `sharedHarness.label` (a release name, say) is only a
 * comment beside the SHA, so a reader can tell what they pinned.
 *
 * Both write permissions are granted whichever merge model the adapter
 * names: a called workflow may not hold more than its caller, and the
 * shared one serves both paths.
 *
 * @param {object} answers  init.mjs's answers, with `sharedHarness: {ref, repository?, label?}`.
 */
export function renderCallerWorkflow(answers) {
  const shared = answers.sharedHarness ?? {};
  if (!/^[0-9a-f]{40}$/.test(shared.ref || '')) {
    throw new Error('A shared installation pins the harness by its full 40-character commit SHA, not a branch, tag or short SHA.');
  }
  const repository = shared.repository || SHARED_HARNESS_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`"${repository}" is not an owner/repository name.`);
  }
  if (shared.label !== undefined && !/^[A-Za-z0-9._+-]{1,40}$/.test(shared.label)) {
    throw new Error('The version label must be a short name like v0.1.0.');
  }
  const runner = answers.runner || 'ubuntu-latest';
  if (!/^[A-Za-z0-9._-]+$/.test(runner)) throw new Error(`"${runner}" is not a runner name.`);

  return `# Calls the shared self-improvement workflow at one pinned harness commit,
# instead of carrying a copy of harness/ in this repository. Everything else
# the loop needs is read from project-adapter.yml at the start of each run.
#
# To upgrade, change the commit below (and the version beside it) to a newer
# harness release, and review the change like any other. See
# SELF-IMPROVE-README.md for what this installed.

name: Self-improvement loop

on:
${scheduleBlock(answers)}
${DISPATCH_TRIGGER}

permissions:
  contents: write
  pull-requests: write

${CONCURRENCY_BLOCK}

jobs:
  self-improve:
    uses: ${repository}/${SHARED_WORKFLOW_PATH}@${shared.ref}${shared.label ? ` # ${shared.label}` : ''}
    secrets: inherit
    with:
      scope: \${{ github.event.inputs.scope }}
      models: \${{ github.event.inputs.models }}
      check_keys: \${{ github.event.inputs.check_keys == 'true' }}${runner === 'ubuntu-latest' ? '' : `\n      runner: ${runner}`}
`;
}

/**
 * The short install README init.mjs writes into the target project —
 * "what did I just install, what secrets does it need, how do I rehearse
 * it once before turning the schedule on," per Portable-Harness-Design.md
 * §6's design for this file. Written for the person who ran the command,
 * not for someone reading harness source.
 */
export function renderReadme(answers) {
  const watched = new Set((answers.providers || []).map((p) => p.name));
  const providerLines = requiredProviders(answers)
    .map((p) => {
      const why = watched.has(p.name)
        ? 'watched for new releases'
        : 'needed by a pinned implement/review/rank model, even though it is not watched';
      return `- \`${p.envKey}\` — ${p.name} (${why})`;
    })
    .join('\n');
  const notifyLine = answers.notify ? `- \`${answers.notify.envKey}\` — sends the generation digest via ${answers.notify.provider}` : null;
  const secretLines = [providerLines, notifyLine].filter(Boolean).join('\n');

  const approvalClass = normalizeApprovalClass(answers.approvalClass);
  // A copied-in workflow has the merge model baked in, so a change to the
  // adapter needs the workflow regenerated; the shared one reads it per run.
  const shared = answers.sharedHarness;
  const regenerate = shared
    ? 'leave the workflow alone — the shared workflow reads the\nadapter at the start of every run, so the change takes effect on the next one.'
    : 'regenerate the workflow from it with\n`node harness/cli/init.mjs --from-adapter --force` — the merge model is baked\ninto the workflow file, not read from the adapter at run time.';
  const workflowBullet = shared
    ? `- \`.github/workflows/self-improve.yml\` — a short workflow that calls the shared
  self-improvement workflow at harness commit \`${shared.ref}\`${shared.label ? ` (${shared.label})` : ''}.
  No copy of \`harness/\` lives in this repository; upgrade by changing that
  commit. Runs on the schedule below, and on demand via the Actions tab's
  "Run workflow" button.`
    : `- \`.github/workflows/self-improve.yml\` — the generated workflow. Runs on the
  schedule below, and on demand via the Actions tab's "Run workflow" button.`;
  const revertCommand = shared
    ? 'node /path/to/self-optimisation/harness/scripts/revert-generation.mjs NNN --reason "why"'
    : 'node harness/scripts/revert-generation.mjs NNN --reason "why"';
  const approvalSection =
    approvalClass === 'autonomous-merge'
      ? `**\`autonomous-merge\`** — when every gate passes (preflight, the independent
review, the guarded-path check, your own tests), the workflow merges the agent
branch into \`${answers.defaultBranch || 'main'}\` itself and tags the generation
\`gen-NNN\`. Nobody is asked first. Every generation is a tag specifically so
this stays reversible: \`git revert gen-NNN\`, or bisect between two of them.

This is the advanced setting. If you did not mean to choose it, set
\`constitution.approval_class: human-approval-required\` in
\`project-adapter.yml\` and ${regenerate}`
      : `**\`human-approval-required\`** (the default) — when every gate passes
(preflight, the independent review, the guarded-path check, your own tests),
the workflow opens a **pull request** and stops. You merge it, or you don't.
Nothing reaches \`${answers.defaultBranch || 'main'}\` without you.

The pull request's URL is written back into that generation's
\`attempts.json\`, so the record of a run says where it ended up.

**One repository setting this needs, which GitHub turns off by default:**
Settings → Actions → General → Workflow permissions → tick **Allow GitHub
Actions to create and approve pull requests**. Without it every generation
passes its gates and then fails to open its pull request.

- **Where it is:** \`https://github.com/OWNER/REPO/settings/actions\`, or the
  repository's **Settings**, then **Actions** in the left sidebar, then
  **General**, then scroll to **Workflow permissions** at the bottom. The
  *Pull Requests* section of **Settings → General** (merge commits, squash,
  rebase) looks like the right place and is not.
- **Check it saved:** the tickbox has been seen not to stick without saying
  so. \`gh api repos/OWNER/REPO/actions/permissions/workflow\` should show
  \`"can_approve_pull_request_reviews":true\`. Or set it from the \`gh\` CLI:
  \`gh api -X PUT repos/OWNER/REPO/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true\`
  (read-only is fine as the default: the workflow asks for the write
  permissions it needs itself).
- **No personal access token is needed.** The workflow uses GitHub's
  built-in token. GitHub does not start your other workflows (your own CI)
  for a pull request that token opens, but the loop has already run your
  test commands by then.

To switch to autonomous merge later, set
\`constitution.approval_class: autonomous-merge\` in \`project-adapter.yml\`
and ${regenerate}`;

  const cadenceSection =
    answers.includeSchedule === false
      ? `**There is no schedule yet.** The workflow runs only when you ask it to,
from the Actions tab. That is deliberate: merging this in switches nothing on.
Once a rehearsal run has passed and its output makes sense to you, add the
cron as its own small change:

\`\`\`yaml
on:
  schedule:
    - cron: '${answers.cadenceCron || '0 0 1 * *'}'
\`\`\`

Model releases are the real trigger, not the calendar — a quiet period runs
the detector and does nothing else. See \`learning/01-principles.md\`
principle 1, in the harness repository.

To pause every run without uninstalling anything, set the repository
variable \`SELF_IMPROVE_PAUSED\` to \`true\` (**Settings → Secrets and
variables → Actions → Variables**). The workflow checks it first and stops
before spending anything. Set it back to \`false\`, or delete it, to resume.`
      : `Runs on \`${answers.cadenceCron || '0 0 1 * *'}\` (cron, UTC). Model releases are
the real trigger, not the calendar — a quiet period runs the detector and
does nothing else. See \`learning/01-principles.md\` principle 1, in the
harness repository.

To pause every run without uninstalling anything, set the repository
variable \`SELF_IMPROVE_PAUSED\` to \`true\` (**Settings → Secrets and
variables → Actions → Variables**). The workflow checks it first and stops
before spending anything. Set it back to \`false\`, or delete it, to resume.`;

  return `# Self-Improvement — what init just installed

Generated by \`harness/cli/init.mjs\` for **${answers.projectId}**. This is the
one-time summary; day-to-day, the workflow and \`project-adapter.yml\` speak
for themselves.

## What was written

- \`project-adapter.yml\` — this project's own configuration. Review it before
  your first real run; every field is documented in
  \`harness/project-adapter.example.yml\`.
${workflowBullet}
- \`${answers.agentBriefPath}\` / \`${answers.reviewerBriefPath}\` — the agent and
  reviewer briefs, copied from \`harness/templates/\`. **These still have
  [bracketed] placeholders you must fill in by hand** — what "better" means
  for this project is not something init can know. See the root README's
  "What only you can provide" table.

## Secrets this needs, in GitHub (Settings -> Secrets and variables -> Actions)

${secretLines || '(none — no providers or notifier were configured)'}

## What happens when a generation passes every gate

${approvalSection}

## Cadence

${cadenceSection}

## Tracking progress

Every run rebuilds two files from the records it leaves, and commits them to
\`${answers.defaultBranch || 'main'}\` with the record itself:

- \`${answers.generationsDir || 'docs/generations'}/index.html\` — **the run history.** One row per
  generation: which model suggested it, the change in plain words, what became
  of it (shipped, waiting for your review, or why it didn't ship, with each
  failed attempt and its reason) and what it cost in tokens. Pull requests
  waiting for you are listed at the top. It is a single file with no scripts or
  outside resources: download it, or open it from a local checkout, in any
  browser. GitHub shows HTML files as source, so to browse it on the web, serve
  that folder with GitHub Pages.
- \`${answers.generationsDir || 'docs/generations'}/REPORT.md\` — the same records as metrics (release
  yield, precision, tokens per kept change, results by lab). GitHub renders it.

Both are regenerated, never edited by hand. The next run replaces them.

## Undoing a generation

Every gate is a prediction; this is the correction. From a checkout with
push access to \`${answers.defaultBranch || 'main'}\`:

\`\`\`bash
${revertCommand}
\`\`\`

It reverts the merge that shipped generation NNN (the \`gen-NNN\` tag on the
autonomous path, the pull request's merge commit on the default path),
pushes, and records the revert in that generation's \`attempts.json\` so
the next run reads it as a failure rather than a success. It rewrites no
history. See \`docs/Ambition-Control.md\` in the harness repository for why
this exists beside the ambition setting (\`context.ambition\`, currently
\`${answers.ambition || 'earned'}\`).

## Rehearse before turning the schedule on

1. Fill in the two brief files above.
2. Push \`project-adapter.yml\`, the workflow, and the filled briefs.
3. Use "Run workflow" (workflow_dispatch) once, by hand, and read the run's
   log end to end — every step logs what it decided and why.
4. Only once that run's outcome makes sense to you, ${
    answers.includeSchedule === false
      ? 'add the `schedule:` block above'
      : 'let the schedule take over unattended'
  }.
`;
}

/**
 * `SELF-IMPROVE-CHECKLIST.md` — the installation checklist init.mjs writes
 * beside the install README, and the file an agent ticks off as it works.
 *
 * Every item here went wrong in a real installation at least once; the list
 * began as prose on the How-to-run page and is a file instead because prose
 * on a website cannot be ticked, cannot be reviewed in a pull request, and
 * cannot be handed to a coding agent as work to finish.
 *
 * Two things make it usable rather than decorative:
 *
 *   - Every item is tagged with WHO can settle it. `(agent)` items have a
 *     command whose output decides the tick, so an agent can finish them
 *     without guessing. `(you)` items are in a browser, a billing console or
 *     your own head — an agent must never tick one, and saying so in the
 *     file is what stops it.
 *   - It is rendered, not copied. The secrets list is the labs THIS
 *     installation actually calls, the branch is the real branch, the test
 *     command is the real one. A generic checklist gets skimmed; one that
 *     names your own repository gets read.
 *
 * Written once, then owned by the project — unlike the workflow, nothing
 * regenerates it, because a half-ticked checklist is a record of where you
 * got to.
 */
export function renderChecklist(answers) {
  const branch = answers.defaultBranch || 'main';
  const agentBrief = answers.agentBriefPath || '.claude/agents/improve.md';
  const reviewerBrief = answers.reviewerBriefPath || '.claude/agents/review.md';
  const secrets = [
    ...requiredProviders(answers).map((p) => p.envKey),
    ...(answers.notify ? [answers.notify.envKey] : []),
  ];
  const secretList = secrets.length
    ? secrets.map((k) => `\`${k}\``).join(', ')
    : '(none — no providers or notifier were configured)';
  const testCommand = (answers.testCommands || [])[0] || 'your test command';
  const shared = answers.sharedHarness;
  const approvalClass = normalizeApprovalClass(answers.approvalClass);

  // The permission split, printed as the config actually holds it. An owner
  // signing off "the agent may edit these" needs to read the real list, not a
  // description of one — this is the decision every other gate is downstream
  // of, and the one nobody can make for them.
  const pathList = (paths, empty) =>
    (paths || []).length ? paths.map((x) => `- \`${x}\``).join('\n') : `_${empty}_`;
  const allowed = pathList(answers.allowedPaths, 'nothing — the agent has nothing it may edit');
  const createOnly = pathList(answers.createOnlyPaths, 'nothing — the agent may not add files');
  const appendOnly = pathList(answers.appendOnlyPaths, 'nothing');
  const frozen = pathList(answers.frozenPaths, 'nothing — see the warning below');

  return `# Self-improvement install checklist — ${answers.projectId || 'this project'}

Every item below went wrong in a real installation at least once. Tick them
all before the scheduled run starts.

**Who ticks what.** \`(agent)\` items are settled by a command — run it, read
the output, tick only on the stated result. \`(you)\` items live in a browser,
a billing console, or your own judgement: **an agent must never tick one on
your behalf**, even if it looks obvious. Leave those unticked and say plainly
what is still outstanding.

Nothing regenerates this file. A half-ticked checklist is a record of where
you got to, so keep it in git and let it change in pull requests.

## 1. What the agent may touch

This is the foundational decision. Every other gate in this checklist is
downstream of it: the allowlist is applied before a single edit is written,
and the guard re-checks the same split in CI after the fact. Get this wrong
and the rest of the list is guarding the wrong thing.

Read the four lists below as they actually stand in \`project-adapter.yml\`.

**Editable** — \`constitution.allowed_paths\`. The agent may rewrite these
freely, and they are bundled into the prompt so it has read them first:

${allowed}

**Create-only** — \`constitution.create_only_paths\`. The agent may ADD a new
file matching these; it may never modify one that already exists, including
one it created on an earlier run:

${createOnly}

**Append-only** — \`constitution.append_only_paths\`. New files may be added;
existing ones may not be changed or deleted. This is normally where the test
suites live, because a model that can edit its own gate is not gated:

${appendOnly}

**Frozen** — \`constitution.frozen_paths\`. Never writable, by anything, ever:

${frozen}

- [ ] **(you)** **You have read those four lists and they are what you meant.**
      Not "they look reasonable" — you have checked that nothing you would mind
      losing is in the editable list, and that everything you would mind losing
      is in the frozen one. An agent can render this list; only you can say it
      is right, because only you know what this project cannot afford to break.
- [ ] **(you)** Anything with real-world consequence outside this repository is
      frozen: deployment config, infrastructure-as-code, CI definitions,
      secrets handling, billing, anything that sends email or messages, and
      anything that touches customer data. A change here is not undone by
      reverting the commit.
- [ ] **(you)** Your own safety net is frozen or append-only: the test suites,
      their fixtures and their helpers, the guard script, and the workflow. An
      agent that can weaken its own gate has no gate.
- [ ] **(agent)** \`.github/**\` is frozen — including the workflow that runs
      all this, which must not be able to rewrite its own schedule, its own
      permissions or its own gates.
- [ ] **(agent)** Both briefs describe the same split as \`project-adapter.yml\`.
      The adapter is what a script enforces; the briefs are what the model is
      told. When they disagree the model proposes work that the guard then
      rejects in CI, generation after generation, for a reason baked in at
      config time rather than found in the change.
- [ ] **(agent)** No path is in two lists at once — nothing editable is also
      frozen or append-only. \`node harness/scripts/validate.mjs\` reports this
      as an error; it must report none.
- [ ] **(agent)** Every editable path exists. A path the agent may edit but was
      never shown is a file it can be asked to write blind. \`validate.mjs\`
      checks this too; a directory that does not exist yet belongs in
      create-only, not editable.
- [ ] **(you)** You know how to widen this later, and that widening is the
      normal path: once a real file exists under a create-only glob, promoting
      that glob to \`allowed_paths\` lets later generations refine it. Start
      narrow. It is far easier to grant a path than to un-ship a change to one.

## 2. The installation is complete and on \`${branch}\`

- [ ] **(agent)** \`project-adapter.yml\`, \`.github/workflows/self-improve.yml\`,
      \`${agentBrief}\`, \`${reviewerBrief}\` and \`SELF-IMPROVE-README.md\` all exist.
- [ ] **(agent)** \`node harness/scripts/validate.mjs\` reports no errors. Each
      warning is read, and either fixed or a deliberate choice.
- [ ] **(agent)** No unfilled placeholder is left in either brief:
      \`grep -n "\\[.*\\]" ${agentBrief} ${reviewerBrief}\` prints nothing. A model
      reads an unfilled placeholder verbatim as part of its instructions.
- [ ] **(you)** The briefs say what is true of **this** codebase — the goal,
      the constraints, the hints — and name only paths and suites that really
      exist. This is the item an agent cannot do for you: it can fill the
      shape, it cannot know what "better" means here.
- [ ] **(agent)** Everything is merged into \`${branch}\`, and
      \`project.default_branch\` in \`project-adapter.yml\` names that same branch.

## 3. No key is anywhere git can see it

- [ ] **(agent)** \`git ls-files harness/.env.harness.local .env .env.harness.local\`
      prints **nothing**.
- [ ] **(agent)** \`git check-ignore -v harness/.env.harness.local\` prints a
      matching rule. If it prints nothing the file is not ignored — add
      \`.env.*\` (no leading slash, so it matches inside \`harness/\` too) plus
      \`!.env.harness.example\` to \`.gitignore\` before going any further.
- [ ] **(agent)** \`harness/.env.harness.example\` still holds placeholders only.
      Real keys belong in \`.env.harness.local\`; the \`.example\` file is tracked,
      and filling it in is the mistake the two names exist to prevent.
- [ ] **(you)** If a key was ever pasted into a tracked file, it is **rotated**,
      not merely deleted. Removing it from the working tree does not remove it
      from history, or from anywhere a push already reached.

## 4. GitHub has what the run needs

- [ ] **(you)** A repository secret for every lab this installation calls:
      ${secretList}.
      Settings → Secrets and variables → Actions. \`SELF-IMPROVE-README.md\`
      lists which, and why each is needed.
- [ ] **(you)** Workflow permissions saved: **Read and write**, with **Allow
      GitHub Actions to create and approve pull requests** ticked, at
      Settings → Actions → General. ${
        approvalClass === 'autonomous-merge'
          ? 'This install merges by itself; the write permission is what lets it.'
          : 'Without the second tick, every generation passes its gates and then fails to open its pull request.'
      }
      This is the single most-missed setting in an installation, and the
      tickbox has been seen not to save silently.
- [ ] **(agent)** ...and confirmed, rather than remembered:
      \`gh api repos/:owner/:repo/actions/permissions/workflow\` prints
      \`"default_workflow_permissions": "write"\` **and**
      \`"can_approve_pull_request_reviews": true\`. Both, not either. Reporting
      that the owner said they saved it is not this check.
- [ ] **(you)** Every lab has **credit**, not just a key. A valid key on an
      account with no payment method fails as \`402 billing_not_configured\`
      mid-run, and the run carries on without that lab. Set a monthly spending
      limit with each lab while you are there.
- [ ] **(agent)** ...and every configured key actually reaches its lab:
      \`node --env-file=harness/.env.harness.local harness/scripts/check-keys.mjs\`
      reports every lab working, and no lab reports a zero or missing balance.
      This is the earliest point a dead key or an unfunded account shows up —
      the alternative is finding out mid-generation, after the fan-out has been
      priced.

## 5. You know what a run will do to your project

- [ ] **(agent)** \`${testCommand}\` passes on \`${branch}\` right now. The harness
      judges a generation against this baseline; a suite that is already red
      makes every result unreadable.
- [ ] **(you)** You know what merging deploys. If your host deploys \`${branch}\`
      on every push (Railway, Vercel and Netlify usually do), merging a
      generation's pull request puts it live. Check whether your host waits for
      CI first — on Railway that is each service's **Wait for CI** setting.
- [ ] **(you)** The merge model is the one you meant: **${approvalClass}**.${
    approvalClass === 'autonomous-merge'
      ? ` Changes reach \`${branch}\` with nobody asked first. Every generation is tagged \`gen-NNN\`, so it stays revertible.`
      : ' Every change waits for you in a pull request.'
  }
- [ ] **(you)** Nothing in section 1's editable list can reach production by
      itself. If it can, that is a deliberate choice you are making, not an
      oversight.${
    shared
      ? ''
      : `
- [ ] **(agent)** The workflow's dependency install does not disturb this
      project's own. A copied install runs \`npm install\` at the repository root
      inside the Actions run; if this project depends on js-yaml 4 or earlier,
      or needs install scripts to have run, change that line to
      \`npm install --prefix harness --no-save --no-package-lock js-yaml@${JS_YAML_VERSION}\`.`
  }

## 6. The practice run, before anything is scheduled

- [ ] **(you)** You have agreed to spend real tokens on a rehearsal.
- [ ] **(agent)** \`node --env-file=harness/.env.harness.local harness/scripts/rehearse.mjs\`
      has been run once, by hand.
- [ ] **(you)** You have read what it proposed, what the reviewer said and what
      it cost — and the outcome makes sense to you. This is the last point at
      which stopping is free.
- [ ] **(you)** Only now, let the schedule run unattended.

## 7. You know where to look afterwards

- [ ] **(you)** \`${answers.generationsDir || 'docs/generations'}/index.html\` — the run
      history, rebuilt and committed after every run, with pull requests waiting
      for you at the top. Open it from a checkout; GitHub shows HTML as source.
- [ ] **(you)** You know how to undo one: \`${
    shared
      ? 'node /path/to/self-optimisation/harness/scripts/revert-generation.mjs NNN --reason "why"'
      : 'node harness/scripts/revert-generation.mjs NNN --reason "why"'
  }\`.
- [ ] **(you)** You know how to stop it: set the repository **variable**
      \`SELF_IMPROVE_PAUSED\` to \`true\`.
`;
}
