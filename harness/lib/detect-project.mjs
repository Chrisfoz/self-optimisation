/**
 * Proposes `init`'s answers from what is already in the repository, so a
 * person confirms or edits a default rather than typing from memory the one
 * command their CI already knows. Proposals only: every value still goes
 * through a prompt, and `validate.mjs` still checks what was written.
 *
 * Reads files; never runs anything. A manifest that cannot be parsed is
 * skipped rather than thrown on, since a wrong guess costs one edit and a
 * crash costs the install.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The test script `npm init` writes. Proposing it would propose a failing preflight. */
const NPM_PLACEHOLDER_TEST = /no test specified/;

/** Directories that conventionally hold a project's own source, in the order they are proposed. */
const SOURCE_DIRS = ['src', 'lib', 'app', 'pkg', 'cmd', 'internal'];

/**
 * @param {string} repoRoot
 * @returns {{ecosystems: string[], testCommands: string[], setupCommands: string[], allowedPaths: string[]}}
 *   Empty lists mean "nothing to propose", never "propose nothing".
 */
export function detectProject(repoRoot) {
  const has = (rel) => fs.existsSync(path.join(repoRoot, rel));
  const read = (rel) => {
    try { return fs.readFileSync(path.join(repoRoot, rel), 'utf8'); } catch { return ''; }
  };
  const rootFiles = safeList(repoRoot);
  const hasDirWithFiles = (rel) => {
    const full = path.join(repoRoot, rel);
    try {
      return fs.statSync(full).isDirectory() && fs.readdirSync(full, { recursive: true }).length > 0;
    } catch { return false; }
  };

  const ecosystems = [];
  const testCommands = [];
  const setupCommands = [];
  const allowedPaths = [];

  // --- Node ---------------------------------------------------------------
  if (has('package.json')) {
    let pkg = null;
    try { pkg = JSON.parse(read('package.json')); } catch { /* unreadable: propose nothing from it */ }
    if (pkg) {
      ecosystems.push('node');
      const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
      const test = pkg.scripts?.test;
      if (test && !NPM_PLACEHOLDER_TEST.test(test)) testCommands.push(`${pm} test`);
      const hasDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0;
      // --ignore-scripts: the job that runs this holds a write token, and an
      // install script is the one place a dependency runs code by default.
      // A project whose build needs its install scripts removes the flag.
      if (pm === 'npm' && has('package-lock.json')) setupCommands.push('npm ci --ignore-scripts');
      else if (pm === 'npm' && hasDeps) setupCommands.push('npm install --ignore-scripts');
      else if (pm === 'yarn') setupCommands.push('yarn install --frozen-lockfile --ignore-scripts');
      else if (pm === 'pnpm') setupCommands.push('pnpm install --frozen-lockfile --ignore-scripts');
      else if (pm === 'bun') setupCommands.push('bun install --frozen-lockfile --ignore-scripts');
    }
  }

  // --- Python -------------------------------------------------------------
  const pyManifests = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt'].filter(has);
  if (pyManifests.length) {
    ecosystems.push('python');
    const requirementFiles = rootFiles.filter((f) => /^requirements(-[\w.-]+)?\.txt$/.test(f)).sort();
    for (const f of requirementFiles) setupCommands.push(`pip install -r ${f}`);
    if (!requirementFiles.length && (has('pyproject.toml') || has('setup.py'))) setupCommands.push('pip install -e .');
    const declared = [...pyManifests, ...requirementFiles, 'pytest.ini', 'tox.ini'].map(read).join('\n');
    const usesPytest = /\bpytest\b/.test(declared) || has('pytest.ini') || has('conftest.py');
    if (usesPytest || has('tests')) {
      if (!/\bpytest\b/.test(declared)) setupCommands.push('pip install pytest');
      testCommands.push('python -m pytest');
    } else {
      testCommands.push('python -m unittest discover');
    }
    // Top-level packages: a directory with an __init__.py that is not a test directory.
    for (const d of rootFiles) {
      if (/^(tests?|docs|examples|build|dist|venv|\.venv)$/.test(d)) continue;
      if (has(path.join(d, '__init__.py'))) allowedPaths.push(`${d}/**`);
    }
  }

  // --- Rust ---------------------------------------------------------------
  if (has('Cargo.toml')) {
    ecosystems.push('rust');
    testCommands.push('cargo test');
  }

  // --- Go -----------------------------------------------------------------
  if (has('go.mod')) {
    ecosystems.push('go');
    testCommands.push('go test ./...');
    if (rootFiles.some((f) => f.endsWith('.go'))) allowedPaths.push('*.go');
  }

  // --- JVM ----------------------------------------------------------------
  if (has('pom.xml')) {
    ecosystems.push('maven');
    testCommands.push(has('mvnw') ? './mvnw -B test' : 'mvn -B test');
    if (hasDirWithFiles('src/main')) allowedPaths.push('src/main/**');
  } else if (has('build.gradle') || has('build.gradle.kts')) {
    ecosystems.push('gradle');
    testCommands.push(has('gradlew') ? './gradlew test' : 'gradle test');
    if (hasDirWithFiles('src/main')) allowedPaths.push('src/main/**');
  }

  // --- .NET ---------------------------------------------------------------
  if (rootFiles.some((f) => /\.(sln|csproj|fsproj)$/.test(f))) {
    ecosystems.push('dotnet');
    setupCommands.push('dotnet restore');
    testCommands.push('dotnet test --no-restore');
  }

  // --- Make: only when nothing more specific said how to test ---------------
  if (!testCommands.length && has('Makefile') && /^test\s*:/m.test(read('Makefile'))) {
    ecosystems.push('make');
    testCommands.push('make test');
  }

  // Conventional source directories, for any ecosystem that has not already
  // named something narrower (src/main/** for the JVM, say).
  for (const d of SOURCE_DIRS) {
    if (allowedPaths.some((p) => p.startsWith(`${d}/`))) continue;
    if (hasDirWithFiles(d)) allowedPaths.push(`${d}/**`);
  }
  // A static site with nothing else: its page is the source.
  if (!allowedPaths.length && has('index.html')) allowedPaths.push('index.html');

  return {
    ecosystems,
    testCommands: [...new Set(testCommands)],
    setupCommands: [...new Set(setupCommands)],
    allowedPaths: [...new Set(allowedPaths)],
  };
}

function safeList(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}
