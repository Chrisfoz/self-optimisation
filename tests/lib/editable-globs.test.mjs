import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isGlob, expandGlob } from '../../harness/lib/glob.mjs';
import { compileAllowlist, isEditable, expandEditablePaths } from '../../harness/lib/edit-format.mjs';
import { validateAdapter } from '../../harness/lib/validate.mjs';

function tmpRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

test('isGlob: a pattern is anything with a star; everything else is an exact path', () => {
  assert.equal(isGlob('game/**'), true);
  assert.equal(isGlob('src/*.mjs'), true);
  assert.equal(isGlob('grammar-game.html'), false);
});

test('expandGlob: finds the files that exist, relative and sorted', () => {
  const root = tmpRepo({
    'game/sw.js': '//', 'game/manifest.webmanifest': '{}', 'game/levels/one.json': '{}',
    'grammar-game.html': '<html>',
  });
  assert.deepEqual(expandGlob('game/**', { repoRoot: root }),
    ['game/levels/one.json', 'game/manifest.webmanifest', 'game/sw.js']);
  assert.deepEqual(expandGlob('game/*.js', { repoRoot: root }), ['game/sw.js']);
});

test('expandGlob: a pattern whose directory does not exist yields nothing rather than throwing', () => {
  const root = tmpRepo({ 'grammar-game.html': '<html>' });
  assert.deepEqual(expandGlob('game/**', { repoRoot: root }), []);
});

test('expandGlob: never descends into node_modules or .git, whatever the pattern says', () => {
  const root = tmpRepo({
    'src/a.mjs': '//',
    'src/node_modules/dep/index.mjs': '//',
    'src/.git/config': '',
  });
  assert.deepEqual(expandGlob('src/**', { repoRoot: root }), ['src/a.mjs']);
});

test('compileAllowlist: a pattern in allowed_paths makes matching files editable', () => {
  const allowlist = compileAllowlist({ allowedPaths: ['grammar-game.html', 'game/**'] });
  assert.equal(isEditable('grammar-game.html', allowlist), true);
  assert.equal(isEditable('game/sw.js', allowlist), true);
  assert.equal(isEditable('game/levels/one.json', allowlist), true);
  assert.equal(isEditable('harness/lib/validate.mjs', allowlist), false);
});

test('compileAllowlist: a pattern still cannot be escaped by traversal', () => {
  const allowlist = compileAllowlist({ allowedPaths: ['game/**'] });
  assert.equal(isEditable('game/../.github/workflows/self-improve.yml', allowlist), false);
});

test('expandEditablePaths: patterns become the real files, exact paths pass through', () => {
  const root = tmpRepo({ 'game/sw.js': '//', 'game/manifest.webmanifest': '{}', 'grammar-game.html': '<html>' });
  assert.deepEqual(
    expandEditablePaths(['grammar-game.html', 'game/**'], { repoRoot: root }),
    ['grammar-game.html', 'game/manifest.webmanifest', 'game/sw.js']
  );
});

test('expandEditablePaths: de-duplicates when a pattern also names an exact entry', () => {
  const root = tmpRepo({ 'game/sw.js': '//' });
  assert.deepEqual(expandEditablePaths(['game/sw.js', 'game/**'], { repoRoot: root }), ['game/sw.js']);
});

test('validateAdapter: a pattern matching real files is accepted, where existsSync would have refused it', () => {
  const root = tmpRepo({
    'game/sw.js': '//', 'grammar-game.html': '<html>', 'a.test.mjs': '',
  });
  const adapter = {
    project: { id: 'x', repository: 'https://github.com/a/b', default_branch: 'main' },
    providers: { watched: ['anthropic'] },
    constitution: { allowed_paths: ['grammar-game.html', 'game/**'], frozen_paths: ['.github/**'] },
    roles: { agent_brief_path: 'a.test.mjs', reviewer_brief_path: 'a.test.mjs' },
    evaluation: { test_commands: ['node --test'] },
  };
  const { errors } = validateAdapter(adapter, { repoRoot: root, env: { ANTHROPIC_API_KEY: 'k' } });
  assert.equal(errors.filter((e) => e.includes('allowed_paths')).length, 0, errors.join('\n'));
});

test('validateAdapter: a pattern matching nothing is an error, and says to use create_only_paths instead', () => {
  const root = tmpRepo({ 'grammar-game.html': '<html>', 'a.test.mjs': '' });
  const adapter = {
    project: { id: 'x', repository: 'https://github.com/a/b', default_branch: 'main' },
    providers: { watched: ['anthropic'] },
    constitution: { allowed_paths: ['grammar-game.html', 'game/**'], frozen_paths: ['.github/**'] },
    roles: { agent_brief_path: 'a.test.mjs', reviewer_brief_path: 'a.test.mjs' },
    evaluation: { test_commands: ['node --test'] },
  };
  const { errors } = validateAdapter(adapter, { repoRoot: root, env: { ANTHROPIC_API_KEY: 'k' } });
  const hit = errors.find((e) => e.includes('game/**'));
  assert.ok(hit, errors.join('\n'));
  assert.match(hit, /matches no file/);
  assert.match(hit, /create_only_paths/);
});
