import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { spawnSync } from 'node:child_process';
import { JS_YAML_VERSION } from '../../harness/lib/scaffold.mjs';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const VENDORED = path.join(REPO_ROOT, 'harness/vendor/js-yaml.mjs');

/**
 * The published js-yaml 5.3.0 `dist/js-yaml.mjs`, byte for byte. A change to
 * the vendored file that is not an upgrade is a change to code every install
 * runs with a write token, so it has to be deliberate: replace the file from
 * the package, then bump this hash and JS_YAML_VERSION together.
 */
const VENDORED_SHA256 = '7c5405f6b6e1aacfcd488520ec06c776ad738cc96001ebae4b6b3a636da0d3fb';

test('the vendored js-yaml is the release JS_YAML_VERSION names, unmodified', () => {
  const bytes = fs.readFileSync(VENDORED);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), VENDORED_SHA256);
  assert.match(bytes.toString('utf8', 0, 200), new RegExp(`^/\\*! js-yaml ${JS_YAML_VERSION.replace(/\./g, '\\.')} `));
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'harness/vendor/js-yaml.LICENSE')), 'MIT requires the licence to travel with the code');
});

/** Every .mjs under a directory, skipping the vendored library itself. */
function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
    .map((e) => path.join(e.parentPath, e.name))
    .filter((f) => !f.includes(`${path.sep}vendor${path.sep}`));
}

// CONTRIBUTING's first non-negotiable, as a check rather than a promise: a
// copied harness/ must run with nothing installed, so nothing in it (or in
// the console, which ships beside it) may import from node_modules.
test('nothing in harness/ or console/ imports a package from node_modules', () => {
  const builtins = new Set(builtinModules);
  const offenders = [];
  for (const file of [...sources(path.join(REPO_ROOT, 'harness')), ...sources(path.join(REPO_ROOT, 'console'))]) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [, spec] of text.matchAll(/(?:^import\s[^;]*?from\s|import\()\s*['"]([^'"]+)['"]/gm)) {
      if (spec.startsWith('.') || spec.startsWith('node:') || builtins.has(spec)) continue;
      offenders.push(`${path.relative(REPO_ROOT, file)}: ${spec}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('a copied harness/ runs init and validate with no node_modules anywhere', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'no-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // A real copy, not a symlink: Node resolves a symlinked module from its
  // real path, which would find this repository's node_modules.
  fs.cpSync(path.join(REPO_ROOT, 'harness'), path.join(root, 'harness'), { recursive: true });

  const init = spawnSync(process.execPath, ['harness/cli/init.mjs', '--yes'], { cwd: root, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  assert.doesNotMatch(init.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/);
  assert.ok(fs.existsSync(path.join(root, 'project-adapter.yml')));

  // Exit 1 is expected (--yes leaves allowed_paths empty); what matters is
  // that it parsed the adapter, which needs the YAML library.
  const validate = spawnSync(process.execPath, ['harness/scripts/validate.mjs'], { cwd: root, encoding: 'utf8' });
  assert.doesNotMatch(validate.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/);
  assert.match(validate.stdout, /allowed_paths is empty/);
});
