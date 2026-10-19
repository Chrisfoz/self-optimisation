import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSpec, mergeAdapter, scoreTrial, wilson, summarise, compare, renderReport, withOracleDir } from '../../harness/lib/bench.mjs';

const task = { id: 't1', repo: '.', baseCommit: 'abcdef1', suggestModels: [{ id: 'm' }], oracleCommands: ['true'] };
const spec = (over = {}) => ({ tasks: [task], variants: [{ id: 'base' }, { id: 'cand', adapter: { context: { strategy: 'scoped' } } }], ...over });

test('validateSpec accepts a fair comparison and normalises trials', () => {
  const s = validateSpec(spec());
  assert.equal(s.trials, 1);
  assert.equal(s.variants.length, 2);
});

test('validateSpec refuses anything that would make the comparison unfair or unmeasured', () => {
  const bad = [
    [spec({ variants: [{ id: 'only' }] }), /at least two/],
    [spec({ tasks: [{ ...task, baseCommit: 'main' }] }), /commit sha/],
    [spec({ tasks: [{ ...task, oracleCommands: [] }] }), /held-out check/],
    [spec({ variants: [{ id: 'a' }, { id: 'b', adapter: { constitution: { allowed_paths: ['**'] } } }] }), /may not change constitution/],
    [spec({ variants: [{ id: 'a' }, { id: 'b', adapter: { evaluation: { test_in_loop: false } } }] }), /may not change evaluation/],
    [spec({ variants: [{ id: 'a' }, { id: 'b', adapter: { roles: { review: { model: 'x' } } } }] }), /review seat is fixed/],
    [spec({ variants: [{ id: 'a' }, { id: 'b', adapter: { budget: { max_generation_tokens: 9 } } }] }), /budget is fixed/],
    [spec({ variants: [{ id: 'a' }, { id: 'b', env: { REVIEW_MODEL: 'x' } }] }), /not overridable/],
    [spec({ variants: [{ id: 'a' }, { id: 'a' }] }), /used twice/],
  ];
  for (const [s, re] of bad) assert.throws(() => validateSpec(s), re);
});

test('mergeAdapter deep-merges objects and replaces arrays', () => {
  const merged = mergeAdapter({ context: { strategy: 'full-dump', test_files: ['a'] }, roles: { implement: { model: 'x' } } }, { context: { strategy: 'scoped', test_files: ['b'] } });
  assert.deepEqual(merged, { context: { strategy: 'scoped', test_files: ['b'] }, roles: { implement: { model: 'x' } } });
});

test('scoreTrial: approved and oracle-passed is a verified success; approved and oracle-failed is a missed regression', () => {
  const record = { outcome: 'approved', attempts: [{}, {}], spend: { totalTokens: 100, inputTokens: 90, outputTokens: 10 }, contextSize: { estimatedTokens: 80 } };
  const ok = scoreTrial({ task, variant: { id: 'v' }, trial: 1, record, oracle: [{ command: 'x', passed: true }] });
  assert.equal(ok.verifiedSuccess, true);
  assert.equal(ok.missedRegression, false);
  assert.equal(ok.attempts, 2);
  const missed = scoreTrial({ task, variant: { id: 'v' }, trial: 1, record, oracle: [{ command: 'x', passed: false }] });
  assert.equal(missed.missedRegression, true);
  const abandoned = scoreTrial({ task, variant: { id: 'v' }, trial: 1, record: { outcome: 'abandoned' }, oracle: [{ command: 'x', passed: false }] });
  assert.equal(abandoned.missedRegression, false);
  assert.equal(scoreTrial({ task, variant: { id: 'v' }, trial: 1, error: 'clone failed' }).outcome, 'bench-error');
});

