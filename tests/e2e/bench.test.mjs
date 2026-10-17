import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startMockLabs } from '../helpers/mock-labs.mjs';
import { createScratchProject } from '../helpers/scratch-project.mjs';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'harness/scripts/bench.mjs');

const run = (args, opts) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, opts);
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.on('close', (status) => resolve({ status, stderr }));
});

// Two variants of one task, one trial each, through the real
// run-generation.mjs against the loopback labs. The oracle is a file beside
// the spec — outside every clone — and must never reach a model.
test('bench: two variants on a pinned commit, scored by a held-out oracle no model saw', async (t) => {
  const labs = await startMockLabs();
  t.after(() => labs.close());
  const { dir, git } = createScratchProject({ watched: ['anthropic', 'openai'] });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const baseCommit = git('rev-parse', 'HEAD');

  const benchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-spec-'));
  t.after(() => fs.rmSync(benchDir, { recursive: true, force: true }));
  const SECRET = 'ORACLE-ONLY-7f3c';
  fs.writeFileSync(path.join(benchDir, 'oracle.mjs'), `// ${SECRET}\nimport fs from 'node:fs';\nconst html = fs.readFileSync('index.html', 'utf8');\nif (!/<p data-generation="[^"]+">Improved by/.test(html)) { console.error('no attributed line'); process.exit(1); }\n`);
  fs.writeFileSync(path.join(benchDir, 'bench.json'), JSON.stringify({
    trials: 1,
    tasks: [{
      id: 'scratch',
      repo: dir,
      baseCommit,
      suggestModels: [{ id: 'claude-fable-5-1', provider: 'anthropic' }],
      oracleCommands: ['node "$BENCH_ORACLE_DIR/oracle.mjs"'],
    }],
    variants: [
      { id: 'history-3', adapter: { context: { history_limit: 3 } } },
      { id: 'history-1', adapter: { context: { history_limit: 1 } } },
    ],
  }));
  const out = path.join(benchDir, 'out');

  const result = await run([SCRIPT, path.join(benchDir, 'bench.json'), '--out', out], { cwd: REPO_ROOT, env: { ...process.env, ...labs.env() } });
  assert.equal(result.status, 0, result.stderr);

  const { results, summary, comparisons } = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
  assert.equal(results.length, 2);
  for (const r of results) {
    assert.equal(r.outcome, 'approved', r.error ?? '');
    assert.equal(r.oraclePassed, true);
    assert.ok(r.totalTokens > 0);
  }
  assert.equal(summary.length, 2);
  assert.equal(comparisons[0].variant, 'history-1');
  assert.match(fs.readFileSync(path.join(out, 'REPORT.md'), 'utf8'), /Replay bench/);

  // Held out means held out.
  assert.ok(labs.requests.length > 0);
  assert.ok(!labs.requests.some((r) => `${r.system}\n${r.user}`.includes(SECRET)));
  // And the task's own repository was never written to.
  assert.equal(git('rev-parse', 'HEAD'), baseCommit);
  assert.equal(git('status', '--porcelain'), '');
});
