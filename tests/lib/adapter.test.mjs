import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadAdapter, watchedProviders, snapshotPath, maxFanout, constitutionAllowlist, guardConfig, memoryConfig, briefPaths, rolesConfig, contextConfig, deploymentConfig, notifyConfig, approvalClass, normalizeApprovalClass, DEFAULT_APPROVAL_CLASS } from '../../harness/lib/adapter.mjs';

async function withTempFile(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-test-'));
  const file = path.join(dir, 'project-adapter.yml');
  fs.writeFileSync(file, content);
  try {
    return await fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('loadAdapter returns null for a missing file rather than throwing', async () => {
  assert.equal(await loadAdapter('/definitely/does/not/exist/project-adapter.yml'), null);
});

test('loadAdapter never imports js-yaml when the file does not exist', async () => {
  // If loadAdapter's dynamic import were unconditional, this would still
  // pass — the real point of this test is documented in adapter.mjs's own
  // doc comment: a project with no project-adapter.yml must never need
  // js-yaml installed. There's no direct way to assert "a module was not
  // imported" from outside, so this test stands as the executable version
  // of that promise: it runs the missing-file path and expects success
  // without js-yaml necessarily being resolvable, which node_modules being
  // present in this repo can't disprove — the real guarantee is in the
  // existence check preceding the dynamic import in loadAdapter() itself.
  assert.equal(await loadAdapter(path.join(os.tmpdir(), 'no-such-adapter.yml')), null);
});

test('loadAdapter throws on a file that exists but is not valid YAML', async () => {
  await withTempFile('providers:\n  watched: [anthropic\n', async (file) => {
    await assert.rejects(() => loadAdapter(file), /could not be parsed as YAML/);
  });
});

test('loadAdapter throws on a file that parses to a non-object (e.g. a bare scalar)', async () => {
  await withTempFile('just a string, not a mapping', async (file) => {
    await assert.rejects(() => loadAdapter(file), /did not parse to an object/);
  });
});

test('loadAdapter parses a real, minimal adapter file', async () => {
  await withTempFile(
    `
project:
  id: test-project

providers:
  watched:
    - anthropic
    - openai
  snapshot_path: .agent/model-snapshot.json
  max_fanout: 4

constitution:
  allowed_paths:
    - src/index.js
  create_only_paths:
    - "tests/**/*.test.js"
`,
    async (file) => {
      const adapter = await loadAdapter(file);
      assert.equal(adapter.project.id, 'test-project');
      assert.deepEqual(watchedProviders(adapter), ['anthropic', 'openai']);
      assert.equal(snapshotPath(adapter), '.agent/model-snapshot.json');
      assert.equal(maxFanout(adapter), 4);
      assert.deepEqual(constitutionAllowlist(adapter), {
        allowedPaths: ['src/index.js'],
        createOnlyPaths: ['tests/**/*.test.js'],
      });
    }
  );
});

test('watchedProviders accepts both bare-string and {lab, env_var} object entries', async () => {
  await withTempFile(
    `
providers:
  watched:
    - anthropic
    - {lab: openai, env_var: OPENAI_API_KEY}
`,
    async (file) => {
      assert.deepEqual(watchedProviders(await loadAdapter(file)), ['anthropic', 'openai']);
    }
  );
});

test('guardConfig reads frozen/append-only/frozen-fields/churn-ceiling', async () => {
  await withTempFile(
    `
constitution:
  frozen_paths:
    - ".github/**"
    - "netlify.toml"
  append_only_paths:
    - "tests/**"
  frozen_fields:
    package.json:
      - scripts
  churn_ceiling:
    max_files: 25
    max_lines: 5000
`,
    async (file) => {
      const config = guardConfig(await loadAdapter(file));
      assert.deepEqual(config.frozenPaths, ['.github/**', 'netlify.toml']);
      assert.deepEqual(config.appendOnlyPaths, ['tests/**']);
      assert.deepEqual(config.frozenFields, { 'package.json': ['scripts'] });
      assert.equal(config.maxFiles, 25);
      assert.equal(config.maxLines, 5000);
    }
  );
});

test('guardConfig returns empty/null defaults when the adapter has no constitution section', () => {
  const config = guardConfig(null);
  assert.deepEqual(config.frozenPaths, []);
  assert.deepEqual(config.appendOnlyPaths, []);
  assert.deepEqual(config.frozenFields, {});
  assert.equal(config.maxFiles, null);
  assert.equal(config.maxLines, null);
});

test('memoryConfig reads escalation ledger/consensus and themes review config', async () => {
  await withTempFile(
    `
memory:
  escalation_ledger: docs/escalations/ledger.json
  escalation_consensus:
    models: 3
    labs: 2
  themes_review:
    dir: docs/themes
    cadence_generations: 10
`,
    async (file) => {
      const config = memoryConfig(await loadAdapter(file));
      assert.equal(config.ledgerPath, 'docs/escalations/ledger.json');
      assert.deepEqual(config.consensus, { models: 3, labs: 2 });
      assert.equal(config.themesDir, 'docs/themes');
      assert.equal(config.themesCadence, 10);
    }
  );
});

test('memoryConfig returns null defaults when the adapter has no memory section', () => {
  const config = memoryConfig(null);
  assert.equal(config.ledgerPath, null);
  assert.deepEqual(config.consensus, { models: null, labs: null });
  assert.equal(config.themesDir, null);
  assert.equal(config.themesCadence, null);
});

test('briefPaths, rolesConfig and contextConfig read a fully populated adapter', async () => {
  await withTempFile(
    `
roles:
  agent_brief_path: .claude/agents/improve.md
  reviewer_brief_path: .claude/agents/review.md
  suggest:
    max_output_tokens: 32000
  implement:
    model: claude-opus-5
  review:
    model: claude-opus-5
  rank:
    model: claude-opus-5
  refine:
    max_attempts: 3

context:
  generations_dir: docs/generations
  architecture_notes:
    path: ARCHITECTURE.md
    append_only_marker: "*This log is append-only.*"
  test_files:
    - tests/a.test.mjs
  purposes:
    index.html: the landing page
  platform_notes: "Runs in any modern browser."
  history_limit: 3
  scope_required: 2
`,
    async (file) => {
      const adapter = await loadAdapter(file);

      assert.deepEqual(briefPaths(adapter), {
        agentBriefPath: '.claude/agents/improve.md',
        reviewerBriefPath: '.claude/agents/review.md',
      });

      assert.deepEqual(rolesConfig(adapter), {
        suggestMaxTokens: 32000,
        implementModel: 'claude-opus-5',
        reviewModel: 'claude-opus-5',
        rankModel: 'claude-opus-5',
        maxAttempts: 3,
      });

      const ctx = contextConfig(adapter);
      assert.equal(ctx.generationsDir, 'docs/generations');
      assert.equal(ctx.architectureNotesPath, 'ARCHITECTURE.md');
      assert.equal(ctx.architectureNotesMarker, '*This log is append-only.*');
      assert.deepEqual(ctx.testFiles, ['tests/a.test.mjs']);
      assert.deepEqual(ctx.purposes, { 'index.html': 'the landing page' });
      assert.equal(ctx.platformNotes, 'Runs in any modern browser.');
      assert.equal(ctx.historyLimit, 3);
      assert.equal(ctx.scopeRequired, 2);
    }
  );
});

test('briefPaths, rolesConfig and contextConfig return null/empty defaults on a bare adapter', () => {
  assert.deepEqual(briefPaths(null), { agentBriefPath: null, reviewerBriefPath: null });
  assert.deepEqual(rolesConfig(null), { suggestMaxTokens: null, implementModel: null, reviewModel: null, rankModel: null, maxAttempts: null });
  assert.deepEqual(contextConfig(null), {
    generationsDir: null, architectureNotesPath: null, architectureNotesMarker: null,
    testFiles: [], purposes: {}, platformNotes: null, historyLimit: null, scopeRequired: null,
  });
});

test('deploymentConfig reads verify_strategy, production_url, watched_files and the CI runner', async () => {
  await withTempFile(
    `
deployment:
  verify_strategy: url
  production_url: https://example.com
  watched_files:
    - index.html
  ci:
    runner: windows-latest
`,
    async (file) => {
      const config = deploymentConfig(await loadAdapter(file));
      assert.equal(config.strategy, 'url');
      assert.equal(config.siteUrl, 'https://example.com');
      assert.deepEqual(config.watchedFiles, ['index.html']);
      assert.equal(config.runner, 'windows-latest');
    }
  );
});

test('deploymentConfig defaults strategy to "none" (not null) and runner to ubuntu-latest', () => {
  const config = deploymentConfig(null);
  assert.equal(config.strategy, 'none');
  assert.equal(config.siteUrl, null);
  assert.equal(config.watchedFiles, null);
  assert.equal(config.runner, 'ubuntu-latest');
  assert.deepEqual(config.registry, { ecosystem: null, package: null, groupId: null, artifactId: null, version: null, versionFile: null, registryUrl: null });
  assert.deepEqual(config.artifact, { buildCommand: null, path: null, smokeCommand: null });
});

test('deploymentConfig reads a registry strategy section', async () => {
  await withTempFile(
    `
deployment:
  verify_strategy: registry
  registry:
    ecosystem: npm
    package: my-cli
    version: 2.3.0
    version_file: package.json
    registry_url: https://registry.npmjs.org
`,
    async (file) => {
      const config = deploymentConfig(await loadAdapter(file));
      assert.equal(config.strategy, 'registry');
      assert.equal(config.registry.ecosystem, 'npm');
      assert.equal(config.registry.package, 'my-cli');
      assert.equal(config.registry.version, '2.3.0');
      assert.equal(config.registry.versionFile, 'package.json');
      assert.equal(config.registry.registryUrl, 'https://registry.npmjs.org');
    }
  );
});

test('deploymentConfig reads an artifact strategy section', async () => {
  await withTempFile(
    `
deployment:
  verify_strategy: artifact
  artifact:
    build_command: npm run build
    path: dist/cli.js
    smoke_command: node dist/cli.js --version
`,
    async (file) => {
      const config = deploymentConfig(await loadAdapter(file));
      assert.equal(config.strategy, 'artifact');
      assert.equal(config.artifact.buildCommand, 'npm run build');
      assert.equal(config.artifact.path, 'dist/cli.js');
      assert.equal(config.artifact.smokeCommand, 'node dist/cli.js --version');
    }
  );
});

test('notifyConfig reads a fully populated notify section', async () => {
  await withTempFile(
    `
notify:
  channel: email
  provider: sendgrid
  recipient: you@example.com
  recipient_name: Alex
  from:
    email: bot@example.com
    name: Bot
  digest_model: claude-opus-5
  escalation_notice: false
  calibration_examples:
    - docs/calibration/example-1.md
`,
    async (file) => {
      const config = notifyConfig(await loadAdapter(file));
      assert.equal(config.channel, 'email');
      assert.equal(config.provider, 'sendgrid');
      assert.equal(config.recipient, 'you@example.com');
      assert.equal(config.recipientName, 'Alex');
      assert.deepEqual(config.from, { email: 'bot@example.com', name: 'Bot' });
      assert.equal(config.digestModel, 'claude-opus-5');
      assert.equal(config.escalationNotice, false);
      assert.deepEqual(config.calibrationExamplesPaths, ['docs/calibration/example-1.md']);
    }
  );
});

test('notifyConfig: escalationNotice defaults to true (the safer default), calibrationExamplesPaths to [], when unset', () => {
  assert.equal(notifyConfig(null).escalationNotice, true);
  assert.equal(notifyConfig(null).channel, null);
  assert.deepEqual(notifyConfig(null).calibrationExamplesPaths, []);
});

// --- approval_class -----------------------------------------------------------
// The one field where "unrecognised" must not mean "carry on": every value
// that isn't literally `autonomous-merge` resolves to the human path, so a
// typo, an older adapter, or a value written by some future console can
// never be the reason a project starts merging its own changes unattended.

test('approvalClass reads constitution.approval_class, where a real installation puts it', async () => {
  await withTempFile('constitution:\n  approval_class: autonomous-merge\n', async (file) => {
    assert.equal(approvalClass(await loadAdapter(file)), 'autonomous-merge');
  });
});

test('approvalClass accepts a top-level approval_class too, as the example file documented it while RESERVED', async () => {
  await withTempFile('approval_class: autonomous-merge\n', async (file) => {
    assert.equal(approvalClass(await loadAdapter(file)), 'autonomous-merge');
  });
});

test('approvalClass prefers constitution.approval_class over a top-level one, when both are set', async () => {
  await withTempFile('approval_class: autonomous-merge\nconstitution:\n  approval_class: human-approval-required\n', async (file) => {
    assert.equal(approvalClass(await loadAdapter(file)), 'human-approval-required');
  });
});

test('approvalClass fails closed to the human path on an unset, misspelled, or non-string value', () => {
  assert.equal(DEFAULT_APPROVAL_CLASS, 'human-approval-required');
  assert.equal(approvalClass(null), 'human-approval-required');
  assert.equal(approvalClass({}), 'human-approval-required');
  assert.equal(approvalClass({ constitution: {} }), 'human-approval-required');
  assert.equal(approvalClass({ constitution: { approval_class: 'autonomous_merge' } }), 'human-approval-required');
  assert.equal(approvalClass({ constitution: { approval_class: 'auto' } }), 'human-approval-required');
  assert.equal(approvalClass({ constitution: { approval_class: true } }), 'human-approval-required');
  assert.equal(approvalClass({ constitution: { approval_class: ['autonomous-merge'] } }), 'human-approval-required');
});

test('normalizeApprovalClass tolerates surrounding whitespace but not a different value', () => {
  assert.equal(normalizeApprovalClass('  autonomous-merge  '), 'autonomous-merge');
  assert.equal(normalizeApprovalClass('  human-approval-required'), 'human-approval-required');
  assert.equal(normalizeApprovalClass('autonomous merge'), 'human-approval-required');
  assert.equal(normalizeApprovalClass(undefined), 'human-approval-required');
});

test('accessors return null/empty defaults on a null adapter, never throw', () => {
  assert.equal(watchedProviders(null), null);
  assert.equal(snapshotPath(null), null);
  assert.equal(maxFanout(null), null);
  assert.deepEqual(constitutionAllowlist(null), { allowedPaths: [], createOnlyPaths: [] });
});

test('accessors return null/empty defaults on an adapter missing that section', async () => {
  await withTempFile('project:\n  id: bare-project\n', async (file) => {
    const adapter = await loadAdapter(file);
    assert.equal(watchedProviders(adapter), null);
    assert.equal(snapshotPath(adapter), null);
    assert.equal(maxFanout(adapter), null);
    assert.deepEqual(constitutionAllowlist(adapter), { allowedPaths: [], createOnlyPaths: [] });
  });
});
