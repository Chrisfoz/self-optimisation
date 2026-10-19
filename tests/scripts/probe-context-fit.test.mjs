import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'harness/scripts/probe-models.mjs');

// The fit check used to run only when CONTEXT_ESTIMATE_TOKENS was set, and
// nothing set it. With an adapter present the probe now measures the prompt
// itself, so a model whose reported window cannot hold it is dropped before
// a single request — here, before the prober would need a key at all.
test('probe-models measures the prompt from the adapter and drops a model whose window is too small', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-fit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'big.js'), 'x'.repeat(400_000));
  fs.writeFileSync(path.join(root, 'brief.md'), 'Improve it.');
  fs.writeFileSync(path.join(root, 'project-adapter.yml'), 'constitution:\n  allowed_paths: [big.js]\nroles:\n  agent_brief_path: brief.md\n');
  const release = path.join(root, 'release-check.json');
  fs.writeFileSync(release, JSON.stringify({ selectedModels: [{ id: 'gemini-small', provider: 'google', contextWindow: 32_000 }] }));

  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/API_KEY|CONTEXT_ESTIMATE/.test(k)));
  const run = spawnSync(process.execPath, [SCRIPT, release], { cwd: root, encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /estimated at ~100,\d{3} tokens/);
  const out = JSON.parse(fs.readFileSync(release, 'utf8'));
  assert.equal(out.selectedModels.length, 0);
  assert.match(out.probeDropped[0].reason, /context window ~32k tokens is smaller/);
});
