#!/usr/bin/env node

/**
 * Interactive scaffolder — asks the questions Portable-Harness-Design.md §6
 * specifies, then writes `project-adapter.yml`, a generated
 * `.github/workflows/self-improve.yml` (from `harness/templates/workflow.yml.tmpl`),
 * copies of the two brief templates (only where nothing already exists at
 * that path — this never overwrites a project's real, filled-in brief),
 * and a short `SELF-IMPROVE-README.md` explaining what just got installed.
 *
 * Run from a target project's root, AFTER `harness/` has already been
 * copied in (see the root README's "Getting started" step 1) — same
 * convention as every other harness CLI:
 *
 *   node harness/cli/init.mjs
 *
 * All the actual rendering is pure and unit-tested in
 * harness/lib/scaffold.mjs; this file owns only prompting, defaults
 * inferred from the target repo (git remote, current branch), and writing
 * files. Two independent flags:
 *
 *   --yes / -y   accepts every default without prompting at all — a fast
 *                way to see the shape of what gets generated, or to
 *                rehearse the scaffolder itself, though the result still
 *                needs real project-specific values (editable paths, test
 *                commands, providers) filled in by hand afterward if you
 *                skip past them this way.
 *   --force      overwrites a file that already exists at a target path.
 *                Without it, every write is skip-if-present — re-running
 *                init never clobbers a project's real, already-filled-in
 *                brief or adapter just because --yes was also passed.
 *
 * Interactive mode needs a real terminal (a TTY) on stdin — `rl.question()`
 * in a loop over piped/redirected input is unreliable in Node generally
 * (the input stream can end, auto-closing the interface, before every
 * question has been asked, since piped input arrives all at once rather
 * than paced by a person typing). Use `--yes` for any non-interactive
 * invocation instead of piping answers in.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import readline from 'node:readline/promises';
import '../providers/index.mjs';
import { getProvider, registeredProviders } from '../lib/llm-provider.mjs';
import { renderAdapterYaml, renderWorkflowTemplate, renderReadme } from '../lib/scaffold.mjs';

// path.join(..., '../x'), not import.meta.dirname — that global needs Node
// 20.11+, and package.json's engines field only promises 20.6.0.
const harnessDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.cwd();
const AUTO_YES = process.argv.includes('--yes') || process.argv.includes('-y');
// Separate from AUTO_YES on purpose: --yes only skips *prompts* (accepts
// every default). Whether an existing file gets overwritten is a distinct,
// more consequential decision — regenerating on top of a project's real,
// already-filled-in brief or adapter is exactly the kind of thing that
// should need its own explicit flag, not fall out of "accept defaults."
const FORCE = process.argv.includes('--force');

// stdio: 'pipe' for every stream, explicitly — git's stderr streams to our
// own stderr by default when unspecified, and "no remote configured" is an
// expected, handled outcome here, not something worth alarming the person
// running init with a raw `error:` line.
function detectGitRemote() {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function detectGitBranch() {
  try {
    return execFileSync('git', ['branch', '--show-current'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function splitList(raw) {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

async function ask(rl, question, { default: def = '' } = {}) {
  if (AUTO_YES) return def;
  const suffix = def ? ` [${def}]` : '';
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || def;
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('Self-optimisation harness — installation scaffolder\n');

  try {
    const projectId = await ask(rl, 'Project id', { default: path.basename(repoRoot) });
    const repository = await ask(rl, 'Repository URL', { default: detectGitRemote() });
    const defaultBranch = await ask(rl, 'Default branch', { default: detectGitBranch() || 'main' });

    const allowedPathsRaw = await ask(rl, 'Editable paths (comma-separated globs, e.g. index.html,src/**/*.js)');
    const allowedPaths = splitList(allowedPathsRaw);
    if (allowedPaths.length === 0) {
      console.log('\n⚠️  No editable paths given — the agent will have nothing it may edit until you add some to constitution.allowed_paths by hand.\n');
    }

    const frozenDefaults = ['.github/**', '.claude/agents/**'];
    const frozenPathsRaw = await ask(rl, 'Frozen paths — never touched autonomously (comma-separated globs)', { default: frozenDefaults.join(',') });
    const frozenPaths = splitList(frozenPathsRaw);

    const appendOnlyPathsRaw = await ask(rl, 'Append-only paths — new files may be added, existing ones may not change (comma-separated globs)', { default: 'tests/**' });
    const appendOnlyPaths = splitList(appendOnlyPathsRaw);

    const testCommandsRaw = await ask(rl, 'Test commands — one or more shell commands that must exit 0 (comma-separated)', { default: 'npm test' });
    const testCommands = splitList(testCommandsRaw);

    const known = registeredProviders();
    const providersRaw = await ask(rl, `Providers to watch (comma-separated; known: ${known.join(', ')})`, { default: 'anthropic,openai' });
    const providerNames = splitList(providersRaw).filter((name) => {
      const ok = known.includes(name);
      if (!ok) console.log(`   ⚠️  "${name}" is not a registered provider — skipping. Known: ${known.join(', ')}.`);
      return ok;
    });
    if (providerNames.length === 0) {
      console.log('\n❌ No valid provider selected — at least one is required to check for new model releases.');
      rl.close();
      process.exit(1);
    }
    const providers = providerNames.map((name) => ({ name, envKey: getProvider(name).envKey }));

    const cadenceCron = await ask(rl, 'Cadence (cron, UTC)', { default: '0 0 1 * *' });
    const runner = await ask(rl, 'CI runner (ubuntu-latest / windows-latest / macos-latest)', { default: 'ubuntu-latest' });
    const contextStrategy = await ask(rl, 'Context strategy (full-dump / scoped — "scoped" has no implementation yet, see ARCHITECTURE.md)', { default: 'full-dump' });

    const deploymentStrategy = await ask(rl, 'Deployment verify strategy (url / registry / artifact / none)', { default: 'none' });
    let deploymentUrl, deploymentRegistry, deploymentArtifact;
    if (deploymentStrategy === 'url') {
      const productionUrl = await ask(rl, '  Production URL');
      const watchedFiles = splitList(await ask(rl, '  Watched files (comma-separated, relative paths served at the same path on the live site)'));
      deploymentUrl = { productionUrl, watchedFiles };
    } else if (deploymentStrategy === 'registry') {
      const ecosystem = await ask(rl, '  Registry ecosystem (npm / pypi / nuget / maven)', { default: 'npm' });
      if (ecosystem === 'maven') {
        const groupId = await ask(rl, '  Maven group id');
        const artifactId = await ask(rl, '  Maven artifact id');
        deploymentRegistry = { ecosystem, groupId, artifactId };
      } else {
        const pkg = await ask(rl, '  Package name');
        deploymentRegistry = { ecosystem, package: pkg };
      }
    } else if (deploymentStrategy === 'artifact') {
      const buildCommand = await ask(rl, '  Build command (blank to skip)');
      const artifactPath = await ask(rl, '  Path the build must produce (blank to skip)');
      const smokeCommand = await ask(rl, '  Smoke-test command (blank to skip)');
      deploymentArtifact = { buildCommand: buildCommand || undefined, path: artifactPath || undefined, smokeCommand: smokeCommand || undefined };
    }

    const wantsNotify = (await ask(rl, 'Set up email notifications via SendGrid? (y/N)', { default: 'n' })).toLowerCase().startsWith('y');
    let notify = null;
    if (wantsNotify) {
      const recipient = await ask(rl, '  Recipient email');
      const recipientName = await ask(rl, '  Recipient name (used in the digest\'s tone)');
      const fromEmail = await ask(rl, '  From email');
      const fromName = await ask(rl, '  From name', { default: `${projectId}'s Self-Improvement` });
      notify = { provider: 'sendgrid', envKey: 'SENDGRID_API_KEY', recipient, recipientName, fromEmail, fromName };
    }

    const agentBriefPath = await ask(rl, 'Agent brief path', { default: '.claude/agents/improve.md' });
    const reviewerBriefPath = await ask(rl, 'Reviewer brief path', { default: '.claude/agents/review.md' });

    rl.close();

    const answers = {
      projectId, repository, defaultBranch,
      allowedPaths, createOnlyPaths: [], frozenPaths, appendOnlyPaths,
      testCommands, providers, snapshotPath: '.agent/model-snapshot.json',
      cadenceCron, runner, contextStrategy,
      agentBriefPath, reviewerBriefPath,
      deploymentStrategy, deploymentUrl, deploymentRegistry, deploymentArtifact,
      notify,
    };

    writeFiles(answers);
  } catch (err) {
    rl.close();
    throw err;
  }
}

