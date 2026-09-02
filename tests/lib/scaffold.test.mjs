import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { buildAdapterObject, renderAdapterYaml, renderWorkflowTemplate, renderReadme, requiredProviders } from '../../harness/lib/scaffold.mjs';

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
