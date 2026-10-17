import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../harness/providers/index.mjs';
import { loadAdapter, constitutionAllowlist } from '../harness/lib/adapter.mjs';
import { compileAllowlist, isEditable } from '../harness/lib/edit-format.mjs';
import { buildSourceBundle, buildArchitectureNotes } from '../harness/lib/context-pack.mjs';
import { validateAdapter } from '../harness/lib/validate.mjs';
import { createRequire } from 'node:module';

const requireFromHarness = createRequire(new URL('../harness/lib/adapter.mjs', import.meta.url));
const { load } = await import(requireFromHarness.resolve('js-yaml'));

const adapter = await loadAdapter();

test('adapter validates and only candidate C is editable', () => {
  assert.deepEqual(validateAdapter(adapter).errors, []);
  const allowlist = compileAllowlist(constitutionAllowlist(adapter));
  assert.equal(isEditable('candidate/score.c', allowlist), true);
  for (const p of ['reference/score.c', 'oracle/driver.c', 'lab.py',
    'tests/test_lab.py', 'project-adapter.yml', '.github/workflows/self-improve.yml']) {
    assert.equal(isEditable(p, allowlist), false, p);
  }
});

test('candidate context includes assembly and excludes ground-truth C', () => {
  const sources = buildSourceBundle(adapter.constitution.allowed_paths);
  const evidence = buildArchitectureNotes({ docPath: adapter.context.architecture_notes.path });
  assert.ok(sources.includes('candidate/score.c'));
  assert.ok(evidence.includes('```asm'));
  assert.ok(evidence.includes('score_tick'));
  assert.equal((sources + evidence).includes('score /= 2'), false);
  assert.equal(sources.includes('reference/score.c'), false);
});

test('installed workflow is manual and stops at a pull request', () => {
  const workflow = load(fs.readFileSync('.github/workflows/self-improve.yml', 'utf8'));
  assert.ok(workflow.on.workflow_dispatch);
  assert.equal(workflow.on.schedule, undefined);
  assert.equal(adapter.constitution.approval_class, 'human-approval-required');
  assert.equal(adapter.roles.refine.max_attempts, 2);
  assert.equal(adapter.providers.max_fanout, 1);
  assert.equal(adapter.budget.max_generation_tokens, 80000);
});
