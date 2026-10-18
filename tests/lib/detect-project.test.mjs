import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { detectProject } from '../../harness/lib/detect-project.mjs';
import { load as loadYaml } from '../../harness/vendor/js-yaml.mjs';

const REPO_ROOT = path.join(import.meta.dirname, '../..');

/** A temporary repository holding exactly `files` ({relativePath: content}). */
function repo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

test('node + npm: npm test, npm ci without install scripts, and src/**', (t) => {
  const root = repo(t, {
    'package.json': JSON.stringify({ scripts: { test: 'jest' }, devDependencies: { jest: '^29' } }),
    'package-lock.json': '{}',
    'src/index.js': '',
  });
  assert.deepEqual(detectProject(root), {
    ecosystems: ['node'], testCommands: ['npm test'], setupCommands: ['npm ci --ignore-scripts'], allowedPaths: ['src/**'],
  });
});

test('node: the placeholder test script npm init writes is not proposed', (t) => {
  const root = repo(t, { 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
  assert.deepEqual(detectProject(root).testCommands, []);
});

test('node: the lockfile names the package manager', (t) => {
  const pnpm = repo(t, { 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }), 'pnpm-lock.yaml': '' });
  assert.deepEqual(detectProject(pnpm).testCommands, ['pnpm test']);
  assert.deepEqual(detectProject(pnpm).setupCommands, ['pnpm install --frozen-lockfile --ignore-scripts']);
  const yarn = repo(t, { 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), 'yarn.lock': '' });
  assert.deepEqual(detectProject(yarn).testCommands, ['yarn test']);
});

test('node: no dependencies and no lockfile means nothing to install', (t) => {
  const root = repo(t, { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) });
  assert.deepEqual(detectProject(root).setupCommands, []);
});

test('python: requirements files are installed, pytest is proposed when declared, packages are editable', (t) => {
  const root = repo(t, {
    'pyproject.toml': '[project]\nname = "calc"\n',
    'requirements.txt': 'requests\n',
    'requirements-dev.txt': 'pytest\n',
    'calc/__init__.py': '',
    'tests/__init__.py': '',
  });
  assert.deepEqual(detectProject(root), {
    ecosystems: ['python'],
    testCommands: ['python -m pytest'],
    setupCommands: ['pip install -r requirements-dev.txt', 'pip install -r requirements.txt'],
    allowedPaths: ['calc/**'],
  });
});

test('python: a tests/ directory with pytest undeclared installs pytest rather than failing preflight', (t) => {
  const root = repo(t, { 'pyproject.toml': '[project]\nname = "x"\n', 'src/x/__init__.py': '', 'tests/test_x.py': '' });
  const got = detectProject(root);
  assert.deepEqual(got.setupCommands, ['pip install -e .', 'pip install pytest']);
  assert.deepEqual(got.allowedPaths, ['src/**']);
});

test('rust, go, maven, gradle and .NET each propose their own test command', (t) => {
  assert.deepEqual(detectProject(repo(t, { 'Cargo.toml': '', 'src/main.rs': '' })).testCommands, ['cargo test']);

  const go = detectProject(repo(t, { 'go.mod': 'module x', 'main.go': '', 'internal/a/a.go': '' }));
  assert.deepEqual(go.testCommands, ['go test ./...']);
  assert.deepEqual(go.allowedPaths, ['*.go', 'internal/**']);

  const maven = detectProject(repo(t, { 'pom.xml': '', mvnw: '', 'src/main/java/A.java': '', 'src/test/java/ATest.java': '' }));
  assert.deepEqual(maven.testCommands, ['./mvnw -B test']);
  assert.deepEqual(maven.allowedPaths, ['src/main/**'], 'the JVM layout keeps tests out of the editable surface');

  assert.deepEqual(detectProject(repo(t, { 'build.gradle.kts': '' })).testCommands, ['gradle test']);

  const dotnet = detectProject(repo(t, { 'App.sln': '', 'src/App/App.csproj': '' }));
  assert.deepEqual(dotnet.setupCommands, ['dotnet restore']);
  assert.deepEqual(dotnet.testCommands, ['dotnet test --no-restore']);
});

test('make test is the fallback only when nothing more specific said how to test', (t) => {
  assert.deepEqual(detectProject(repo(t, { Makefile: 'test:\n\t./run.sh\n' })).testCommands, ['make test']);
  const both = detectProject(repo(t, { Makefile: 'test:\n\tcargo test\n', 'Cargo.toml': '' }));
  assert.deepEqual(both.testCommands, ['cargo test']);
});

test('a static site with nothing else proposes its page; an empty repository proposes nothing', (t) => {
  assert.deepEqual(detectProject(repo(t, { 'index.html': '<html>' })).allowedPaths, ['index.html']);
  assert.deepEqual(detectProject(repo(t, {})), { ecosystems: [], testCommands: [], setupCommands: [], allowedPaths: [] });
});

test('an unparseable package.json is skipped, not thrown on', (t) => {
  assert.deepEqual(detectProject(repo(t, { 'package.json': '{ nope' })).ecosystems, []);
});

test('init --yes takes the detected defaults, and the adapter it writes validates clean of the empty-paths error', (t) => {
  const root = repo(t, {
    'package.json': JSON.stringify({ scripts: { test: 'node --test' }, devDependencies: { x: '1' } }),
    'package-lock.json': '{}',
    'src/app.mjs': 'export {};\n',
  });
  fs.cpSync(path.join(REPO_ROOT, 'harness'), path.join(root, 'harness'), { recursive: true });
  const result = spawnSync(process.execPath, ['harness/cli/init.mjs', '--yes'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Detected: node/);
  assert.doesNotMatch(result.stdout, /allowed_paths is empty/);

  const adapter = loadYaml(fs.readFileSync(path.join(root, 'project-adapter.yml'), 'utf8'));
  assert.deepEqual(adapter.constitution.allowed_paths, ['src/**']);
  assert.deepEqual(adapter.evaluation.test_commands, ['npm test']);
  assert.deepEqual(adapter.evaluation.setup_commands, ['npm ci --ignore-scripts']);
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/self-improve.yml'), 'utf8');
  assert.match(workflow, /name: Install the project's own dependencies\n\s+shell: bash\n\s+run: \|\n\s+npm ci --ignore-scripts/);
});
