import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderSteps, findStep, runStep, fakeTool, shellTestOptions, parseGithubOutput } from '../helpers/gha-shell.mjs';

// Executes the generated workflow's own `run:` blocks under GitHub's bash
// flags (`--noprofile --norc -eo pipefail`). Parsing the YAML proves the
// file is YAML; only running the shell proves a step works. See
// tests/helpers/gha-shell.mjs for why that distinction cost real runs.

const opts = shellTestOptions();

function answers(overrides = {}) {
  return {
    projectId: 'p',
    defaultBranch: 'main',
    allowedPaths: ['src/game.js'],
    testCommands: ['npm test'],
    providers: [
      { name: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
      { name: 'openai', envKey: 'OPENAI_API_KEY' },
    ],
    roleProviders: [{ name: 'google', envKey: 'GOOGLE_API_KEY' }],
    notify: { provider: 'sendgrid', envKey: 'SENDGRID_API_KEY', recipient: 'a@b.c', fromEmail: 'x@y.z' },
    ...overrides,
  };
}

const MODES = ['human-approval-required', 'autonomous-merge'];

// --- the parser the tests below lean on ------------------------------------

test('parseGithubOutput rejects a multi-line value written as key=value, like GitHub does', () => {
  assert.throws(() => parseGithubOutput('json=[\n  {"a":1}\n]\n'), /Invalid format/);
  assert.deepEqual(parseGithubOutput('a=1\nb<<EOF\nx\ny\nEOF\n'), { a: '1', b: 'x\ny' });
});

// --- the gate summary --------------------------------------------------------

for (const mode of MODES) {
  test(`gates (${mode}): the unrendered merge path's empty outcome is skipped, and the step succeeds`, opts, () => {
    const { steps } = renderSteps(answers({ approvalClass: mode }));
    const pr = mode === 'human-approval-required';
    const r = runStep(findStep(steps, 'gates'), {
      env: {
        PREFLIGHT: 'success', IMPROVE: 'success', REVIEW_VERDICT: 'approved', GUARD: 'success', TESTS: 'success',
        PULL_REQUEST: pr ? 'success' : '', PROMOTE: pr ? '' : 'success', VERIFY: pr ? '' : 'success',
      },
    });
    assert.equal(r.status, 0, r.stderr);
    const gates = JSON.parse(r.outputs.json);
    assert.deepEqual(gates.map((g) => g.name), pr
      ? ['preflight', 'review', 'guard', 'tests', 'pull-request']
      : ['preflight', 'review', 'guard', 'tests', 'promote', 'verify']);
    assert.ok(gates.every((g) => g.result === 'success'));
    assert.equal(r.outputs.merged, pr ? 'false' : 'true');
  });

  test(`gates (${mode}): a run that stopped at review still reports, with later gates skipped`, opts, () => {
    const { steps } = renderSteps(answers({ approvalClass: mode }));
    const r = runStep(findStep(steps, 'gates'), {
      env: { PREFLIGHT: 'success', IMPROVE: 'failure', REVIEW_VERDICT: 'rejected', GUARD: 'skipped', TESTS: 'skipped', PULL_REQUEST: '', PROMOTE: '', VERIFY: '' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.outputs.json).map((g) => `${g.name}:${g.result}`),
      ['preflight:success', 'review:failure', 'guard:skipped', 'tests:skipped']);
    assert.equal(r.outputs.merged, 'false');
  });

  test(`gates (${mode}): a loop that crashed before any verdict is reported as the loop, not as a review`, opts, () => {
    // The first real GitHub run crashed on an empty credit balance, and its
    // digest said "❌ review" although nothing had been reviewed.
    const { steps } = renderSteps(answers({ approvalClass: mode }));
    for (const [verdict, expected] of [['', 'improve:failure'], ['no-proposal', 'improve:failure'], ['over-budget', 'improve:failure']]) {
      const r = runStep(findStep(steps, 'gates'), {
        env: { PREFLIGHT: 'success', IMPROVE: 'failure', REVIEW_VERDICT: verdict, GUARD: 'skipped', TESTS: 'skipped', PULL_REQUEST: '', PROMOTE: '', VERIFY: '' },
      });
      assert.equal(r.status, 0, r.stderr);
      const names = JSON.parse(r.outputs.json).map((g) => `${g.name}:${g.result}`);
      assert.deepEqual(names, ['preflight:success', expected, 'guard:skipped', 'tests:skipped'], `verdict "${verdict}"`);
    }
  });

  test(`gates (${mode}): every outcome empty still exits 0 with an empty list`, opts, () => {
    const { steps } = renderSteps(answers({ approvalClass: mode }));
    const r = runStep(findStep(steps, 'gates'), { env: { PREFLIGHT: '', IMPROVE: '', REVIEW_VERDICT: '', GUARD: '', TESTS: '', PULL_REQUEST: '', PROMOTE: '', VERIFY: '' } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.outputs.json, '[]');
  });
}

// --- the kill switch -----------------------------------------------------------

test('pause: "true" pauses, anything else (including unset) does not', opts, () => {
  const { steps } = renderSteps(answers());
  const pause = findStep(steps, 'pause');
  assert.equal(runStep(pause, { env: { PAUSED: 'true' } }).outputs.paused, 'true');
  assert.equal(runStep(pause, { env: { PAUSED: '' } }).outputs.paused, 'false');
  assert.equal(runStep(pause, { env: { PAUSED: 'TRUE ' } }).outputs.paused, 'false');
});

// --- opening the pull request ----------------------------------------------------

test('pull request: opens with the summary verbatim, and model text in SUMMARY is never executed', opts, () => {
  const { steps } = renderSteps(answers());
  const argsFile = path.join(fakeTool('noop', 'true').dir, 'gh-args');
  const gh = fakeTool('gh', `printf '%s\\n' "$@" > "${argsFile.replace(/\\/g, '/')}"\necho "Creating pull request..."\necho "https://github.com/o/r/pull/42"`);
  const sandbox = fs.mkdtempSync(path.join(path.dirname(gh.dir), 'pr-cwd-'));
  const hostile = 'Fix jump $(touch pwned-subst) `touch pwned-tick` "; touch pwned-quote; "';

  const r = runStep(findStep(steps, 'pr'), {
    cwd: sandbox,
    pathPrepend: [gh.dir],
    env: {
      GH_TOKEN: 'x', BASE_BRANCH: 'main', BRANCH: 'agent/gen-007', GEN_NUMBER: '007',
      SUMMARY: hostile, RUN_URL: 'https://example/run/1', GENERATIONS_DIR: 'docs/generations',
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.outputs.url, 'https://github.com/o/r/pull/42');
  assert.deepEqual(fs.readdirSync(sandbox), [], 'nothing in SUMMARY ran');
  const args = fs.readFileSync(argsFile, 'utf8');
  assert.ok(args.includes(`Generation 007: ${hostile}`), 'the title carries the summary verbatim');
  assert.ok(args.includes('docs/generations/gen-007/proposal.md'));
});

// The three ways this step can end, run for real rather than reasoned about.
// The first two were checked by hand while investigating WORKPLAN I14, which
// claimed the pipe to `tail` swallowed gh's exit status. It does not — GitHub
// runs `shell: bash` with -eo pipefail — but that is load-bearing behaviour
// with no test, and the assumption is exactly the kind that quietly stops
// being true when someone changes a shell line.

test('pull request: a failing gh kills the step, so the gate reports failure and no URL is written', opts, () => {
  const { steps } = renderSteps(answers());
  const gh = fakeTool('gh', 'echo "HTTP 403: Resource not accessible by integration" >&2\nexit 1');
  const sandbox = fs.mkdtempSync(path.join(path.dirname(gh.dir), 'pr-fail-'));
  const r = runStep(findStep(steps, 'pr'), {
    cwd: sandbox,
    pathPrepend: [gh.dir],
    env: {
      GH_TOKEN: 'x', BASE_BRANCH: 'main', BRANCH: 'agent/gen-007', GEN_NUMBER: '007',
      SUMMARY: 's', RUN_URL: 'https://example/run/1', GENERATIONS_DIR: 'docs/generations',
    },
  });
  assert.notEqual(r.status, 0, 'a failed gh pr create must fail the step');
  assert.equal(r.outputs.url, undefined, 'no URL output when no pull request was opened');
});

test('pull request: gh exiting 0 without printing a URL is refused, not recorded as one', opts, () => {
  const { steps } = renderSteps(answers());
  const gh = fakeTool('gh', 'echo "Warning: using default branch"\nexit 0');
  const sandbox = fs.mkdtempSync(path.join(path.dirname(gh.dir), 'pr-nourl-'));
  const r = runStep(findStep(steps, 'pr'), {
    cwd: sandbox,
    pathPrepend: [gh.dir],
    env: {
      GH_TOKEN: 'x', BASE_BRANCH: 'main', BRANCH: 'agent/gen-007', GEN_NUMBER: '007',
      SUMMARY: 's', RUN_URL: 'https://example/run/1', GENERATIONS_DIR: 'docs/generations',
    },
  });
  assert.notEqual(r.status, 0, 'prose captured instead of a URL must fail the step');
  assert.equal(r.outputs.url, undefined, 'a warning line must never be recorded as the pull request');
  assert.match(r.stderr, /last line was not a URL/);
});

// --- credentials --------------------------------------------------------------------

// Every step that runs a script which calls a model, and so needs a lab key.
// The probe step shipped without one: every candidate read as unreachable,
// so the loop could never get past it. The digest shipped without one too,
// and silently fell back to its terse template on every run.
const MODEL_CALLING = [
  'validate.mjs', 'check-model-releases.mjs', 'probe-models.mjs', 'run-generation.mjs',
  'generate-themes-review.mjs', 'send-digest.mjs', 'send-escalation-notice.mjs',
];

for (const mode of MODES) {
  test(`credentials (${mode}): every model-calling step gets every lab key the run needs`, () => {
    const { steps } = renderSteps(answers({ approvalClass: mode }));
    const calling = steps.filter((s) => s.run && MODEL_CALLING.some((m) => s.run.includes(`node harness/scripts/${m}`)));
    assert.ok(calling.length >= MODEL_CALLING.length, `found ${calling.map((s) => s.name).join(', ')}`);
    for (const s of calling) {
      for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY']) {
        assert.equal(s.env?.[key], `\${{ secrets.${key} }}`, `"${s.name}" is missing ${key}`);
      }
    }
  });
}
