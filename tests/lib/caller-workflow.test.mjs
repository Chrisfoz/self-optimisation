import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load as loadYaml } from '../../harness/vendor/js-yaml.mjs';
import '../../harness/providers/index.mjs';
import { getProvider, resolveProvider } from '../../harness/lib/llm-provider.mjs';
import {
  renderCallerWorkflow, renderAdapterYaml, renderReadme, buildAdapterObject, answersFromAdapter,
  SHARED_WORKFLOW_PATH, SHARED_HARNESS_REPOSITORY,
} from '../../harness/lib/scaffold.mjs';

// A shared installation's own workflow: the schedule, the Run button and the
// concurrency group, calling the shared workflow at one pinned commit.

const SHA = '0123456789abcdef0123456789abcdef01234567';

function answers(overrides = {}) {
  return {
    projectId: 'p', defaultBranch: 'main', allowedPaths: ['src/a.js'], testCommands: ['npm test'],
    providers: [{ name: 'openai', envKey: 'OPENAI_API_KEY' }], roleProviders: [],
    cadenceCron: '0 0 1 * *', runner: 'ubuntu-latest',
    agentBriefPath: '.claude/agents/improve.md', reviewerBriefPath: '.claude/agents/review.md',
    sharedHarness: { ref: SHA, label: 'v0.1.0' },
    ...overrides,
  };
}

test('renderCallerWorkflow: calls the shared workflow at the pinned SHA, with the version as a comment', () => {
  const text = renderCallerWorkflow(answers());
  const doc = loadYaml(text);
  const job = doc.jobs['self-improve'];
  assert.equal(job.uses, `${SHARED_HARNESS_REPOSITORY}/${SHARED_WORKFLOW_PATH}@${SHA}`);
  assert.match(text, new RegExp(`@${SHA} # v0\\.1\\.0\\n`));
  assert.equal(job['secrets'], 'inherit');
  // check_keys is compared to 'true' here rather than passed through raw:
  // the shared workflow declares it as a boolean input, and a dispatch
  // input arrives as the STRING 'true'.
  assert.deepEqual(job.with, {
    scope: '${{ github.event.inputs.scope }}',
    models: '${{ github.event.inputs.models }}',
    check_keys: "${{ github.event.inputs.check_keys == 'true' }}",
  });
  assert.equal(job.steps, undefined, 'no steps of its own');
});

test('renderCallerWorkflow: holds the schedule, the Run button and the concurrency group', () => {
  const doc = loadYaml(renderCallerWorkflow(answers()));
  assert.deepEqual(doc.on.schedule, [{ cron: '0 0 1 * *' }]);
  assert.deepEqual(Object.keys(doc.on.workflow_dispatch.inputs), ['scope', 'models', 'check_keys']);
  assert.equal(doc.concurrency.group, 'self-improvement-${{ github.repository }}');
  assert.equal(doc.concurrency['cancel-in-progress'], false);
  const unscheduled = loadYaml(renderCallerWorkflow(answers({ includeSchedule: false })));
  assert.ok(!('schedule' in unscheduled.on));
});

test('renderCallerWorkflow: grants both write permissions on either merge model, since a called workflow may not hold more', () => {
  for (const approvalClass of ['human-approval-required', 'autonomous-merge']) {
    assert.deepEqual(loadYaml(renderCallerWorkflow(answers({ approvalClass }))).permissions, { contents: 'write', 'pull-requests': 'write' });
  }
});

test('renderCallerWorkflow: passes a runner only when it is not the default', () => {
  assert.ok(!('runner' in loadYaml(renderCallerWorkflow(answers())).jobs['self-improve'].with));
  assert.equal(loadYaml(renderCallerWorkflow(answers({ runner: 'macos-latest' }))).jobs['self-improve'].with.runner, 'macos-latest');
});

test('renderCallerWorkflow: refuses anything but a full SHA, and unsafe names', () => {
  for (const ref of ['main', 'v0.1.0', '0123456', SHA.toUpperCase(), `${SHA}\n`]) {
    assert.throws(() => renderCallerWorkflow(answers({ sharedHarness: { ref } })), /full 40-character commit SHA/, ref);
  }
  assert.throws(() => renderCallerWorkflow(answers({ sharedHarness: undefined })), /full 40-character commit SHA/);
  assert.throws(() => renderCallerWorkflow(answers({ sharedHarness: { ref: SHA, repository: 'evil repo' } })), /owner\/repository/);
  assert.throws(() => renderCallerWorkflow(answers({ sharedHarness: { ref: SHA, label: 'v1\nsteps:' } })), /version label/);
  assert.throws(() => renderCallerWorkflow(answers({ runner: 'ubuntu-latest\n    steps: []' })), /runner name/);
});

test('renderCallerWorkflow: a fork can pin its own repository', () => {
  const doc = loadYaml(renderCallerWorkflow(answers({ sharedHarness: { ref: SHA, repository: 'someone/fork' } })));
  assert.equal(doc.jobs['self-improve'].uses, `someone/fork/${SHARED_WORKFLOW_PATH}@${SHA}`);
});

test('the adapter records the pin and the setup commands, and --from-adapter reads them back unchanged', () => {
  const deps = {
    providerEnvKey: (name) => getProvider(name)?.envKey,
    modelProvider: (model) => { try { return resolveProvider(model); } catch { return null; } },
  };
  const original = answers({ setupCommands: ['npm ci --ignore-scripts'] });
  const adapter = loadYaml(renderAdapterYaml(original));
  assert.deepEqual(adapter.harness.shared, { repository: SHARED_HARNESS_REPOSITORY, ref: SHA, label: 'v0.1.0' });
  assert.deepEqual(adapter.evaluation.setup_commands, ['npm ci --ignore-scripts']);
  const regenerated = answersFromAdapter(adapter, deps);
  assert.equal(renderCallerWorkflow(regenerated), renderCallerWorkflow({ ...original, sharedHarness: { ...original.sharedHarness, repository: SHARED_HARNESS_REPOSITORY } }));
  assert.deepEqual(buildAdapterObject(regenerated).harness, buildAdapterObject(original).harness);
});

test('renderReadme: a shared installation is told nothing is copied, and that adapter changes take effect next run', () => {
  const readme = renderReadme(answers());
  assert.match(readme, new RegExp(`harness commit \`${SHA}\` \\(v0\\.1\\.0\\)`));
  assert.match(readme, /No copy of `harness\/` lives in this repository/);
  assert.match(readme, /the change takes effect on the next one/);
  assert.doesNotMatch(readme, /init\.mjs --from-adapter --force/);
  assert.match(readme, /\/path\/to\/self-optimisation\/harness\/scripts\/revert-generation\.mjs/);
  // A copied-in installation's README is unchanged.
  const copied = renderReadme(answers({ sharedHarness: undefined }));
  assert.match(copied, /init\.mjs --from-adapter --force/);
  assert.match(copied, /\nnode harness\/scripts\/revert-generation\.mjs NNN/);
});
