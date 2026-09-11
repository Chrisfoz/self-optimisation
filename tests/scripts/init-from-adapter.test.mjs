import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { load as loadYaml } from 'js-yaml';
import '../../harness/providers/index.mjs';
import { getProvider, resolveProvider } from '../../harness/lib/llm-provider.mjs';
import { buildAdapterObject, answersFromAdapter, renderWorkflowTemplate, renderAdapterYaml, renderReadme } from '../../harness/lib/scaffold.mjs';

// The install README used to say "set approval_class and re-run init with
// --force" — which asked every question again and overwrote the adapter.
// `init --from-adapter` renders from the adapter itself. These tests hold it
// to producing exactly what the questions would have.

const root = path.join(import.meta.dirname, '../..');
const template = fs.readFileSync(path.join(root, 'harness/templates/workflow.yml.tmpl'), 'utf8');
const deps = {
  providerEnvKey: (name) => getProvider(name)?.envKey,
  modelProvider: (model) => { try { return resolveProvider(model); } catch { return null; } },
};

function answers(overrides = {}) {
  const base = {
    projectId: 'icd-mapper', defaultBranch: 'main',
    allowedPaths: ['icd_mapper.py', 'excel_to_txt.py'], createOnlyPaths: ['tests/new_*.py'],
    frozenPaths: ['.github/**', 'tests/**'], appendOnlyPaths: [],
    testCommands: ['python -m pip install -q -r requirements.txt pytest', 'python -m pytest -q tests'],
    providers: [{ name: 'deepseek', envKey: 'DEEPSEEK_API_KEY' }, { name: 'zai', envKey: 'ZAI_API_KEY' }],
    implementModel: 'claude-opus-5', reviewModel: 'gpt-5.5', rankModel: '',
    generationsDir: 'history/gens', themesDir: 'history/themes',
    includeSchedule: false, cadenceCron: '0 6 * * 1', runner: 'ubuntu-latest',
    agentBriefPath: '.claude/agents/improve.md', reviewerBriefPath: '.claude/agents/review.md',
    deploymentStrategy: 'none', notify: null,
    ...overrides,
  };
  // What init.mjs itself resolves from the pinned seats.
  const roleModels = [base.implementModel, base.reviewModel, base.rankModel, ...(base.notify ? ['claude-opus-5'] : [])];
  base.roleProviders = [...new Set(roleModels.filter(Boolean).map(deps.modelProvider))].map((name) => ({ name, envKey: deps.providerEnvKey(name) }));
  return base;
}

const cases = {
  'pull request, no schedule': {},
  'autonomous merge, scheduled, url verification': {
    approvalClass: 'autonomous-merge', includeSchedule: true,
    deploymentStrategy: 'url', deploymentUrl: { productionUrl: 'https://example.org', watchedFiles: ['index.html'] },
  },
  'registry verification and email notifications': {
    deploymentStrategy: 'registry', deploymentRegistry: { ecosystem: 'pypi', package: 'icd-mapper' },
    notify: { provider: 'sendgrid', envKey: 'SENDGRID_API_KEY', recipient: 'a@b.c', fromEmail: 'x@y.z' },
  },
};

for (const [name, overrides] of Object.entries(cases)) {
  test(`answersFromAdapter round-trips: ${name}`, () => {
    const original = answers(overrides);
    // Through YAML, as it would be on disk.
    const adapter = loadYaml(renderAdapterYaml(original));
    const regenerated = answersFromAdapter(adapter, deps);
    assert.equal(renderWorkflowTemplate(template, regenerated), renderWorkflowTemplate(template, original));
    assert.equal(renderReadme(regenerated), renderReadme(original));
    assert.deepEqual(buildAdapterObject(regenerated), buildAdapterObject(original));
  });
}

test('init --from-adapter regenerates the workflow and README, leaves the adapter and briefs alone, and needs --force to replace', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-from-adapter-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const adapterYaml = renderAdapterYaml(answers({ approvalClass: 'human-approval-required' }));
  fs.writeFileSync(path.join(dir, 'project-adapter.yml'), adapterYaml);
  fs.mkdirSync(path.join(dir, '.claude/agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude/agents/improve.md'), 'MY REAL BRIEF');
  fs.writeFileSync(path.join(dir, '.claude/agents/review.md'), 'MY REAL REVIEW BRIEF');
  for (const f of ['icd_mapper.py', 'excel_to_txt.py']) fs.writeFileSync(path.join(dir, f), '');
  const init = (...args) => spawnSync(process.execPath, [path.join(root, 'harness/cli/init.mjs'), ...args], { cwd: dir, encoding: 'utf8', stdin: 'ignore' });

  const first = init('--from-adapter');
  assert.match(first.stdout, /wrote \.github\/workflows\/self-improve\.yml/);
  const workflow = loadYaml(fs.readFileSync(path.join(dir, '.github/workflows/self-improve.yml'), 'utf8'));
  assert.ok(!('schedule' in workflow.on), 'the adapter said no schedule');
  assert.ok(workflow.jobs['self-improve'].steps.some((s) => s.id === 'pr'));
  assert.match(fs.readFileSync(path.join(dir, 'SELF-IMPROVE-README.md'), 'utf8'), /Allow GitHub\s+Actions to create and approve pull requests/);

  // Switch the merge model in the adapter, and regenerate from it.
  fs.writeFileSync(path.join(dir, 'project-adapter.yml'), adapterYaml.replace('approval_class: human-approval-required', 'approval_class: autonomous-merge'));
  assert.match(init('--from-adapter').stdout, /already exists/);
  init('--from-adapter', '--force');
  const switched = loadYaml(fs.readFileSync(path.join(dir, '.github/workflows/self-improve.yml'), 'utf8'));
  assert.ok(switched.jobs['self-improve'].steps.some((s) => s.id === 'promote'));
  assert.ok(!switched.jobs['self-improve'].steps.some((s) => s.id === 'pr'));

  assert.equal(fs.readFileSync(path.join(dir, '.claude/agents/improve.md'), 'utf8'), 'MY REAL BRIEF');
  assert.match(fs.readFileSync(path.join(dir, 'project-adapter.yml'), 'utf8'), /approval_class: autonomous-merge/);
});
