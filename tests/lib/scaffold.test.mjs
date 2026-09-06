import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { buildAdapterObject, renderAdapterYaml, renderWorkflowTemplate, renderReadme, requiredProviders, JS_YAML_VERSION } from '../../harness/lib/scaffold.mjs';

const TEMPLATE_PATH = path.join(import.meta.dirname, '../../harness/templates/workflow.yml.tmpl');
const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

function baseAnswers(overrides = {}) {
  return {
    projectId: 'my-project',
    repository: 'https://github.com/you/my-project',
    defaultBranch: 'main',
    allowedPaths: ['index.html', 'styles.css'],
    createOnlyPaths: [],
    frozenPaths: ['.github/**'],
    appendOnlyPaths: ['tests/**'],
    testCommands: ['npm test'],
    providers: [
      { name: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
      { name: 'openai', envKey: 'OPENAI_API_KEY' },
    ],
    snapshotPath: '.agent/model-snapshot.json',
    maxFanout: 8,
    cadenceCron: '0 0 1 * *',
    runner: 'ubuntu-latest',
    contextStrategy: 'full-dump',
    agentBriefPath: '.claude/agents/improve.md',
    reviewerBriefPath: '.claude/agents/review.md',
    deploymentStrategy: 'none',
    notify: null,
    ...overrides,
  };
}

// --- buildAdapterObject / renderAdapterYaml ----------------------------------

test('buildAdapterObject: builds a minimal, schema-shaped object from required answers', () => {
  const adapter = buildAdapterObject(baseAnswers());
  assert.equal(adapter.project.id, 'my-project');
  assert.deepEqual(adapter.providers.watched, ['anthropic', 'openai']);
  assert.deepEqual(adapter.constitution.allowed_paths, ['index.html', 'styles.css']);
  assert.equal(adapter.roles.implement.model, 'claude-opus-5');
  assert.equal(adapter.deployment.verify_strategy, 'none');
  assert.equal(adapter.notify, undefined);
});

test('buildAdapterObject: echoes the answered test commands into evaluation.test_commands', () => {
  const adapter = buildAdapterObject(baseAnswers({ testCommands: ['npm test', 'npm run lint'] }));
  assert.deepEqual(adapter.evaluation.test_commands, ['npm test', 'npm run lint']);
  assert.equal(adapter.evaluation.preflight_required, true);
});

test('buildAdapterObject: records the cadence that was baked into the workflow, and whether it was switched on', () => {
  const on = buildAdapterObject(baseAnswers({ cadenceCron: '0 3 * * 1' }));
  assert.equal(on.cadence.schedule_cron, '0 3 * * 1');
  assert.equal(on.cadence.scheduled, true);
  assert.equal(on.cadence.trigger, 'model-release');

  const off = buildAdapterObject(baseAnswers({ cadenceCron: '0 3 * * 1', includeSchedule: false }));
  assert.equal(off.cadence.schedule_cron, '0 3 * * 1');
  assert.equal(off.cadence.scheduled, false, 'the cron is recorded, but is not in the workflow yet');
});

test('buildAdapterObject: fills unset numeric fields with the documented defaults', () => {
  const adapter = buildAdapterObject(baseAnswers());
  assert.equal(adapter.constitution.churn_ceiling.max_files, 50);
  assert.equal(adapter.constitution.churn_ceiling.max_lines, 10000);
  assert.equal(adapter.memory.escalation_consensus.models, 3);
  assert.equal(adapter.memory.escalation_consensus.labs, 2);
  assert.equal(adapter.context.history_limit, 3);
  assert.equal(adapter.context.scope_required, 2);
});

test('buildAdapterObject: url deployment strategy carries production_url and watched_files', () => {
  const adapter = buildAdapterObject(baseAnswers({
    deploymentStrategy: 'url',
    deploymentUrl: { productionUrl: 'https://example.com', watchedFiles: ['index.html'] },
  }));
  assert.equal(adapter.deployment.production_url, 'https://example.com');
  assert.deepEqual(adapter.deployment.watched_files, ['index.html']);
});

test('buildAdapterObject: registry deployment strategy for npm uses "package"', () => {
  const adapter = buildAdapterObject(baseAnswers({
    deploymentStrategy: 'registry',
    deploymentRegistry: { ecosystem: 'npm', package: 'my-cli' },
  }));
  assert.equal(adapter.deployment.registry.ecosystem, 'npm');
  assert.equal(adapter.deployment.registry.package, 'my-cli');
  assert.equal(adapter.deployment.registry.group_id, undefined);
});

test('buildAdapterObject: registry deployment strategy for maven uses group_id/artifact_id', () => {
  const adapter = buildAdapterObject(baseAnswers({
    deploymentStrategy: 'registry',
    deploymentRegistry: { ecosystem: 'maven', groupId: 'com.example', artifactId: 'lib' },
  }));
  assert.equal(adapter.deployment.registry.group_id, 'com.example');
  assert.equal(adapter.deployment.registry.artifact_id, 'lib');
  assert.equal(adapter.deployment.registry.package, undefined);
});

test('buildAdapterObject: artifact deployment strategy carries build/path/smoke', () => {
  const adapter = buildAdapterObject(baseAnswers({
    deploymentStrategy: 'artifact',
    deploymentArtifact: { buildCommand: 'npm run build', path: 'dist/cli.js', smokeCommand: 'node dist/cli.js --version' },
  }));
  assert.equal(adapter.deployment.artifact.build_command, 'npm run build');
  assert.equal(adapter.deployment.artifact.path, 'dist/cli.js');
  assert.equal(adapter.deployment.artifact.smoke_command, 'node dist/cli.js --version');
});

test('buildAdapterObject: notify config is included only when answers.notify is set', () => {
  const adapter = buildAdapterObject(baseAnswers({
    notify: { provider: 'sendgrid', envKey: 'SENDGRID_API_KEY', recipient: 'you@example.com', fromEmail: 'bot@example.com' },
  }));
  assert.equal(adapter.notify.recipient, 'you@example.com');
  assert.equal(adapter.notify.provider, 'sendgrid');
  assert.equal(adapter.notify.escalation_notice, true);
});

test('renderAdapterYaml: produces a header plus real, parseable YAML matching buildAdapterObject', () => {
  const answers = baseAnswers();
  const text = renderAdapterYaml(answers);
  assert.match(text, /^# Generated by harness\/cli\/init\.mjs/);
  const parsed = loadYaml(text);
  assert.deepEqual(parsed, buildAdapterObject(answers));
});

// --- renderWorkflowTemplate ---------------------------------------------------

test('renderWorkflowTemplate: leaves no {{PLACEHOLDER}} tokens unfilled', () => {
  const out = renderWorkflowTemplate(template, baseAnswers());
  assert.doesNotMatch(out, /\{\{[A-Z_]+\}\}/);
});

test('renderWorkflowTemplate: produces valid, parseable YAML', () => {
  const out = renderWorkflowTemplate(template, baseAnswers());
  const parsed = loadYaml(out);
  assert.equal(parsed.name, 'Self-improvement loop');
  assert.ok(parsed.jobs['self-improve']);
});

test('renderWorkflowTemplate: without notify, no digest/escalation steps are emitted', () => {
  const out = renderWorkflowTemplate(template, baseAnswers({ notify: null }));
  assert.doesNotMatch(out, /send-digest\.mjs/);
  assert.doesNotMatch(out, /send-escalation-notice\.mjs/);
  // still valid YAML even with the placeholder line reduced to whitespace
  assert.doesNotThrow(() => loadYaml(out));
});

test('renderWorkflowTemplate: with notify, both steps appear with the right secret name, and still parses', () => {
  const out = renderWorkflowTemplate(template, baseAnswers({
    notify: { provider: 'sendgrid', envKey: 'SENDGRID_API_KEY' },
  }));
  assert.match(out, /send-digest\.mjs/);
  assert.match(out, /send-escalation-notice\.mjs/);
  assert.match(out, /SENDGRID_API_KEY: \$\{\{ secrets\.SENDGRID_API_KEY \}\}/);
  const parsed = loadYaml(out);
  const steps = parsed.jobs['self-improve'].steps;
  assert.ok(steps.some((s) => s.name === 'Send the generation digest'));
  assert.ok(steps.some((s) => s.name === 'Send an escalation notice, if anything was flagged'));
});

test('renderWorkflowTemplate: embeds every configured provider secret and the CSV list', () => {
  const out = renderWorkflowTemplate(template, baseAnswers());
  assert.match(out, /ANTHROPIC_API_KEY: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/);
  assert.match(out, /OPENAI_API_KEY: \$\{\{ secrets\.OPENAI_API_KEY \}\}/);
  assert.match(out, /--providers anthropic,openai/);
});

// --- pinned-seat providers vs. watched providers ----------------------------
// The bug these lock down: `providers.watched` is the DETECTOR's scope, but
// the implement/review/rank seats are pinned to a model that may belong to a
// lab nobody watches. Injecting only the watched labs' secrets meant that
// configuration failed at runtime, mid-run, after the suggest call had
// already been paid for.

test('requiredProviders: watched only, when no pinned model needs anything else', () => {
  const out = requiredProviders({
    providers: [{ name: 'anthropic', envKey: 'ANTHROPIC_API_KEY' }],
    roleProviders: [{ name: 'anthropic', envKey: 'ANTHROPIC_API_KEY' }],
  });
  assert.deepEqual(out, [{ name: 'anthropic', envKey: 'ANTHROPIC_API_KEY' }]);
});

test('requiredProviders: a pinned model on an unwatched lab is added, watched labs first', () => {
  const out = requiredProviders({
    providers: [{ name: 'openai', envKey: 'OPENAI_API_KEY' }],
    roleProviders: [{ name: 'anthropic', envKey: 'ANTHROPIC_API_KEY' }],
  });
  assert.deepEqual(out, [
    { name: 'openai', envKey: 'OPENAI_API_KEY' },
    { name: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
  ]);
});

test('requiredProviders: tolerates a missing roleProviders entirely (nothing resolved, or an older answers object)', () => {
  const out = requiredProviders({ providers: [{ name: 'openai', envKey: 'OPENAI_API_KEY' }] });
  assert.deepEqual(out, [{ name: 'openai', envKey: 'OPENAI_API_KEY' }]);
});

test('renderWorkflowTemplate: a reviewer pinned to an unwatched lab still gets its API key wired', () => {
  // Watching only OpenAI, but reviewing with claude-opus-5 — the default
  // pinned model, and therefore the single most likely way to hit this.
  const out = renderWorkflowTemplate(template, baseAnswers({
    providers: [{ name: 'openai', envKey: 'OPENAI_API_KEY' }],
    roleProviders: [{ name: 'anthropic', envKey: 'ANTHROPIC_API_KEY' }],
  }));
  assert.match(out, /ANTHROPIC_API_KEY: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/);
  // ...while the detector's own scope stays the watched list alone — the
  // line is `--providers openai \` (a bash continuation), so match the
  // argument itself rather than an end-of-line anchor.
  assert.match(out, /--providers openai\s*\\/);
  assert.doesNotMatch(out, /--providers [\w,]*anthropic/);
  assert.doesNotThrow(() => loadYaml(out));
});

test('renderReadme: says which secrets are needed because of a pinned model rather than listing them unexplained', () => {
  const out = renderReadme(baseAnswers({
    providers: [{ name: 'openai', envKey: 'OPENAI_API_KEY' }],
    roleProviders: [{ name: 'anthropic', envKey: 'ANTHROPIC_API_KEY' }],
  }));
  assert.match(out, /OPENAI_API_KEY`? — openai \(watched for new releases\)/);
  assert.match(out, /ANTHROPIC_API_KEY`? — anthropic \(needed by a pinned/);
});

test('renderWorkflowTemplate: quotes allowed_paths for the git add step', () => {
  const out = renderWorkflowTemplate(template, baseAnswers({ allowedPaths: ["it's-a-file.html", 'styles.css'] }));
  assert.match(out, /git add -A -- 'it'\\''s-a-file\.html' 'styles\.css'/);
});

test('renderWorkflowTemplate: uses the configured default branch for guard and promote', () => {
  const out = renderWorkflowTemplate(template, baseAnswers({ defaultBranch: 'trunk' }));
  assert.match(out, /origin\/trunk/);
  assert.match(out, /BASE_BRANCH: trunk/);
});

test('renderWorkflowTemplate: a summary/feedback value containing "$" or quotes cannot break the script (env:-only interpolation)', () => {
  // Nothing in the template embeds ${{ steps.improve.outputs.summary }} (or
  // any other model-controlled output) directly inside a run: script body —
  // it must only ever appear as an env: value. This is a regression guard
  // for that invariant, not a test of any specific runtime value.
  const out = renderWorkflowTemplate(template, baseAnswers({ allowedPaths: ['index.html'] }));
  const runBlocks = [...out.matchAll(/run: \|\n([\s\S]*?)(?=\n {6}- name:|\n {6}\{\{|\n$)/g)].map((m) => m[1]);
  for (const block of runBlocks) {
    assert.doesNotMatch(block, /\$\{\{\s*steps\.improve\.outputs\.(summary|brief-feedback)/);
  }
});

// --- the merge model: pull request by default, autonomous merge opt-in -------
// The gap this closes: the template used to render only the autonomous-merge
// path, which is the opposite of the call console/DESIGN.md §Step 7 makes for
// this exact file. Both variants are parsed back with js-yaml here, because
// "it renders" and "it is a workflow GitHub would accept" are different
// claims and only the second one matters.

test('buildAdapterObject: approval_class defaults to human-approval-required', () => {
  const adapter = buildAdapterObject(baseAnswers());
  assert.equal(adapter.constitution.approval_class, 'human-approval-required');
});

test('buildAdapterObject: approval_class records an explicit autonomous-merge choice', () => {
  const adapter = buildAdapterObject(baseAnswers({ approvalClass: 'autonomous-merge' }));
  assert.equal(adapter.constitution.approval_class, 'autonomous-merge');
});

test('buildAdapterObject: an unrecognised approval_class is normalised, not echoed', () => {
  // Echoing it would leave an adapter claiming a merge model the workflow
  // rendered beside it does not implement.
  const adapter = buildAdapterObject(baseAnswers({ approvalClass: 'merge-it-please' }));
  assert.equal(adapter.constitution.approval_class, 'human-approval-required');
});

test('renderWorkflowTemplate: the default is the pull-request path — no promote, no verify', () => {
  const out = renderWorkflowTemplate(template, baseAnswers());
  const parsed = loadYaml(out);
  const steps = parsed.jobs['self-improve'].steps;
  const ids = steps.map((s) => s.id).filter(Boolean);
  assert.ok(ids.includes('pr'), 'expected a pull-request step');
  assert.ok(!ids.includes('promote'), 'the default must not merge autonomously');
  assert.ok(!ids.includes('verify'), 'nothing is deployed until a human merges');
  assert.match(out, /gh pr create/);
  // The header comment names promote.mjs while explaining the two models, so
  // assert on what the steps actually run rather than on the file's text.
  assert.ok(steps.every((s) => !/promote\.mjs/.test(s.run || '')));
});

test('renderWorkflowTemplate: the pull-request path records the PR URL into the attempt record', () => {
  const out = renderWorkflowTemplate(template, baseAnswers());
  assert.match(out, /record-pull-request\.mjs/);
  const parsed = loadYaml(out);
  const step = parsed.jobs['self-improve'].steps.find((s) => /Record the pull request URL/.test(s.name));
  assert.ok(step, 'expected a step that records the PR URL');
  assert.equal(step.if, 'steps.pr.outputs.url');
  assert.equal(step.env.PR_URL, '${{ steps.pr.outputs.url }}');
});

test('renderWorkflowTemplate: the pull-request path asks for pull-requests: write, the merge path does not', () => {
  const pr = loadYaml(renderWorkflowTemplate(template, baseAnswers()));
  assert.deepEqual(pr.permissions, { contents: 'write', 'pull-requests': 'write' });

  const auto = loadYaml(renderWorkflowTemplate(template, baseAnswers({ approvalClass: 'autonomous-merge' })));
  assert.deepEqual(auto.permissions, { contents: 'write' });
});

test('renderWorkflowTemplate: autonomous-merge renders promote and verify, and no PR step', () => {
  const out = renderWorkflowTemplate(template, baseAnswers({ approvalClass: 'autonomous-merge' }));
  const parsed = loadYaml(out);
  const ids = parsed.jobs['self-improve'].steps.map((s) => s.id).filter(Boolean);
  assert.ok(ids.includes('promote'));
  assert.ok(ids.includes('verify'));
  assert.ok(!ids.includes('pr'));
  assert.match(out, /promote\.mjs/);
  assert.doesNotMatch(out, /gh pr create/);
});

test('renderWorkflowTemplate: an unrecognised approval_class fails closed to the pull-request path', () => {
  const out = renderWorkflowTemplate(template, baseAnswers({ approvalClass: 'autonomous_merge' }));
  assert.match(out, /gh pr create/);
  const steps = loadYaml(out).jobs['self-improve'].steps;
  assert.ok(steps.every((s) => !/promote\.mjs/.test(s.run || '')));
});

test('renderWorkflowTemplate: both merge paths leave no placeholder and still parse as a workflow', () => {
  for (const approvalClass of ['human-approval-required', 'autonomous-merge']) {
    const out = renderWorkflowTemplate(template, baseAnswers({ approvalClass }));
    assert.doesNotMatch(out, /\{\{[A-Z_]+\}\}/, `${approvalClass} left a placeholder unfilled`);
    const parsed = loadYaml(out);
    assert.equal(parsed.name, 'Self-improvement loop');
    assert.ok(parsed.jobs['self-improve'].steps.every((s) => typeof s === 'object'));
  }
});

test('renderWorkflowTemplate: the gate list names both merge paths, so the digest reports whichever ran', () => {
  // Only one of the two steps exists in any given rendering; the missing
  // one's `outcome` expression resolves to an empty string, which the gates
  // script skips. That's what lets this block be identical either way.
  for (const approvalClass of ['human-approval-required', 'autonomous-merge']) {
    const parsed = loadYaml(renderWorkflowTemplate(template, baseAnswers({ approvalClass })));
    const gates = parsed.jobs['self-improve'].steps.find((s) => s.id === 'gates');
    assert.equal(gates.env.PULL_REQUEST, '${{ steps.pr.outcome }}');
    assert.equal(gates.env.PROMOTE, '${{ steps.promote.outcome }}');
    assert.match(gates.run, /add pull-request "\$PULL_REQUEST"/);
  }
});

test('renderWorkflowTemplate: the PR body and title only ever read model text from env, never ${{ }}', () => {
  const out = renderWorkflowTemplate(template, baseAnswers());
  const parsed = loadYaml(out);
  const pr = parsed.jobs['self-improve'].steps.find((s) => s.id === 'pr');
  assert.equal(pr.env.SUMMARY, '${{ steps.improve.outputs.summary }}');
  assert.doesNotMatch(pr.run, /\$\{\{/);
});

// --- the themes review, and the records that make it possible ----------------

test('renderWorkflowTemplate: runs the themes-review CLI every generation, letting it decide the cadence', () => {
  // Every merge path gets it: it runs before the commit, which is upstream
  // of where the two paths diverge.
  for (const approvalClass of ['human-approval-required', 'autonomous-merge']) {
    const parsed = loadYaml(renderWorkflowTemplate(template, baseAnswers({ approvalClass })));
    const step = parsed.jobs['self-improve'].steps.find((s) => s.id === 'themes');
    assert.ok(step, `${approvalClass} should still run the themes review`);
    assert.match(step.run, /generate-themes-review\.mjs/);
    assert.equal(step['continue-on-error'], true, 'a missed review must not roll back the generation');
    assert.ok(step.env.ANTHROPIC_API_KEY, 'it calls a model, so it needs the provider secrets');
  }
});

test('renderWorkflowTemplate: runs the evaluators, and never lets them fail the job', () => {
  const parsed = loadYaml(renderWorkflowTemplate(template, baseAnswers()));
  const step = parsed.jobs['self-improve'].steps.find((s) => s.id === 'evaluators');
  assert.ok(step);
  assert.match(step.run, /run-evaluators\.mjs/);
  assert.equal(step['continue-on-error'], true);
  // Deliberately absent from the gate list below: these are measurements,
  // and a measurement in the gate list is a gate.
  const gates = parsed.jobs['self-improve'].steps.find((s) => s.id === 'gates');
  assert.doesNotMatch(gates.run, /evaluator/i);
});

test('renderWorkflowTemplate: the themes step runs before the commit, so the review rides the same commit', () => {
  const parsed = loadYaml(renderWorkflowTemplate(template, baseAnswers()));
  const steps = parsed.jobs['self-improve'].steps;
  const themes = steps.findIndex((s) => s.id === 'themes');
  const commit = steps.findIndex((s) => /^Commit and push the agent branch/.test(s.name || ''));
  assert.ok(themes >= 0 && commit >= 0);
  assert.ok(themes < commit, 'a review written after the commit would never be committed');
});

test('renderWorkflowTemplate: commits the harness\'s own record dirs, not only the agent\'s editable paths', () => {
  // The bug this closes: docs/generations is not the agent's editable
  // surface, so a project that (rightly) keeps it out of allowed_paths never
  // committed its own history — and every future run read an empty one.
  const out = renderWorkflowTemplate(template, baseAnswers());
  assert.match(out, /for d in 'docs\/generations' 'docs\/themes'; do/);

  const custom = renderWorkflowTemplate(template, baseAnswers({ generationsDir: 'history', themesDir: 'history' }));
  assert.match(custom, /for d in 'history'; do/, 'one directory named twice should be added once');
});

test('renderWorkflowTemplate: records runtime evidence last, on both merge paths, and never fails the job for it', () => {
  for (const approvalClass of ['human-approval-required', 'autonomous-merge']) {
    const parsed = loadYaml(renderWorkflowTemplate(template, baseAnswers({ approvalClass })));
    const steps = parsed.jobs['self-improve'].steps;
    const evidence = steps.find((s) => s.id === 'evidence');
    assert.ok(evidence, `${approvalClass} should record what it observed`);
    assert.match(evidence.run, /record-runtime-evidence\.mjs/);
    assert.equal(evidence['continue-on-error'], true);
    // always(), because the observations arrive at different points and a
    // run that failed is exactly the one worth having a record of.
    assert.match(evidence.if, /always\(\)/);

    // and it lands on the default branch, not the agent branch: the next run
    // has to be able to read it whether or not this generation ever merged.
    const commit = steps.find((s) => /^Commit the runtime evidence/.test(s.name || ''));
    assert.match(commit.run, /git checkout main/);
    assert.match(commit.run, /git push origin main/);
  }
});

test('renderWorkflowTemplate: the autonomous path asks the deploy check for its observations, not just its verdict', () => {
  const out = renderWorkflowTemplate(template, baseAnswers({ approvalClass: 'autonomous-merge' }));
  assert.match(out, /verify-deployment\.mjs --evidence "\$RUNNER_TEMP\/deploy-evidence\.json"/);
});

// --- the schedule, which may deliberately not be there yet -------------------

test('renderWorkflowTemplate: a schedule is rendered by default, with the answered cron', () => {
  const parsed = loadYaml(renderWorkflowTemplate(template, baseAnswers({ cadenceCron: '0 3 * * 1' })));
  assert.deepEqual(parsed.on.schedule, [{ cron: '0 3 * * 1' }]);
  assert.ok(parsed.on.workflow_dispatch);
});

test('renderWorkflowTemplate: includeSchedule false leaves no cron in the file at all', () => {
  // console/DESIGN.md §Step 9: until the rehearsal has passed there should be
  // nothing in the repository that could fire. A commented-out cron is fine —
  // an uncommented one defeats the point — so assert on the parsed document,
  // not on the text.
  const out = renderWorkflowTemplate(template, baseAnswers({ includeSchedule: false }));
  const parsed = loadYaml(out);
  assert.equal(parsed.on.schedule, undefined);
  assert.ok(parsed.on.workflow_dispatch, 'it must still be runnable by hand');
  assert.match(out, /# schedule:/, 'and should say how to switch it on');
});

// --- renderReadme --------------------------------------------------------------

test('renderReadme: names the project, the generated files, and every secret needed', () => {
  const text = renderReadme(baseAnswers({
    notify: { provider: 'sendgrid', envKey: 'SENDGRID_API_KEY' },
  }));
  assert.match(text, /my-project/);
  assert.match(text, /ANTHROPIC_API_KEY/);
  assert.match(text, /OPENAI_API_KEY/);
  assert.match(text, /SENDGRID_API_KEY/);
  assert.match(text, /\.claude\/agents\/improve\.md/);
});

test('renderReadme: without a notifier configured, says so rather than listing nothing silently', () => {
  const text = renderReadme(baseAnswers({ notify: null }));
  assert.match(text, /ANTHROPIC_API_KEY/); // provider secrets still listed
  assert.doesNotMatch(text, /undefined/);
});

test('renderReadme: says which merge model was installed, in the words of the person who ran init', () => {
  const pr = renderReadme(baseAnswers());
  assert.match(pr, /pull request/i);
  assert.match(pr, /human-approval-required/);
  assert.doesNotMatch(pr, /merges the agent\s*\n?branch/);

  const auto = renderReadme(baseAnswers({ approvalClass: 'autonomous-merge' }));
  assert.match(auto, /autonomous-merge/);
  assert.match(auto, /Nobody is asked first/);
  assert.match(auto, /git revert gen-NNN/);
});

test('renderReadme: with the schedule left off, says so rather than quoting a cron that is not there', () => {
  const text = renderReadme(baseAnswers({ includeSchedule: false, cadenceCron: '0 3 * * 1' }));
  assert.match(text, /There is no schedule yet/);
  assert.match(text, /0 3 \* \* 1/); // shown as the thing to add later
  assert.doesNotMatch(text, /Runs on `0 3 \* \* 1`/);
});

// --- Tier 0: supply-chain pins, the kill switch, provenance ---------------

test('renderWorkflowTemplate: actions are pinned by commit SHA and js-yaml by exact version with scripts disabled', () => {
  const out = renderWorkflowTemplate(template, baseAnswers());
  assert.match(out, /uses: actions\/checkout@[0-9a-f]{40} # v4/);
  assert.match(out, /uses: actions\/setup-node@[0-9a-f]{40} # v4/);
  assert.doesNotMatch(out, /uses: actions\/[a-z-]+@v\d/);
  assert.match(out, new RegExp(`npm install --no-save --ignore-scripts js-yaml@${JS_YAML_VERSION.replace(/\\./g, '\\\\.')}`));
  assert.match(JS_YAML_VERSION, /^\d+\.\d+\.\d+$/);
});

test('JS_YAML_VERSION matches the version package.json pins for the harness itself', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  assert.equal(`^${JS_YAML_VERSION}`, pkg.dependencies['js-yaml']);
});

test('renderWorkflowTemplate: the kill switch runs first, gates the release check, and reaches the digest', () => {
  const out = renderWorkflowTemplate(template, baseAnswers({ notify: { provider: 'sendgrid', envKey: 'SENDGRID_API_KEY', recipient: 'a@b.c', fromEmail: 'x@y.z' } }));
  const pauseAt = out.indexOf('id: pause');
  const checkAt = out.indexOf('id: check');
  assert.ok(pauseAt > 0 && pauseAt < checkAt, 'pause step precedes the release check');
  assert.match(out, /PAUSED: \$\{\{ vars\.SELF_IMPROVE_PAUSED \}\}/);
  assert.match(out, /id: check\n\s+if: steps\.pause\.outputs\.paused != 'true'/);
  assert.match(out, /PAUSED: \$\{\{ steps\.pause\.outputs\.paused \}\}/);
  assert.doesNotThrow(() => loadYaml(out));
});

test('buildAdapterObject: records the harness version it was scaffolded by, and "unknown" when none was supplied', () => {
  assert.equal(buildAdapterObject(baseAnswers({ harnessVersion: '0.1.0' })).harness.version, '0.1.0');
  assert.equal(buildAdapterObject(baseAnswers()).harness.version, 'unknown');
});

test('buildAdapterObject: a per-generation token budget is written by default, and an answered one is honoured', () => {
  assert.equal(buildAdapterObject(baseAnswers()).budget.max_generation_tokens, 2000000);
  assert.equal(buildAdapterObject(baseAnswers({ maxGenerationTokens: 750000 })).budget.max_generation_tokens, 750000);
});

test('renderWorkflowTemplate: reads pull-request outcomes back at the top of every cycle, before the agent branch exists', () => {
  const out = renderWorkflowTemplate(template, baseAnswers({ generationsDir: 'history/gens' }));
  const syncAt = out.indexOf('sync-pull-request-outcomes.mjs');
  const branchAt = out.indexOf('Create the agent branch');
  assert.ok(syncAt > 0 && syncAt < branchAt);
  assert.match(out, /sync-pull-request-outcomes\.mjs --generations-dir 'history\/gens'/);
  assert.match(out, /id: prs\n\s+if: steps\.pause\.outputs\.paused != 'true'/);
  assert.doesNotThrow(() => loadYaml(out));
});

test('buildAdapterObject: the ambition dial defaults to earned and is normalised, never echoed', () => {
  assert.equal(buildAdapterObject(baseAnswers()).context.ambition, 'earned');
  assert.equal(buildAdapterObject(baseAnswers({ ambition: 'ambitious' })).context.ambition, 'ambitious');
  assert.equal(buildAdapterObject(baseAnswers({ ambition: 'AMBITIOUS!' })).context.ambition, 'earned');
});

test('renderReadme: tells the owner how to undo a generation, and which ambition setting they chose', () => {
  const readme = renderReadme(baseAnswers({ ambition: 'ambitious' }));
  assert.match(readme, /revert-generation\.mjs NNN --reason/);
  assert.match(readme, /context\.ambition`, currently\n?`ambitious`/);
});

test('renderWorkflowTemplate: regenerates the operational report in the same bookkeeping step as the pull-request read-back', () => {
  const out = renderWorkflowTemplate(template, baseAnswers());
  assert.match(out, /sync-pull-request-outcomes\.mjs[\s\S]*?report\.mjs --generations-dir 'docs\/generations'/);
});

test('renderWorkflowTemplate: campaign mode replaces the release check when models are named, and never touches the snapshot', () => {
  const out = renderWorkflowTemplate(template, baseAnswers());
  assert.match(out, /models:\n\s+description: 'Campaign mode/);
  assert.match(out, /id: campaign\n\s+if: steps\.pause\.outputs\.paused != 'true' && steps\.validate\.outcome == 'success' && github\.event\.inputs\.models/);
  assert.match(out, /id: check\n\s+if: steps\.pause\.outputs\.paused != 'true' && steps\.validate\.outcome == 'success' && !github\.event\.inputs\.models/);
  assert.match(out, /Commit the updated model snapshot\n\s+if: .*!github\.event\.inputs\.models/);
  assert.match(out, /id: probe\n\s+if: steps\.check\.outputs\.has-new == 'true' \|\| steps\.campaign\.outputs\.has-new == 'true'/);
  assert.match(out, /CAMPAIGN: \$\{\{ steps\.campaign\.outputs\.has-new \}\}/);
  assert.doesNotThrow(() => loadYaml(out));
});

test('buildAdapterObject: a goal is written under project.goal only when the owner gave one', () => {
  assert.equal(buildAdapterObject(baseAnswers()).project.goal, undefined);
  assert.deepEqual(buildAdapterObject(baseAnswers({ goalStatement: 'Become calm.' })).project.goal, { statement: 'Become calm.', holds: [], away_from: [] });
});
