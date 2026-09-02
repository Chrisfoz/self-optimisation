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
      },
      themes_review: {
        dir: a.themesDir || 'docs/themes',
        cadence_generations: Number.isFinite(a.themesCadence) ? a.themesCadence : 10,
      },
    },
    context: {
      generations_dir: a.generationsDir || 'docs/generations',
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
    // RESERVED — no test-command runner reads this back out of the adapter
    // yet (see ARCHITECTURE.md); recorded here anyway so the file stays an
    // honest record of what init.mjs actually baked into the generated
    // workflow's test steps, not silently missing from it.
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

  let out = template;
  out = sub(out, '{{CRON}}', answers.cadenceCron || '0 0 1 * *');
  out = sub(out, '{{RUNNER}}', answers.runner || 'ubuntu-latest');
  out = sub(out, '{{PROVIDER_ENV_LINES}}', providerEnvLines);
  out = sub(out, '{{PROVIDERS_CSV}}', answers.providers.map((p) => p.name).join(','));
  out = sub(out, '{{SNAPSHOT_PATH}}', answers.snapshotPath || '.agent/model-snapshot.json');
  out = sub(out, '{{TEST_COMMAND_LINES}}', testCommandLines);
  out = sub(out, '{{ALLOWED_PATHS_GIT_ADD}}', allowedPathsGitAdd);
  out = sub(out, '{{DEFAULT_BRANCH}}', answers.defaultBranch || 'main');
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

## Cadence

Runs on \`${answers.cadenceCron || '0 0 1 * *'}\` (cron, UTC). Model releases are
the real trigger, not the calendar — a quiet period runs the detector and
does nothing else. See \`learning/01-principles.md\` principle 1.

## Rehearse before turning the schedule on

1. Fill in the two brief files above.
2. Push \`project-adapter.yml\`, the workflow, and the filled briefs.
3. Use "Run workflow" (workflow_dispatch) once, by hand, and read the run's
   log end to end — every step logs what it decided and why.
4. Only once that run's outcome makes sense to you, let the schedule take
   over unattended.
`;
}
