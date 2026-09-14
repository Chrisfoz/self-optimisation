import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workflowConfig, githubEnvLines } from '../../harness/lib/workflow-config.mjs';

function adapter(overrides = {}) {
  return {
    project: { id: 'p', default_branch: 'develop' },
    providers: { watched: ['anthropic', 'openai'], snapshot_path: '.agent/model-snapshot.json' },
    constitution: { allowed_paths: ['src/a.js', 'src/b c.js'], create_only_paths: ['tests/**', 'src/a.js'], approval_class: 'human-approval-required' },
    context: { generations_dir: 'history/gens' },
    evaluation: { test_commands: ['npm ci', 'npm test'], setup_commands: ['npm ci --ignore-scripts'] },
    ...overrides,
  };
}

test('workflowConfig: reads every value the shared workflow needs', () => {
  assert.deepEqual(workflowConfig(adapter()), {
    defaultBranch: 'develop',
    providersCsv: 'anthropic,openai',
    snapshotPath: '.agent/model-snapshot.json',
    generationsDir: 'history/gens',
    approvalClass: 'human-approval-required',
    notify: false,
    testCommands: ['npm ci', 'npm test'],
    setupCommands: ['npm ci --ignore-scripts'],
    editablePaths: ['src/a.js', 'src/b c.js', 'tests/**'],
  });
});

test('workflowConfig: fills the documented defaults when fields are absent', () => {
  const config = workflowConfig({ project: { id: 'p' }, evaluation: { test_commands: ['make test'] } });
  assert.equal(config.defaultBranch, 'main');
  assert.equal(config.snapshotPath, '.agent/model-snapshot.json');
  assert.equal(config.generationsDir, 'docs/generations');
  assert.equal(config.providersCsv, '');
  assert.deepEqual(config.setupCommands, []);
  assert.deepEqual(config.editablePaths, []);
});

test('workflowConfig: an unrecognised approval class is the pull-request path, never automatic merge', () => {
  const typo = adapter({ constitution: { allowed_paths: ['a'], approval_class: 'autonomous_merge' } });
  assert.equal(workflowConfig(typo).approvalClass, 'human-approval-required');
  const opted = adapter({ constitution: { allowed_paths: ['a'], approval_class: 'autonomous-merge' } });
  assert.equal(workflowConfig(opted).approvalClass, 'autonomous-merge');
});

test('workflowConfig: notify is on only when the adapter configures it', () => {
  assert.equal(workflowConfig(adapter({ notify: { provider: 'sendgrid' } })).notify, true);
});

test('workflowConfig: refuses anything that could break out of one line of $GITHUB_ENV or one argument', () => {
  const cases = [
    adapter({ project: { id: 'p', default_branch: 'main\nEVIL=1' } }),
    adapter({ project: { id: 'p', default_branch: 'feature/../main' } }),
    adapter({ project: { id: 'p', default_branch: '-main' } }),
    adapter({ providers: { watched: ['openai\nEVIL=1'] } }),
    adapter({ context: { generations_dir: 'docs\rgens' } }),
    adapter({ evaluation: { test_commands: ['npm test\nrm -rf /'] } }),
    adapter({ evaluation: { test_commands: ['npm test'], setup_commands: 'npm ci' } }),
    adapter({ constitution: { allowed_paths: ['src/a.js\n.github/workflows/x.yml'] } }),
  ];
  for (const bad of cases) assert.throws(() => workflowConfig(bad), /single, non-empty line|not a usable branch|not a provider name|must be a list/);
});

test('workflowConfig: no adapter at all is an error the workflow can report', () => {
  assert.throws(() => workflowConfig(null), /No project-adapter\.yml/);
});

test('githubEnvLines: one KEY=value line per value, and a trailing newline', () => {
  const text = githubEnvLines(workflowConfig(adapter({ notify: {} })));
  assert.equal(text, [
    'DEFAULT_BRANCH=develop',
    'PROVIDERS_CSV=anthropic,openai',
    'SNAPSHOT_PATH=.agent/model-snapshot.json',
    'GENERATIONS_DIR=history/gens',
    'APPROVAL_CLASS=human-approval-required',
    'NOTIFY_CONFIGURED=true',
  ].join('\n') + '\n');
});
