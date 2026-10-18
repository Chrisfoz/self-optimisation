import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { load as loadYaml } from '../../harness/vendor/js-yaml.mjs';

const REPO_ROOT = path.join(import.meta.dirname, '../..');

/**
 * Run init interactively, answering each prompt as it appears — piping every
 * answer up front is unreliable with readline (a line that arrives before its
 * question is dropped). `answers` maps a prompt's leading text to a reply;
 * any other prompt gets Enter. Resolves with every prompt that was asked.
 */
function driveInit(cwd, args, answers) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['harness/cli/init.mjs', ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const asked = [];
    let pending = '';
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      pending += chunk;
      // A prompt ends in ": " with no newline after it.
      if (!/: $/.test(pending)) return;
      const prompt = pending.split('\n').pop();
      pending = '';
      asked.push(prompt);
      const key = Object.keys(answers).find((k) => prompt.trimStart().startsWith(k));
      child.stdin.write(`${key ? answers[key] : ''}\n`);
    });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, asked, out }));
  });
}

test('init --quick asks five questions and writes an adapter with every other default', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'init-quick-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(REPO_ROOT, 'harness'), path.join(root, 'harness'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<html></html>');

  const { code, asked, out } = await driveInit(root, ['--quick'], {
    'Providers to watch': 'deepseek',
    'Editable paths': 'index.html',
    'Test commands': 'node --test',
    'Merge automatically': 'n',
  });

  assert.equal(code, 0, out);
  assert.deepEqual(
    asked.map((q) => q.trimStart().split(/[ (—]/)[0]),
    ['Editable', 'Test', 'Setup', 'Providers', 'Merge'],
    `asked:\n${asked.join('\n')}`,
  );
  assert.doesNotMatch(out, /Context strategy/);

  const adapter = loadYaml(fs.readFileSync(path.join(root, 'project-adapter.yml'), 'utf8'));
  assert.deepEqual(adapter.providers.watched, ['deepseek']);
  assert.deepEqual(adapter.constitution.allowed_paths, ['index.html']);
  assert.deepEqual(adapter.evaluation.test_commands, ['node --test']);
  assert.equal(adapter.constitution.approval_class, 'human-approval-required');
  // The defaults the full questionnaire offers, taken without asking.
  assert.deepEqual(adapter.constitution.frozen_paths, ['.github/**', '.claude/agents/**']);
  assert.equal(adapter.context.strategy, 'full-dump');
});
