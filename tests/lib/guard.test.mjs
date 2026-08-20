import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { checkGuardedPaths } from '../../harness/lib/guard.mjs';

/**
 * A fake `git` for unit tests — dispatches on the subcommand and returns
 * canned output shaped exactly like real git, so checkGuardedPaths()'s
 * parsing logic is exercised without a real repository. See guard-real-repo
 * below for the complementary test that proves this shape assumption is
 * actually correct against real git.
 */
function fakeGit({ diffNameStatus = '', diffShortstat = '', showAt = {} }) {
  return (...args) => {
    if (args[0] === 'diff' && args.includes('--name-status')) return diffNameStatus;
    if (args[0] === 'diff' && args.includes('--shortstat')) return diffShortstat;
    if (args[0] === 'show') {
      const ref = args[1]; // "ref:path"
      return showAt[ref] ?? (() => { throw new Error(`fatal: no such ref ${ref}`); })();
    }
    throw new Error(`fakeGit: unhandled args ${JSON.stringify(args)}`);
  };
}

test('checkGuardedPaths throws without a baseRef', () => {
  assert.throws(() => checkGuardedPaths({ git: fakeGit({}) }), /requires a baseRef/);
});

test('an unrelated changed file produces no violations', () => {
  const result = checkGuardedPaths({
    baseRef: 'origin/main',
    frozenPaths: [/^\.github\//],
    git: fakeGit({ diffNameStatus: 'M\tsrc/index.js', diffShortstat: ' 1 file changed, 2 insertions(+)' }),
  });
  assert.equal(result.pass, true);
  assert.deepEqual(result.violations, []);
  assert.equal(result.filesChanged, 1);
  assert.equal(result.linesChanged, 2);
});

test('touching a frozen path is a violation', () => {
  const result = checkGuardedPaths({
    baseRef: 'origin/main',
    frozenPaths: [/^\.github\//],
    git: fakeGit({ diffNameStatus: 'M\t.github/workflows/ci.yml', diffShortstat: ' 1 file changed, 1 insertion(+)' }),
  });
  assert.equal(result.pass, false);
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0], /is frozen/);
});

