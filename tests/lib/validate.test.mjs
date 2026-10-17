import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import '../../harness/providers/index.mjs';
import { validateAdapter } from '../../harness/lib/validate.mjs';

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'validate-test-'));
}

/** A minimal, structurally valid adapter + repo, for tests to mutate one thing at a time. */
function validSetup() {
  const repoRoot = tempRepo();
  fs.writeFileSync(path.join(repoRoot, 'index.html'), '<html></html>');
  fs.mkdirSync(path.join(repoRoot, '.claude/agents'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.claude/agents/improve.md'), 'Improve the project. No placeholders here.');
  fs.writeFileSync(path.join(repoRoot, '.claude/agents/review.md'), 'Review the change. No placeholders here.');
  const adapter = {
    project: { id: 'test-project' },
    constitution: {
      allowed_paths: ['index.html'],
      frozen_paths: ['.github/**'],
      append_only_paths: [],
    },
    roles: {
      agent_brief_path: '.claude/agents/improve.md',
      reviewer_brief_path: '.claude/agents/review.md',
      implement: { model: 'claude-opus-5' },
      review: { model: 'claude-opus-5' },
    },
    providers: { watched: ['anthropic'] },
  };
  return { repoRoot, adapter };
}

test('a well-formed adapter over a matching repo produces no errors or warnings', (t) => {
  const { repoRoot, adapter } = validSetup();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const result = validateAdapter(adapter, { repoRoot, env: { ANTHROPIC_API_KEY: 'x' } });
  assert.deepEqual(result, { errors: [], warnings: [] });
});

// WORKPLAN I10. A copied install has no step that installs the project's own
// dependencies unless evaluation.setup_commands says so, and preflight runs
// the project's real test command. The first real install on a jest project
// exited 127 and skipped every generation before it started.
test('warns when a copied install runs a test command that needs dependencies nothing installs', (t) => {
  const { repoRoot, adapter } = validSetup();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  adapter.evaluation = { test_commands: ['npm run test:unit'] };
  const { errors, warnings } = validateAdapter(adapter, { repoRoot, env: { ANTHROPIC_API_KEY: 'x' } });
  assert.deepEqual(errors, [], 'a warning, not an error — the heuristic can be wrong');
  const hit = warnings.find((w) => /setup_commands/.test(w));
  assert.ok(hit, `expected a setup_commands warning, got: ${JSON.stringify(warnings)}`);
  assert.match(hit, /exit 127/);
  assert.match(hit, /npm ci --ignore-scripts/, 'it should name the fix, not just the problem');
});

test('no setup warning once setup_commands is filled in', (t) => {
  const { repoRoot, adapter } = validSetup();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  adapter.evaluation = { test_commands: ['npm run test:unit'], setup_commands: ['npm ci --ignore-scripts'] };
  const { warnings } = validateAdapter(adapter, { repoRoot, env: { ANTHROPIC_API_KEY: 'x' } });
  assert.equal(warnings.filter((w) => /setup_commands/.test(w)).length, 0);
});

test('no setup warning for a suite that needs no install, or for a shared install', (t) => {
  const { repoRoot, adapter } = validSetup();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  // Node's own test runner, Go: nothing to install. The harness must not
  // invent a dependency step for these.
  for (const cmd of ['node --test tests/', 'go test ./...']) {
    adapter.evaluation = { test_commands: [cmd] };
    const { warnings } = validateAdapter(adapter, { repoRoot, env: { ANTHROPIC_API_KEY: 'x' } });
    assert.equal(warnings.filter((w) => /setup_commands/.test(w)).length, 0, cmd);
  }
  // A shared install runs setup_commands from the adapter on every run, so
  // the copied-install gap does not apply to it.
  adapter.evaluation = { test_commands: ['npm run test:unit'] };
  adapter.harness = { shared: { repository: 'o/r', ref: 'a'.repeat(40) } };
  const { warnings } = validateAdapter(adapter, { repoRoot, env: { ANTHROPIC_API_KEY: 'x' } });
  assert.equal(warnings.filter((w) => /setup_commands/.test(w)).length, 0, 'shared');
});

test('rejects a non-object adapter without touching the filesystem', () => {
  const result = validateAdapter(null, { repoRoot: '/does/not/matter' });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /no adapter object/i);
});

test('project.id is required', (t) => {
  const { repoRoot, adapter } = validSetup();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  delete adapter.project.id;
  const { errors } = validateAdapter(adapter, { repoRoot });
  assert.ok(errors.some((e) => /project\.id is required/.test(e)));
});

test('a goal with no statement is a validation error, not a crash', (t) => {
  const { repoRoot, adapter } = validSetup();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  adapter.project.goal = { holds: ['x'] };
  const { errors } = validateAdapter(adapter, { repoRoot });
  assert.ok(errors.some((e) => /project\.goal/.test(e)));
});

test('empty allowed_paths is an error', (t) => {
  const { repoRoot, adapter } = validSetup();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  adapter.constitution.allowed_paths = [];
  const { errors } = validateAdapter(adapter, { repoRoot });
  assert.ok(errors.some((e) => /allowed_paths is empty/.test(e)));
});

test('an allowed path that does not exist in the repo is an error', (t) => {
  const { repoRoot, adapter } = validSetup();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  adapter.constitution.allowed_paths.push('does-not-exist.js');
  const { errors } = validateAdapter(adapter, { repoRoot });
  assert.ok(errors.some((e) => /"does-not-exist\.js" does not exist/.test(e)));
});

test('an allowed path that also matches a frozen glob is an error', (t) => {
  const { repoRoot, adapter } = validSetup();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repoRoot, '.github'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.github/workflow.yml'), 'x');
  adapter.constitution.allowed_paths.push('.github/workflow.yml');
  adapter.constitution.frozen_paths = ['.github/**'];
  const { errors } = validateAdapter(adapter, { repoRoot });
  assert.ok(errors.some((e) => /also matches frozen_paths/.test(e)));
});

test('an allowed path that also matches an append-only glob is an error', (t) => {
  const { repoRoot, adapter } = validSetup();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'tests/existing.test.js'), 'x');
  adapter.constitution.allowed_paths.push('tests/existing.test.js');
  adapter.constitution.append_only_paths = ['tests/**'];
  const { errors } = validateAdapter(adapter, { repoRoot });
  assert.ok(errors.some((e) => /also matches append_only_paths/.test(e)));
});