test('wilson gives a sane interval, and nothing for n=0', () => {
  assert.deepEqual(wilson(0, 0), { rate: null, low: null, high: null });
  const w = wilson(5, 10);
  assert.equal(w.rate, 0.5);
  assert.ok(w.low > 0.2 && w.low < 0.3 && w.high > 0.7 && w.high < 0.8);
  assert.equal(wilson(3, 3).high, 1);
});

const row = (variant, { verified = false, approved = verified, tokens = 100, error = null } = {}) =>
  ({ variant, outcome: error ? 'bench-error' : approved ? 'approved' : 'abandoned', approved, verifiedSuccess: verified, missedRegression: approved && !verified, totalTokens: tokens, attempts: 1, oraclePassed: verified, task: 't', trial: 1, error });

test('summarise excludes bench errors from the score and counts them separately', () => {
  const [s] = summarise([row('a', { verified: true }), row('a', { error: 'x' }), row('a', { approved: true, verified: false })]);
  assert.equal(s.trials, 2);
  assert.equal(s.benchErrors, 1);
  assert.equal(s.verifiedCount, 1);
  assert.equal(s.missedRegressions, 1);
  assert.equal(s.tokensPerVerifiedSuccess, 200);
});

test('compare: cheaper with no observed loss is provisional; overlap is never "better"; a new missed regression rejects', () => {
  const sum = (rows) => summarise(rows)[0];
  const base = sum([row('b', { verified: true, tokens: 1000 }), row('b', { verified: true, tokens: 1000 })]);
  const cheaper = sum([row('c', { verified: true, tokens: 400 }), row('c', { verified: true, tokens: 400 })]);
  assert.equal(compare(base, cheaper).decision, 'adopt-provisionally');
  assert.match(compare(base, cheaper).reasons.join(' '), /-60\.0%/);
  const pricier = sum([row('c', { verified: true, tokens: 2000 }), row('c', { verified: true, tokens: 2000 })]);
  assert.equal(compare(base, pricier).decision, 'not-shown');
  const leaky = sum([row('c', { verified: true, tokens: 100 }), row('c', { approved: true, verified: false, tokens: 100 })]);
  assert.equal(compare(base, leaky).decision, 'reject');
  const bigBase = sum(Array.from({ length: 30 }, () => row('b', { verified: false })));
  const bigCand = sum(Array.from({ length: 30 }, () => row('c', { verified: true })));
  assert.equal(compare(bigBase, bigCand).decision, 'adopt');
});

test('renderReport names every variant and every trial', () => {
  const s = validateSpec(spec());
  const results = [row('base', { verified: true }), row('cand', { verified: true, tokens: 50 })];
  const summary = summarise(results);
  const comparisons = [{ variant: 'cand', ...compare(summary[0], summary[1]) }];
  const md = renderReport({ spec: s, results, summary, comparisons, startedAt: '2026-10-17' });
  assert.match(md, /\| base \| 1 \|/);
  assert.match(md, /\*\*cand: adopt-provisionally\*\*/);
  assert.equal((md.match(/^\| t \|/gm) || []).length, 2);
});

test('withOracleDir fills in both spellings itself, so no shell has to expand them', () => {
  const dir = 'C:\\specs\\bench';
  assert.equal(withOracleDir('node "$BENCH_ORACLE_DIR/oracle.mjs"', dir), `node "${dir}/oracle.mjs"`);
  assert.equal(withOracleDir('node --test ${BENCH_ORACLE_DIR}/a.mjs $BENCH_ORACLE_DIR/b.mjs', '/s'), 'node --test /s/a.mjs /s/b.mjs');
  // Only the bench's own variable; a longer name that starts the same is left alone.
  assert.equal(withOracleDir('echo $BENCH_ORACLE_DIRS $HOME', '/s'), 'echo $BENCH_ORACLE_DIRS $HOME');
  // A $ in the directory is inserted literally, not read as a replacement pattern.
  assert.equal(withOracleDir('x $BENCH_ORACLE_DIR', '/a$&b'), 'x /a$&b');
});
