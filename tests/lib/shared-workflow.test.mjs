import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { load as loadYaml } from '../../harness/vendor/js-yaml.mjs';
import '../../harness/providers/index.mjs';
import { registeredProviders, getProvider } from '../../harness/lib/llm-provider.mjs';
import { renderSharedWorkflow, SHARED_WORKFLOW_PATH } from '../../harness/lib/scaffold.mjs';
import { findStep, runStep, fakeTool, shellTestOptions } from '../helpers/gha-shell.mjs';

// The workflow every project calls at a pinned commit instead of carrying a
// copy of harness/. It is rendered from the same template as a copied-in
// workflow; these tests hold it to doing the same job without anything
// project-specific baked in.

const root = path.join(import.meta.dirname, '../..');
const template = fs.readFileSync(path.join(root, 'harness/templates/workflow.yml.tmpl'), 'utf8');
const providers = registeredProviders().map((name) => ({ name, envKey: getProvider(name).envKey }));
const committed = fs.readFileSync(path.join(root, SHARED_WORKFLOW_PATH), 'utf8').replace(/\r\n/g, '\n');
const doc = loadYaml(committed);
const steps = doc.jobs['self-improve'].steps;
const index = (idOrName) => steps.findIndex((s) => s.id === idOrName || s.name === idOrName);
const opts = shellTestOptions();

test('the committed shared workflow is exactly what the template renders', () => {
  assert.equal(committed, renderSharedWorkflow(template, { providers }),
    `${SHARED_WORKFLOW_PATH} is out of date. Run: node harness/scripts/render-shared-workflow.mjs`);
});

test('it is only ever called: workflow_call inputs, no schedule, no dispatch, no concurrency of its own', () => {
  assert.deepEqual(Object.keys(doc.on), ['workflow_call']);
  assert.deepEqual(Object.keys(doc.on.workflow_call.inputs), ['scope', 'models', 'check_keys', 'runner']);
  // A called workflow in its caller's concurrency group waits for itself forever.
  assert.ok(!('concurrency' in doc));
  assert.equal(doc.jobs['self-improve']['runs-on'], '${{ inputs.runner }}');
  assert.doesNotMatch(committed, /\{\{[A-Z_]+\}\}/);
  assert.doesNotMatch(committed, /github\.event\.inputs/);
});