test('warns when .github/** is not frozen and not deliberately overridden', (t) => {
  const { repoRoot, adapter } = validSetup();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  adapter.constitution.frozen_paths = [];
  const { warnings } = validateAdapter(adapter, { repoRoot });
  assert.ok(warnings.some((w) => /does not appear to cover \.github/.test(w)));
});

test('does not warn about .github when it is frozen', (t) => {
  const { repoRoot, adapter } = validSetup();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const { warnings } = validateAdapter(adapter, { repoRoot, env: { ANTHROPIC_API_KEY: 'x' } });
  assert.ok(!warnings.some((w) => /\.github/.test(w)));
});

test('does not warn about .github when an allowed path deliberately overrides it', (t) => {
  const { repoRoot, adapter } = validSetup();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repoRoot, '.github'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.github/ISSUE_TEMPLATE.md'), 'x');
  adapter.constitution.frozen_paths = [];
  adapter.constitution.allowed_paths.push('.github/ISSUE_TEMPLATE.md');
  const { warnings } = validateAdapter(adapter, { repoRoot });
  assert.ok(!warnings.some((w) => /does not appear to cover \.github/.test(w)));
});

test('a missing brief path is an error', (t) => {
  const { repoRoot, adapter } = validSetup();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  delete adapter.roles.agent_brief_path;
  const { errors } = validateAdapter(adapter, { repoRoot });
  assert.ok(errors.some((e) => /roles\.agent_brief_path is not set/.test(e)));
});

test('a brief path pointing at a file that does not exist is an error', (t) => {
  const { repoRoot, adapter } = validSetup();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  adapter.roles.reviewer_brief_path = '.claude/agents/missing.md';
  const { errors } = validateAdapter(adapter, { repoRoot });
  assert.ok(errors.some((e) => /roles\.reviewer_brief_path.*does not exist/.test(e)));
});

test('an unfilled [placeholder] in a brief file is a warning naming the field and an example', (t) => {
  const { repoRoot, adapter } = validSetup();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, '.claude/agents/improve.md'), 'You are an agent for [WHAT]. Trigger: [TRIGGER CONDITION].');
  const { warnings } = validateAdapter(adapter, { repoRoot, env: { ANTHROPIC_API_KEY: 'x' } });
  const hit = warnings.find((w) => /roles\.agent_brief_path/.test(w));
  assert.ok(hit, warnings.join('\n'));
  assert.match(hit, /2 unfilled placeholder/);
  assert.match(hit, /\[WHAT\]/);
});

test('a markdown link is not mistaken for a placeholder', (t) => {
  const { repoRoot, adapter } = validSetup();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, '.claude/agents/improve.md'), 'See [the docs](https://example.com) for more.');
  const { warnings } = validateAdapter(adapter, { repoRoot, env: { ANTHROPIC_API_KEY: 'x' } });
  assert.ok(!warnings.some((w) => /agent_brief_path/.test(w)));
});

test('an unregistered watched provider is an error', (t) => {
  const { repoRoot, adapter } = validSetup();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  adapter.providers.watched.push('not-a-real-lab');
  const { errors } = validateAdapter(adapter, { repoRoot });
  assert.ok(errors.some((e) => /"not-a-real-lab" is not a registered provider/.test(e)));
});

test('a pinned model that resolves to no registered provider is a warning', (t) => {
  const { repoRoot, adapter } = validSetup();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  adapter.roles.review.model = 'totally-unresolvable-model-xyz';
  const { warnings } = validateAdapter(adapter, { repoRoot, env: { ANTHROPIC_API_KEY: 'x' } });
  assert.ok(warnings.some((w) => /roles\.review\.model.*does not resolve/.test(w)));
});

test('warns when a needed provider has no API key in the given environment', (t) => {
  const { repoRoot, adapter } = validSetup();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const { warnings } = validateAdapter(adapter, { repoRoot, env: {} });
  assert.ok(warnings.some((w) => /anthropic: ANTHROPIC_API_KEY is not set/.test(w)));
});

test('does not warn about a missing key when the environment has it', (t) => {
  const { repoRoot, adapter } = validSetup();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const { warnings } = validateAdapter(adapter, { repoRoot, env: { ANTHROPIC_API_KEY: 'sk-real' } });
  assert.ok(!warnings.some((w) => /ANTHROPIC_API_KEY/.test(w)));
});

test('context.strategy: scoped and full-dump are accepted; anything else is warned about', (t) => {
  const { repoRoot, adapter } = validSetup();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  for (const strategy of ['scoped', 'full-dump']) {
    assert.deepEqual(validateAdapter({ ...adapter, context: { strategy } }, { repoRoot, env: { ANTHROPIC_API_KEY: 'x' } }).warnings, []);
  }
  const { warnings } = validateAdapter({ ...adapter, context: { strategy: 'retrieval' } }, { repoRoot, env: { ANTHROPIC_API_KEY: 'x' } });
  assert.match(warnings.join('\n'), /context\.strategy is "retrieval"/);
});
