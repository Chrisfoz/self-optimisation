import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

/** npm, which on Windows is a .cmd that Node will only start through a shell. */
function npm(args, opts = {}) {
  const r = spawnSync('npm', args, { cwd: REPO_ROOT, encoding: 'utf8', shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) throw new Error(`npm ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

test('the package version is the harness version, and the bin is an executable ES module', () => {
  assert.equal(pkg.version, fs.readFileSync(path.join(REPO_ROOT, 'harness/VERSION'), 'utf8').trim());
  const bin = Object.values(pkg.bin)[0];
  assert.match(fs.readFileSync(path.join(REPO_ROOT, bin), 'utf8'), /^#!\/usr\/bin\/env node\n/);
  assert.equal(pkg.dependencies, undefined, 'an npx install must download nothing but this package');
});

test('npm pack ships the harness and its entry point, and nothing that is not an install', () => {
  const [{ files }] = JSON.parse(npm(['pack', '--dry-run', '--json', '--ignore-scripts']));
  const paths = files.map((f) => f.path);
  for (const needed of ['bin/self-optimisation.mjs', 'harness/cli/init.mjs', 'harness/vendor/js-yaml.mjs', 'harness/templates/workflow.yml.tmpl', 'harness/VERSION', 'LICENSE']) {
    assert.ok(paths.includes(needed), `missing ${needed}`);
  }
  const stray = paths.filter((p) => /^(tests|console|docs|learning|examples|\.github)\//.test(p) || /(^|\/)\.env(?!\.harness\.example$)/.test(p));
  assert.deepEqual(stray, []);
});

test('the packed tarball installs into an empty project, upgrades it keeping the keys, and checks it', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'npx-package-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const packDir = path.join(work, 'pack');
  const project = path.join(work, 'project');
  fs.mkdirSync(packDir);
  fs.mkdirSync(project);

  const [{ filename }] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', packDir]));
  execFileSync('tar', ['-xzf', filename], { cwd: packDir });
  const bin = path.join(packDir, 'package', 'bin', 'self-optimisation.mjs');
  const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: project, encoding: 'utf8' });

  fs.writeFileSync(path.join(project, 'index.html'), '<html></html>');
  const init = cli('init', '--yes');
  assert.equal(init.status, 0, init.stdout + init.stderr);
  assert.match(init.stdout, /Copied harness\/ \d+\.\d+\.\d+/);
  assert.ok(fs.existsSync(path.join(project, 'harness/vendor/js-yaml.mjs')));
  assert.ok(fs.existsSync(path.join(project, 'project-adapter.yml')));
  assert.ok(fs.existsSync(path.join(project, '.github/workflows/self-improve.yml')));

  // A real key, and a stale file an older harness had: upgrade keeps the one
  // and drops the other.
  fs.writeFileSync(path.join(project, 'harness/.env.harness.local'), 'ANTHROPIC_API_KEY=sk-ant-kept\n');
  fs.writeFileSync(path.join(project, 'harness/lib/removed-in-this-version.mjs'), '');
  const upgrade = cli('upgrade');
  assert.equal(upgrade.status, 0, upgrade.stdout + upgrade.stderr);
  assert.equal(fs.readFileSync(path.join(project, 'harness/.env.harness.local'), 'utf8'), 'ANTHROPIC_API_KEY=sk-ant-kept\n');
  assert.equal(fs.existsSync(path.join(project, 'harness/lib/removed-in-this-version.mjs')), false);

  const doctor = cli('doctor', '--offline');
  assert.match(doctor.stdout, /installation check/);

  assert.equal(cli('--version').stdout.trim(), pkg.version);
});