function writeIfAbsentOrForced(targetPath, content, label) {
  const full = path.join(repoRoot, targetPath);
  if (fs.existsSync(full) && !FORCE) {
    console.log(`   ⚠️  ${label} already exists at ${targetPath} — leaving it alone. Re-run with --force to overwrite it.`);
    return false;
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  console.log(`   ✅ wrote ${targetPath}`);
  return true;
}

function writeFiles(answers) {
  console.log('\nWriting files...\n');

  writeIfAbsentOrForced('project-adapter.yml', renderAdapterYaml(answers), 'project-adapter.yml');

  const templatePath = path.join(harnessDir, '../templates/workflow.yml.tmpl');
  const template = fs.readFileSync(templatePath, 'utf8');
  writeIfAbsentOrForced('.github/workflows/self-improve.yml', renderWorkflowTemplate(template, answers), 'the generated workflow');

  const agentBriefTemplate = fs.readFileSync(path.join(harnessDir, '../templates/agent-brief.md.tmpl'), 'utf8');
  writeIfAbsentOrForced(answers.agentBriefPath, agentBriefTemplate, 'the agent brief');

  const reviewerBriefTemplate = fs.readFileSync(path.join(harnessDir, '../templates/reviewer-brief.md.tmpl'), 'utf8');
  writeIfAbsentOrForced(answers.reviewerBriefPath, reviewerBriefTemplate, 'the reviewer brief');

  writeIfAbsentOrForced('SELF-IMPROVE-README.md', renderReadme(answers), 'the install README');

  console.log('\nDone. Read SELF-IMPROVE-README.md next — it says exactly what still needs a human before the schedule should run unattended.');
}

await main();