test('a rename is checked under both its old and new name', () => {
  const result = checkGuardedPaths({
    baseRef: 'origin/main',
    frozenPaths: [/^\.github\//],
    git: fakeGit({
      // R100<TAB>old<TAB>new — renaming a frozen path OUT is still a touch of it.
      diffNameStatus: 'R100\t.github/workflows/ci.yml\tworkflows/ci.yml',
      diffShortstat: ' 1 file changed, 0 insertions(+)',
    }),
  });
  assert.equal(result.pass, false);
  assert.match(result.violations[0], /\.github\/workflows\/ci\.yml is frozen/);
});

test('append-only: a new file is fine, a modified existing file is a violation', () => {
  const newFile = checkGuardedPaths({
    baseRef: 'origin/main',
    appendOnlyPaths: [/^tests\//],
    git: fakeGit({ diffNameStatus: 'A\ttests/lib/new.test.mjs', diffShortstat: ' 1 file changed, 10 insertions(+)' }),
  });
  assert.equal(newFile.pass, true);

  const modifiedFile = checkGuardedPaths({
    baseRef: 'origin/main',
    appendOnlyPaths: [/^tests\//],
    git: fakeGit({ diffNameStatus: 'M\ttests/lib/existing.test.mjs', diffShortstat: ' 1 file changed, 3 deletions(-)' }),
  });
  assert.equal(modifiedFile.pass, false);
  assert.match(modifiedFile.violations[0], /append-only/);

  const deletedFile = checkGuardedPaths({
    baseRef: 'origin/main',
    appendOnlyPaths: [/^tests\//],
    git: fakeGit({ diffNameStatus: 'D\ttests/lib/existing.test.mjs', diffShortstat: ' 1 file changed, 5 deletions(-)' }),
  });
  assert.equal(deletedFile.pass, false);
});

test('frozen fields: a changed field is a violation, an untouched one is not', () => {
  const changed = checkGuardedPaths({
    baseRef: 'origin/main',
    frozenFields: { 'package.json': ['scripts'] },
    git: fakeGit({
      diffNameStatus: 'M\tpackage.json',
      diffShortstat: ' 1 file changed, 1 insertion(+), 1 deletion(-)',
      showAt: {
        'origin/main:package.json': JSON.stringify({ scripts: { test: 'node --test' }, version: '1.0.0' }),
        'HEAD:package.json': JSON.stringify({ scripts: { test: 'exit 0' }, version: '1.0.0' }),
      },
    }),
  });
  assert.equal(changed.pass, false);
  assert.match(changed.violations[0], /"scripts" field is frozen/);

  const untouched = checkGuardedPaths({
    baseRef: 'origin/main',
    frozenFields: { 'package.json': ['scripts'] },
    git: fakeGit({
      diffNameStatus: 'M\tpackage.json',
      diffShortstat: ' 1 file changed, 1 insertion(+), 1 deletion(-)',
      showAt: {
        'origin/main:package.json': JSON.stringify({ scripts: { test: 'node --test' }, version: '1.0.0' }),
        'HEAD:package.json': JSON.stringify({ scripts: { test: 'node --test' }, version: '1.0.1' }),
      },
    }),
  });
  assert.equal(untouched.pass, true);
});

test('frozen fields is only checked for files that actually appear in the diff', () => {
  const result = checkGuardedPaths({
    baseRef: 'origin/main',
    frozenFields: { 'package.json': ['scripts'] },
    git: fakeGit({ diffNameStatus: 'M\tsrc/index.js', diffShortstat: ' 1 file changed, 1 insertion(+)' }),
  });
  assert.equal(result.pass, true);
});

test('churn ceiling: too many files, or too many lines, is a violation', () => {
  const manyFiles = checkGuardedPaths({
    baseRef: 'origin/main',
    maxFiles: 2,
    git: fakeGit({
      diffNameStatus: 'M\ta.js\nM\tb.js\nM\tc.js',
      diffShortstat: ' 3 files changed, 3 insertions(+)',
    }),
  });
  assert.equal(manyFiles.pass, false);
  assert.match(manyFiles.violations[0], /over the 2 allowed/);

  const manyLines = checkGuardedPaths({
    baseRef: 'origin/main',
    maxLines: 10,
    git: fakeGit({ diffNameStatus: 'M\ta.js', diffShortstat: ' 1 file changed, 50 insertions(+)' }),
  });
  assert.equal(manyLines.pass, false);
  assert.match(manyLines.violations[0], /over the 10 allowed/);
});

// --- Real git repo integration test -----------------------------------
// Proves the assumed `git diff --name-status --find-renames` /
// `git diff --shortstat` output shapes above are actually what real git
// produces, not just what this test file assumes it produces.

test('checkGuardedPaths against a real git repository', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-real-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Guard Test');

  fs.writeFileSync(path.join(dir, 'src.js'), 'console.log("v1");\n');
  fs.mkdirSync(path.join(dir, '.github'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.github', 'workflow.yml'), 'name: CI\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');
  git('branch', 'origin-main-stub'); // stand-in for a remote ref, avoids needing a real remote

  git('checkout', '-q', '-b', 'agent/gen-001');
  fs.writeFileSync(path.join(dir, 'src.js'), 'console.log("v2");\n');
  fs.writeFileSync(path.join(dir, '.github', 'workflow.yml'), 'name: CI Modified\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'agent change, touches a frozen path');

  const result = checkGuardedPaths({
    baseRef: 'origin-main-stub',
    frozenPaths: [/^\.github\//],
    git,
  });

  assert.equal(result.pass, false);
  assert.equal(result.filesChanged, 2);
  assert.ok(result.violations.some((v) => v.includes('.github/workflow.yml is frozen')));
});

test('checkGuardedPaths against a real git repository: a clean change passes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-real-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Guard Test');

  fs.writeFileSync(path.join(dir, 'src.js'), 'console.log("v1");\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');
  git('branch', 'origin-main-stub');

  git('checkout', '-q', '-b', 'agent/gen-002');
  fs.writeFileSync(path.join(dir, 'src.js'), 'console.log("v2");\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'clean agent change');

  const result = checkGuardedPaths({
    baseRef: 'origin-main-stub',
    frozenPaths: [/^\.github\//],
    git,
  });

  assert.equal(result.pass, true);
});
