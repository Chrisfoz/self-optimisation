import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import '../../harness/providers/index.mjs';
import { getProvider, resolveProvider } from '../../harness/lib/llm-provider.mjs';
import { runChecks, report } from '../../harness/lib/doctor.mjs';

const REPO_ROOT = path.join(import.meta.dirname, '../..');

const ADAPTER = {
  project: { id: 'w', repository: 'https://github.com/acme/widget' },
  providers: { watched: ['deepseek'] },
  roles: { implement: { model: 'claude-opus-5' }, review: { model: 'claude-opus-5' }, agent_brief_path: 'improve.md', reviewer_brief_path: 'review.md' },
  constitution: { allowed_paths: ['index.html'], frozen_paths: ['.github/**'], approval_class: 'human-approval-required' },
  evaluation: { test_commands: ['node --test'] },
};

/** Everything healthy; each test breaks one thing. */
function deps(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<html>');
  fs.writeFileSync(path.join(root, 'improve.md'), 'Improve it.');
  fs.writeFileSync(path.join(root, 'review.md'), 'Review it.');
  return {
    nodeVersion: '22.11.0',
    repoRoot: root,
    exists: () => true,
    git: (args) => ({ status: args[0] === 'check-ignore' && args[2] !== 'harness/.env.harness.local' ? 1 : 0, stdout: '' }),
    gh: (args) => {
      if (args[0] === 'auth') return { status: 0 };
      if (args[0] === 'secret') return { status: 0, stdout: JSON.stringify([{ name: 'DEEPSEEK_API_KEY' }, { name: 'ANTHROPIC_API_KEY' }]) };
      return { status: 0, stdout: JSON.stringify({ default_workflow_permissions: 'read', can_approve_pull_request_reviews: true }) };
    },
    adapter: ADAPTER,
    env: { DEEPSEEK_API_KEY: 'k1', ANTHROPIC_API_KEY: 'k2' },
    checkKeys: async (providers) => ({ results: providers.map((p) => ({ provider: p, envKey: getProvider(p).envKey, state: 'ok' })) }),
    checkUpgrade: async () => ({ local: '0.1.0', upstream: '0.1.0', behind: false }),
    providerEnvKey: (name) => getProvider(name).envKey,
    modelProvider: (model) => { try { return resolveProvider(model); } catch { return null; } },
    ...overrides,
  };
}
const byName = (checks) => Object.fromEntries(checks.map((c) => [c.name, c]));

test('a healthy installation is all ok, and reports Ready', async () => {
  const checks = await runChecks(deps());
  assert.deepEqual(checks.filter((c) => c.status !== 'ok').map((c) => `${c.name}: ${c.detail}`), []);
  assert.deepEqual(checks.map((c) => c.name), ['Node', 'Adapter', 'Workflow', 'Env file', 'Keys', 'Snapshot', 'Secrets', 'PR permission', 'Harness']);
  assert.equal(report(checks).code, 0);
  assert.match(report(checks).lines.at(-1), /Ready/);
});

test('no adapter stops early and names init', async () => {
  const checks = await runChecks(deps({ adapter: null }));
  assert.deepEqual(checks.map((c) => c.name), ['Node', 'Adapter']);
  assert.equal(byName(checks).Adapter.fix, 'node harness/cli/init.mjs --quick');
});

test('old Node fails with the install instruction', async () => {
  const c = byName(await runChecks(deps({ nodeVersion: '20.18.0' }))).Node;
  assert.equal(c.status, 'fail');
  assert.match(c.fix, /22\.11/);
});

test('an env file git does not ignore is a failure — a commit would publish the keys', async () => {
  const c = byName(await runChecks(deps({ git: (args) => ({ status: 1, stdout: '' }) })))['Env file'];
  assert.equal(c.status, 'fail');
  assert.match(c.fix, /\.env\.\*/);
});

