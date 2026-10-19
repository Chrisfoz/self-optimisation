import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { load as loadYaml } from '../../harness/vendor/js-yaml.mjs';
import '../../harness/providers/index.mjs';
import { registeredProviders, getProvider } from '../../harness/lib/llm-provider.mjs';
import { renderDetectorWorkflow } from '../../harness/lib/scaffold.mjs';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const lab = (name) => ({ name, envKey: getProvider(name).envKey });

test('renderDetectorWorkflow: the secrets and the --providers list come from one answer, so they agree', () => {
  const out = renderDetectorWorkflow({ providers: [lab('anthropic'), lab('deepseek')] });
  const step = loadYaml(out).jobs['check-releases'].steps.find((s) => s.id === 'check');
  assert.deepEqual(Object.keys(step.env), ['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY']);
  assert.match(step.run, /--providers anthropic,deepseek \\/);
  assert.doesNotMatch(out, /OPENAI_API_KEY/);
});

test('renderDetectorWorkflow: actions pinned by SHA, and lab-supplied names reach the script only through env', () => {
  const out = renderDetectorWorkflow({ providers: [lab('openai')], cadenceCron: '0 6 * * 1' });
  assert.match(out, /uses: actions\/checkout@[0-9a-f]{40} # v4/);
  assert.doesNotMatch(out, /uses: actions\/[a-z-]+@v\d/);
  assert.match(out, /cron: '0 6 \* \* 1'/);
  const issue = loadYaml(out).jobs['check-releases'].steps.find((s) => /Open an issue/.test(s.name));
  assert.doesNotMatch(issue.run, /\$\{\{/, 'a model name from an API is untrusted text');
});

test('renderDetectorWorkflow: refuses to render with no lab to watch', () => {
  assert.throws(() => renderDetectorWorkflow({ providers: [] }), /at least one lab/);
});

test('examples/workflows/watch-releases.yml is the rendered detector for every registered lab', () => {
  const expected = renderDetectorWorkflow({ providers: registeredProviders().map(lab) });
  const actual = fs.readFileSync(path.join(REPO_ROOT, 'examples/workflows/watch-releases.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(actual, expected, 'regenerate the example from renderDetectorWorkflow() rather than editing it by hand');
});

test('init --detector-only writes the detector and nothing that belongs to the full loop', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-only-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(REPO_ROOT, 'harness'), path.join(root, 'harness'), { recursive: true });

  const result = spawnSync(process.execPath, ['harness/cli/init.mjs', '--detector-only', '--yes'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/watch-releases.yml'), 'utf8');
  assert.match(workflow, /--providers anthropic,openai/);
  assert.match(result.stdout, /ANTHROPIC_API_KEY/);
  assert.equal(fs.existsSync(path.join(root, 'project-adapter.yml')), false);
  assert.equal(fs.existsSync(path.join(root, '.github/workflows/self-improve.yml')), false);
});
