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
import { normalizeApprovalClass } from './adapter.mjs';

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
      implement: { model: a.implementModel || 'claude-opus-5' },
      review: { model: a.reviewModel || 'claude-opus-5' },
      rank: { model: a.rankModel || 'claude-opus-5' },
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
    },
    deployment: {
      verify_strategy: a.deploymentStrategy || 'none',
      ci: { runner: a.runner || 'ubuntu-latest' },
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
    evaluation: {
      test_commands: a.testCommands || [],
      preflight_required: true,
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
function mergeSteps(answers) {
  const approvalClass = normalizeApprovalClass(answers.approvalClass);
  const defaultBranch = answers.defaultBranch || 'main';
  const generationsDir = answers.generationsDir || 'docs/generations';

  if (approvalClass === 'autonomous-merge') {
    return `- name: Merge and tag, if every gate passed
        id: promote
        if: steps.tests.outcome == 'success'
        shell: bash
        continue-on-error: true
        env:
          GEN_NUMBER: \${{ steps.gen.outputs.number }}
          BASE_BRANCH: ${defaultBranch}
        run: node harness/scripts/promote.mjs

      - name: Verify the deployment
        id: verify
        if: steps.promote.outcome == 'success'
        shell: bash
        continue-on-error: true
        run: node harness/scripts/verify-deployment.mjs --evidence "$RUNNER_TEMP/deploy-evidence.json"`;
  }

  // `gh` is pre-installed on GitHub-hosted runners and authenticates from
  // GH_TOKEN, which is why this path needs no third-party action and no
  // credential beyond the job's own token. The title and body are built
  // from env: values inside the script — SUMMARY is model-generated text
  // and must never reach a `run:` block through `${{ }}` interpolation.
  return `- name: Open a pull request, if every gate passed
        id: pr
        if: steps.tests.outcome == 'success'
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
          echo "url=$url" >> "$GITHUB_OUTPUT"

      # The one field writeAttemptRecord() cannot fill in itself: the PR
      # has no URL until the step above returns one, by which point
      # run-generation.mjs has long exited. Its own step, not part of the
      # one above, so a failure to record is visibly a failure to record
      # rather than a pull request that looks like it was never opened.
      - name: Record the pull request URL in this generation's attempt record
        if: steps.pr.outputs.url
        shell: bash
        continue-on-error: true
        env:
          BRANCH: \${{ steps.gen.outputs.branch }}
          GEN_NUMBER: \${{ steps.gen.outputs.number }}
          PR_URL: \${{ steps.pr.outputs.url }}
          GENERATIONS_DIR: ${generationsDir}
        run: |
          node harness/scripts/record-pull-request.mjs "$GEN_NUMBER" "$PR_URL" --generations-dir "$GENERATIONS_DIR"
          git add -A -- "$GENERATIONS_DIR"
          git commit -m "Generation $GEN_NUMBER: record pull request URL" || echo "Nothing to record"
          git push origin "$BRANCH"`;
}

/**
 * Fill `harness/templates/workflow.yml.tmpl`'s `{{PLACEHOLDER}}` tokens
 * (plain `{{ }}`, never GitHub's own `${{ }}` expression syntax — the two
 * don't collide as substrings, so a literal `.replaceAll` per token is
 * enough; no template engine needed).
 */
export function renderWorkflowTemplate(template, answers) {
  // The union, not just the watched labs — see requiredProviders()'s own
  // doc for why a pinned reviewer on an unwatched lab used to fail at
  // runtime, after the suggest call had already been paid for.
  const providerEnvLines = indentBlock(
    requiredProviders(answers).map((p) => `${p.envKey}: \${{ secrets.${p.envKey} }}`).join('\n'),
    10
  );
  const testCommandLines = indentBlock((answers.testCommands || []).join('\n'), 10);
  const allowedPathsGitAdd = (answers.allowedPaths || []).map(shellQuote).join(' ');
  // The harness's own records, committed alongside whatever the agent
  // changed. Deduped because a project is free to point both at the same
  // place, and `git add` twice over one directory is harmless but reads
  // like a mistake.
  const recordDirsGitAdd = [...new Set([
    answers.generationsDir || 'docs/generations',
    answers.themesDir || 'docs/themes',
  ])].map(shellQuote).join(' ');

  // The template places {{NOTIFY_STEPS}} after a literal 6-space prefix on
  // its own line, so this block's FIRST line must have no leading spaces
  // (the template already supplies them) while every line after a '\n'
  // must carry its own real indentation — a plain template literal, not
  // indentBlock(), since the two step blocks' relative indentation needs
  // to be exact rather than uniformly shiftable.
  let notifySteps = '';
  if (answers.notify) {
    const notifyEnvLine = `${answers.notify.envKey}: \${{ secrets.${answers.notify.envKey} }}`;
    // Deliberately NOT gated on a generation number existing. The cycles
    // with no generation are exactly the ones whose silence is hardest to
    // read: a crashed release check, a lab shipping something nothing could
    // reach, a preflight failure. send-digest.mjs picks the right message
    // from CHECK_RESULT / PREFLIGHT_RESULT / RELEASE_DETECTED when
    // GEN_NUMBER is absent. "It is visible as a red step in the Actions run"
    // is not a substitute — nobody is watching the Actions tab, which is
    // why the digest exists at all.
    notifySteps = `- name: Send the generation digest
        if: always()
        shell: bash
        env:
          ${notifyEnvLine}
          GEN_NUMBER: \${{ steps.gen.outputs.number }}
          CHECK_RESULT: \${{ steps.check.outcome }}
          PREFLIGHT_RESULT: \${{ steps.preflight.outcome }}
          RELEASE_DETECTED: \${{ steps.check.outputs.release-detected }}
          NO_GENERATION_DETAIL: \${{ steps.probe.outputs.dropped }}
          LABS_WATCHED: ${answers.providers.map((p) => p.name).join(',')}
          RUN_URL: \${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
          GATES: \${{ steps.gates.outputs.json }}
          MERGED: \${{ steps.gates.outputs.merged }}
          SUGGEST_MODEL: \${{ steps.probe.outputs.model }}
          SUGGEST_PROVIDER: \${{ steps.probe.outputs.provider }}
          IMPLEMENT_MODEL: \${{ steps.improve.outputs.implement-model }}
          SELF_IMPLEMENTED: \${{ steps.improve.outputs.self-implemented }}
          SUMMARY: \${{ steps.improve.outputs.summary }}
          BRIEF_FEEDBACK: \${{ steps.improve.outputs.brief-feedback }}
          ESC_OPENED: \${{ steps.improve.outputs.escalations-opened }}
          ESC_FLAGGED: \${{ steps.improve.outputs.escalations-flagged }}
        run: node harness/scripts/send-digest.mjs

      - name: Send an escalation notice, if anything was flagged
        if: always() && steps.improve.outputs.escalations-flagged != '0'
        shell: bash
        env:
          ${notifyEnvLine}
          GEN_NUMBER: \${{ steps.gen.outputs.number }}
          FLAGGED: \${{ steps.improve.outputs.escalations-flagged-json }}
        run: node harness/scripts/send-escalation-notice.mjs`;
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
    normalizeApprovalClass(answers.approvalClass) === 'autonomous-merge'
      ? '  contents: write'
      : ['  contents: write', '  pull-requests: write'].join('\n');

  let out = template;
  out = sub(out, '{{SCHEDULE_BLOCK}}', scheduleBlock(answers));
  out = sub(out, '{{PERMISSION_LINES}}', permissionLines);
  out = sub(out, '{{RUNNER}}', answers.runner || 'ubuntu-latest');
  out = sub(out, '{{PROVIDER_ENV_LINES}}', providerEnvLines);
  out = sub(out, '{{PROVIDERS_CSV}}', answers.providers.map((p) => p.name).join(','));
  out = sub(out, '{{SNAPSHOT_PATH}}', answers.snapshotPath || '.agent/model-snapshot.json');
  out = sub(out, '{{TEST_COMMAND_LINES}}', testCommandLines);
  out = sub(out, '{{ALLOWED_PATHS_GIT_ADD}}', allowedPathsGitAdd);
  out = sub(out, '{{RECORD_DIRS_GIT_ADD}}', recordDirsGitAdd);
  out = sub(out, '{{THEMES_CADENCE}}', String(Number.isFinite(answers.themesCadence) ? answers.themesCadence : 10));
  out = sub(out, '{{DEFAULT_BRANCH}}', answers.defaultBranch || 'main');
  // Same first-line-unindented convention as {{NOTIFY_STEPS}} below: the
  // template supplies the 6 spaces before the token, so this block's own
  // first line must not.
  out = out.replace('{{MERGE_STEPS}}', () => mergeSteps(answers));
  out = out.replace('{{NOTIFY_STEPS}}', () => notifySteps);
  return out;
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
  const approvalSection =
    approvalClass === 'autonomous-merge'
      ? `**\`autonomous-merge\`** — when every gate passes (preflight, the independent
review, the guarded-path check, your own tests), the workflow merges the agent
branch into \`${answers.defaultBranch || 'main'}\` itself and tags the generation
\`gen-NNN\`. Nobody is asked first. Every generation is a tag specifically so
this stays reversible: \`git revert gen-NNN\`, or bisect between two of them.

This is the advanced setting. If you did not mean to choose it, set
\`constitution.approval_class: human-approval-required\` in
\`project-adapter.yml\` and re-run init with \`--force\` to regenerate the
workflow — the merge model is baked into the workflow file, not read from the
adapter at run time.`
      : `**\`human-approval-required\`** (the default) — when every gate passes
(preflight, the independent review, the guarded-path check, your own tests),
the workflow opens a **pull request** and stops. You merge it, or you don't.
Nothing reaches \`${answers.defaultBranch || 'main'}\` without you.

The pull request's URL is written back into that generation's
\`attempts.json\`, so the record of a run says where it ended up.

To switch to autonomous merge later, set
\`constitution.approval_class: autonomous-merge\` in \`project-adapter.yml\`
and re-run init with \`--force\` — the merge model is baked into the workflow
file, not read from the adapter at run time.`;

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
principle 1.`
      : `Runs on \`${answers.cadenceCron || '0 0 1 * *'}\` (cron, UTC). Model releases are
the real trigger, not the calendar — a quiet period runs the detector and
does nothing else. See \`learning/01-principles.md\` principle 1.`;

  return `# Self-Improvement — what init just installed

Generated by \`harness/cli/init.mjs\` for **${answers.projectId}**. This is the
one-time summary; day-to-day, the workflow and \`project-adapter.yml\` speak
for themselves.

## What was written

- \`project-adapter.yml\` — this project's own configuration. Review it before
  your first real run; every field is documented in
  \`harness/project-adapter.example.yml\`.
- \`.github/workflows/self-improve.yml\` — the generated workflow. Runs on the
  schedule below, and on demand via the Actions tab's "Run workflow" button.
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
