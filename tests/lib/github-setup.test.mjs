import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoSlug, setSecrets, allowPullRequests, listSecretNames, ghReady, manualSteps } from '../../harness/lib/github-setup.mjs';

const REPO_ROOT = path.join(import.meta.dirname, '../..');

/**
 * A fake `gh` that records every call and answers from `handlers`, keyed by
 * the first two arguments ("secret set", "api -X", ...). Unmatched calls
 * succeed with empty output.
 */
function fakeGh(handlers = {}) {
  const calls = [];
  const gh = (args, opts = {}) => {
    calls.push({ args, input: opts.input });
    const h = handlers[args.slice(0, 2).join(' ')] ?? handlers[args[0]];
    return h ? h(args, opts, calls) : { status: 0, stdout: '', stderr: '' };
  };
  return { gh, calls };
}

test('repoSlug: https, ssh and bare forms, with and without .git', () => {
  assert.equal(repoSlug('https://github.com/acme/widget.git'), 'acme/widget');
  assert.equal(repoSlug('https://github.com/acme/widget'), 'acme/widget');
  assert.equal(repoSlug('git@github.com:acme/widget.git'), 'acme/widget');
  assert.equal(repoSlug('acme/widget'), 'acme/widget');
  assert.equal(repoSlug('https://gitlab.com/acme/widget'), null);
  assert.equal(repoSlug(''), null);
});

test('ghReady: only a signed-in gh counts', () => {
  assert.equal(ghReady(fakeGh({ auth: () => ({ status: 0 }) }).gh), true);
  assert.equal(ghReady(fakeGh({ auth: () => ({ status: 1 }) }).gh), false);
  assert.equal(ghReady(fakeGh({ auth: () => ({ status: null }) }).gh), false, 'not installed');
});

test('setSecrets: values go on stdin, never in argv; blank ones are reported, not uploaded', () => {
  const { gh, calls } = fakeGh();
  const result = setSecrets(gh, 'acme/widget', ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SENDGRID_API_KEY'], {
    ANTHROPIC_API_KEY: '  sk-ant-real  ',
    OPENAI_API_KEY: '',
  });
  assert.deepEqual(result, { set: ['ANTHROPIC_API_KEY'], missing: ['OPENAI_API_KEY', 'SENDGRID_API_KEY'], failed: [] });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['secret', 'set', 'ANTHROPIC_API_KEY', '--repo', 'acme/widget']);
  assert.equal(calls[0].input, 'sk-ant-real', 'trimmed: a stray space is a key that does not work');
  assert.ok(!calls[0].args.some((a) => a.includes('sk-ant')), 'a secret in argv is visible to every process on the machine');
});

test('setSecrets: a gh failure is reported per secret, with its message', () => {
  const { gh } = fakeGh({ 'secret set': () => ({ status: 1, stderr: 'HTTP 403: Resource not accessible\n' }) });
  const result = setSecrets(gh, 'acme/widget', ['XAI_API_KEY'], { XAI_API_KEY: 'k' });
  assert.deepEqual(result.failed, [{ name: 'XAI_API_KEY', error: 'HTTP 403: Resource not accessible' }]);
});

/** A repository whose settings live in `state`, and a PUT that may or may not stick. */
function permissionsGh(state, { putSticks = true } = {}) {
  return fakeGh({
    'api repos/acme/widget/actions/permissions/workflow': () => ({ status: 0, stdout: JSON.stringify(state) }),
    'api -X': (args) => {
      if (putSticks) {
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '-f' || args[i] === '-F') {
            const [k, v] = args[i + 1].split('=');
            state[k] = v === 'true' ? true : v === 'false' ? false : v;
          }
        }
      }
      return { status: 0, stdout: '' };
    },
  });
}

test('allowPullRequests: ticks the box, keeps the existing default permission, and reads it back', () => {
  const state = { default_workflow_permissions: 'write', can_approve_pull_request_reviews: false };
  const { gh, calls } = permissionsGh(state);
  assert.deepEqual(allowPullRequests(gh, 'acme/widget'), { ok: true, alreadySet: false });
  const put = calls.find((c) => c.args.includes('PUT'));
  assert.ok(put.args.includes('default_workflow_permissions=write'), 'the radio applies to every other workflow; leave it alone');
  assert.equal(state.can_approve_pull_request_reviews, true);
  assert.equal(calls.filter((c) => !c.args.includes('PUT')).length, 2, 'read before and after');
});

test('allowPullRequests: already on is left alone', () => {
  const { gh, calls } = permissionsGh({ default_workflow_permissions: 'read', can_approve_pull_request_reviews: true });
  assert.deepEqual(allowPullRequests(gh, 'acme/widget'), { ok: true, alreadySet: true });
  assert.ok(!calls.some((c) => c.args.includes('PUT')));
});

test('allowPullRequests: a save that does not stick fails loudly — the first real install\'s failure', () => {
  const { gh } = permissionsGh({ default_workflow_permissions: 'read', can_approve_pull_request_reviews: false }, { putSticks: false });
  const result = allowPullRequests(gh, 'acme/widget');
  assert.equal(result.ok, false);
  assert.match(result.error, /reads back as off/);
});

test('listSecretNames: names only', () => {
  const { gh } = fakeGh({ 'secret list': () => ({ status: 0, stdout: JSON.stringify([{ name: 'A', updatedAt: 'x' }, { name: 'B' }]) }) });
  assert.deepEqual(listSecretNames(gh, 'acme/widget'), { names: ['A', 'B'] });
});

test('manualSteps: names every secret, and the tickbox only on the pull-request path', () => {
  const pr = manualSteps('acme/widget', ['ANTHROPIC_API_KEY'], { pullRequests: true });
  assert.match(pr, /ANTHROPIC_API_KEY/);
  assert.match(pr, /settings\/actions/);
  assert.match(pr, /can_approve_pull_request_reviews/);
  assert.doesNotMatch(manualSteps('acme/widget', ['X'], { pullRequests: false }), /pull requests/);
});

test('init --configure-github without gh prints the steps by hand and changes nothing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'configure-github-'));
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'no-gh-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(emptyPath, { recursive: true, force: true });
  });
  fs.cpSync(path.join(REPO_ROOT, 'harness'), path.join(root, 'harness'), { recursive: true });
  fs.writeFileSync(path.join(root, 'project-adapter.yml'), [
    'project: {id: w, repository: "https://github.com/acme/widget"}',
    'providers: {watched: [deepseek]}',
    'roles: {implement: {model: claude-opus-5}, review: {model: claude-opus-5}}',
    'constitution: {approval_class: human-approval-required}',
    '',
  ].join('\n'));

  // A PATH with nothing on it: `gh` cannot be found, whatever this machine has.
  const result = spawnSync(process.execPath, ['harness/cli/init.mjs', '--configure-github'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: emptyPath, Path: emptyPath },
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /not installed or not signed in/);
  assert.match(result.stdout, /DEEPSEEK_API_KEY/);
  assert.match(result.stdout, /ANTHROPIC_API_KEY/, 'the pinned seats\' lab needs a secret too');
  assert.match(result.stdout, /github\.com\/acme\/widget\/settings\/actions/);
});