test('a blank key needed by a pinned seat fails without calling any lab', async () => {
  let called = false;
  const c = byName(await runChecks(deps({
    env: { DEEPSEEK_API_KEY: 'k1', ANTHROPIC_API_KEY: '  ' },
    checkKeys: async () => { called = true; return { results: [] }; },
  }))).Keys;
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /ANTHROPIC_API_KEY/);
  assert.equal(called, false);
});

test('a key a lab rejects fails, pointing at check-keys', async () => {
  const c = byName(await runChecks(deps({
    checkKeys: async () => ({ results: [{ provider: 'deepseek', envKey: 'DEEPSEEK_API_KEY', state: 'rejected', detail: '402 billing_not_configured' }] }),
  }))).Keys;
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /DEEPSEEK_API_KEY: 402/);
  assert.match(c.fix, /check-keys\.mjs/);
});

test('a missing GitHub secret and an unticked PR box both fail, pointing at --configure-github', async () => {
  const checks = byName(await runChecks(deps({
    gh: (args) => {
      if (args[0] === 'auth') return { status: 0 };
      if (args[0] === 'secret') return { status: 0, stdout: JSON.stringify([{ name: 'DEEPSEEK_API_KEY' }]) };
      return { status: 0, stdout: JSON.stringify({ default_workflow_permissions: 'read', can_approve_pull_request_reviews: false }) };
    },
  })));
  assert.equal(checks.Secrets.status, 'fail');
  assert.match(checks.Secrets.detail, /ANTHROPIC_API_KEY/);
  assert.equal(checks['PR permission'].status, 'fail');
  assert.equal(checks['PR permission'].fix, 'node harness/cli/init.mjs --configure-github');
});

test('autonomous merge does not need the PR box, so it is not checked', async () => {
  const checks = await runChecks(deps({ adapter: { ...ADAPTER, constitution: { ...ADAPTER.constitution, approval_class: 'autonomous-merge' } } }));
  assert.ok(!checks.some((c) => c.name === 'PR permission'));
});

test('an ignored snapshot fails; an uncommitted one only warns', async () => {
  const ignored = byName(await runChecks(deps({ git: (args) => ({ status: 0, stdout: '' }) }))).Snapshot;
  assert.equal(ignored.status, 'fail');
  const uncommitted = byName(await runChecks(deps({
    git: (args) => ({ status: args[0] === 'ls-files' ? 1 : args[2] === 'harness/.env.harness.local' ? 0 : 1, stdout: '' }),
  }))).Snapshot;
  assert.equal(uncommitted.status, 'warn');
});

test('--offline calls nothing outside the machine', async () => {
  const outside = [];
  const checks = byName(await runChecks(deps({
    offline: true,
    gh: (args) => { outside.push(args); return { status: 0 }; },
    checkKeys: async () => { outside.push('keys'); return { results: [] }; },
    checkUpgrade: async () => { outside.push('upgrade'); return {}; },
  })));
  assert.deepEqual(outside, []);
  assert.equal(checks.Keys.status, 'skip');
  assert.equal(checks.GitHub.status, 'skip');
  assert.equal(checks.Harness.status, 'skip');
});

test('doctor.mjs --offline on a fresh copied install names what is left to do', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  fs.cpSync(path.join(REPO_ROOT, 'harness'), path.join(root, 'harness'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(root, '.gitignore'), '.env.*\n!.env.harness.example\n');
  spawnSync(process.execPath, ['harness/cli/init.mjs', '--yes'], { cwd: root, encoding: 'utf8' });

  const result = spawnSync(process.execPath, ['harness/scripts/doctor.mjs', '--offline'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /(✅|⚠️) +Adapter +valid/);
  assert.match(result.stdout, /✅ Env file\s+harness\/\.env\.harness\.local, git-ignored/);
  assert.match(result.stdout, /❌ Keys\s+blank or missing/);
  assert.match(result.stdout, /thing\(s\) to fix/);
});