test('it runs the harness it was called at, fetched by SHA, before any harness script', () => {
  const fetch = findStep(steps, 'Fetch the harness this workflow was called at');
  assert.equal(fetch.env.HARNESS_SHA, '${{ job.workflow_sha }}');
  assert.equal(fetch.env.HARNESS_REPOSITORY, '${{ job.workflow_repository }}');
  assert.match(fetch.run, /fetch -q --depth 1 "https:\/\/github\.com\/\$HARNESS_REPOSITORY" "\$HARNESS_SHA"/);
  assert.match(fetch.run, /rev-parse HEAD\)" != "\$HARNESS_SHA"/);
  const firstScript = steps.findIndex((s) => /\/scripts\//.test(s.run || ''));
  assert.ok(index(fetch.name) < firstScript);
  assert.ok(steps.every((s) => !/node harness\//.test(s.run || '')), 'no step runs a harness the project does not have');
});

test('the project configuration is read once, before the pause check, and gates validation', () => {
  const config = findStep(steps, 'config');
  assert.equal(config.run, 'node "$HARNESS_DIR"/scripts/workflow-config.mjs');
  assert.equal(config['continue-on-error'], true);
  assert.ok(index('config') < index('pause'), 'a paused run still knows whether to send its digest');
  assert.equal(findStep(steps, 'validate').run, 'test -s "$RUNNER_TEMP/project-config.json" && node "$HARNESS_DIR"/scripts/validate.mjs');
  // Both test gates run the saved commands, never a list re-read later.
  assert.match(findStep(steps, 'preflight').run, /run-project-commands\.mjs setup\n.*run-project-commands\.mjs test/);
  assert.equal(findStep(steps, 'tests').run.trim(), 'node "$HARNESS_DIR"/scripts/run-project-commands.mjs test');
});

test('both merge paths are present, and anything but autonomous-merge opens a pull request', () => {
  assert.equal(findStep(steps, 'pr').if, "steps.tests.outcome == 'success' && env.APPROVAL_CLASS != 'autonomous-merge'");
  assert.equal(findStep(steps, 'promote').if, "steps.tests.outcome == 'success' && env.APPROVAL_CLASS == 'autonomous-merge'");
  assert.equal(findStep(steps, 'verify').if, "steps.promote.outcome == 'success'");
  assert.deepEqual(doc.permissions, { contents: 'write', 'pull-requests': 'write' });
});

test('the digest runs only for a project that configured one', () => {
  assert.equal(findStep(steps, 'Send the generation digest').if, "always() && env.NOTIFY_CONFIGURED == 'true'");
});

test('every model-calling step gets every registered lab key, because watched labs are only known at run time', () => {
  const calling = ['validate.mjs', 'check-model-releases.mjs', 'probe-models.mjs', 'run-generation.mjs',
    'generate-themes-review.mjs', 'send-digest.mjs', 'send-escalation-notice.mjs'];
  for (const script of calling) {
    const step = steps.find((s) => (s.run || '').includes(`scripts/${script}`));
    assert.ok(step, `no step runs ${script}`);
    for (const { envKey } of providers) assert.equal(step.env?.[envKey], `\${{ secrets.${envKey} }}`, `${step.name} is missing ${envKey}`);
  }
});

// --- the new shell, run the way GitHub runs it -------------------------------

test('fetch: anything but a full commit SHA stops before git is ever run', opts, () => {
  const git = fakeTool('git', 'echo called >> "$(dirname "$0")/calls"');
  for (const sha of ['main', 'v1', 'abc123', '']) {
    const r = runStep(findStep(steps, 'Fetch the harness this workflow was called at'), {
      pathPrepend: [git.dir],
      env: { HARNESS_SHA: sha, HARNESS_REPOSITORY: 'Chrisfoz/self-optimisation', GITHUB_ENV: path.join(git.dir, 'env') },
    });
    assert.notEqual(r.status, 0, `accepted "${sha}"`);
    assert.match(r.stdout, /Could not tell which harness commit/);
  }
  assert.ok(!fs.existsSync(path.join(git.dir, 'calls')), 'git never ran');
});

test('commit: only the saved editable paths are added, including one with a space', opts, (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-commit-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const origin = path.join(work, 'origin.git');
  const clone = path.join(work, 'clone');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  git(work, 'init', '-q', '--bare', origin);
  git(work, 'clone', '-q', origin, clone);
  git(clone, 'config', 'user.email', 't@example.com');
  git(clone, 'config', 'user.name', 'T');
  fs.mkdirSync(path.join(clone, 'src'));
  for (const f of ['src/a b.js', 'src/other.js']) fs.writeFileSync(path.join(clone, f), 'before\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'base');
  git(clone, 'checkout', '-q', '-b', 'agent/gen-001');
  for (const f of ['src/a b.js', 'src/other.js']) fs.writeFileSync(path.join(clone, f), 'after\n');

  const runnerTemp = path.join(work, 'runner');
  fs.mkdirSync(runnerTemp);
  fs.writeFileSync(path.join(runnerTemp, 'editable-paths'), 'src/a b.js\n');
  const step = steps.find((s) => /Commit and push the agent branch/.test(s.name || ''));
  const r = runStep(step, {
    cwd: clone,
    env: { RUNNER_TEMP: runnerTemp.replace(/\\/g, '/'), BRANCH: 'agent/gen-001', GEN_NUMBER: '001', SUMMARY: 'change' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(clone, 'show', '--name-only', '--format=', 'HEAD').trim(), 'src/a b.js');
  assert.match(git(clone, 'status', '--porcelain'), /src\/other\.js/, 'the unlisted file was left alone');
});

test('guard: with the configuration unread, it stops instead of guarding against an empty branch', opts, () => {
  const node = fakeTool('node', 'echo ran >> "$(dirname "$0")/calls"');
  const r = runStep(findStep(steps, 'guard'), { pathPrepend: [node.dir], env: { DEFAULT_BRANCH: '' } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /the project configuration was not read/);
  assert.ok(!fs.existsSync(path.join(node.dir, 'calls')), 'the guard never ran');
});
