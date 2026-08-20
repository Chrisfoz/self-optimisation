import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadAdapter, watchedProviders, snapshotPath, maxFanout, constitutionAllowlist, guardConfig } from '../../harness/lib/adapter.mjs';

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
