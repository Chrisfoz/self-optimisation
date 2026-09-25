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
 * inferred from the target repo (git remote, default branch), and writing
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
 *   --from-adapter  asks nothing: renders the workflow and install README
 *                from the project-adapter.yml already there. The way to
 *                regenerate after editing the adapter or upgrading harness/
 *                (`--from-adapter --force`); the adapter and briefs are
 *                never touched.
 *   --shared <sha>  install shared instead of copied: the workflow calls the
 *                harness repository's shared workflow at that full commit
 *                SHA (--shared-repository owner/repo for a fork, and
 *                --shared-label v0.1.0 as a comment beside it), so no copy
 *                of harness/ has to live in the project. With
 *                --from-adapter, it replaces the pin the adapter recorded.
 *   --quick      asks only what has no safe default: which labs, what may be
 *                edited, how to test, how to install for the tests, and
 *                whether to merge without asking. Everything else takes the
 *                default the full questionnaire offers, and stays editable in
 *                project-adapter.yml.
 *   --configure-github  after init: sets the repository secrets this
 *                installation needs from harness/.env.harness.local, and ticks
 *                "Allow GitHub Actions to create and approve pull requests",
 *                through the `gh` CLI — then reads the tickbox back and fails
 *                if it did not save. Asks before changing anything (--yes
 *                skips that). Without `gh`, prints the manual steps.
 *   --detector-only  writes only .github/workflows/watch-releases.yml: the
 *                release detector on a schedule, opening an issue when a new
 *                model ships. Asks which labs to watch and nothing else; no
 *                adapter, no model is ever called.
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
import { parseEnv } from 'node:util';
import '../providers/index.mjs';
import { getProvider, registeredProviders, resolveProvider } from '../lib/llm-provider.mjs';
import { renderAdapterYaml, renderWorkflowTemplate, renderCallerWorkflow, renderDetectorWorkflow, renderReadme, renderChecklist, buildAdapterObject, answersFromAdapter, requiredProviders } from '../lib/scaffold.mjs';
import { harnessVersion, checkUpgrade } from '../lib/version.mjs';
import { describeSeats } from '../lib/seats.mjs';
import { normalizeAmbition, normalizeApprovalClass, loadAdapter } from '../lib/adapter.mjs';
import { validateAdapter } from '../lib/validate.mjs';
import { detectProject } from '../lib/detect-project.mjs';
import { ghRunner, ghReady, repoSlug, setSecrets, allowPullRequests, manualSteps } from '../lib/github-setup.mjs';
import { detectDefaultBranch, gitRunner, remoteDefaultBranch } from '../lib/git-default-branch.mjs';

// path.join(..., '../x'), not import.meta.dirname — kept as the one idiom every
// file here uses, from when package.json promised Node 20.6.
const harnessDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.cwd();
const AUTO_YES = process.argv.includes('--yes') || process.argv.includes('-y');
// Separate from AUTO_YES on purpose: --yes only skips *prompts* (accepts
// every default). Whether an existing file gets overwritten is a distinct,
// more consequential decision — regenerating on top of a project's real,
// already-filled-in brief or adapter is exactly the kind of thing that
// should need its own explicit flag, not fall out of "accept defaults."
const FORCE = process.argv.includes('--force');
const QUICK = process.argv.includes('--quick');

// A shared installation (renderCallerWorkflow()). Validated when the workflow
// is rendered, before anything is written.
const flagValue = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const SHARED = process.argv.includes('--shared')
  ? {
      ref: flagValue('--shared'),
      ...(flagValue('--shared-repository') ? { repository: flagValue('--shared-repository') } : {}),
      ...(flagValue('--shared-label') ? { label: flagValue('--shared-label') } : {}),
    }
  : null;

/** The workflow this installation gets: a call to the shared one, or a copied-in one. Throws on a bad pin. */
function installedWorkflow(answers) {
  if (answers.sharedHarness) return renderCallerWorkflow(answers);
  const template = fs.readFileSync(path.join(harnessDir, '../templates/workflow.yml.tmpl'), 'utf8');
  return renderWorkflowTemplate(template, answers);
}

function renderOrExit(answers) {
  try {
    return installedWorkflow(answers);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}

// Two informational flags that never write anything. `--version` says which
// harness this vendored copy is; `--check-upgrade` fetches upstream's
// VERSION and says whether this copy is behind. Both exist because "copy one
// folder" is the install, and a folder carries no manifest to ask.
if (process.argv.includes('--version')) {
  console.log(harnessVersion());
  process.exit(0);
}
if (process.argv.includes('--check-upgrade')) {
  const result = await checkUpgrade();
  if (result.error) {
    console.log(`Local harness ${result.local}; could not read upstream (${result.error}).`);
    process.exit(2);
  }
  if (result.behind === null) {
    console.log(`Local harness ${result.local}; upstream ${result.upstream} — could not compare.`);
    process.exit(2);
  }
  console.log(
    result.behind
      ? `Local harness ${result.local} is behind upstream ${result.upstream}. Re-copy harness/ from the repository, then regenerate the workflow with: node harness/cli/init.mjs --from-adapter --force`
      : `Local harness ${result.local} is current (upstream ${result.upstream}).`
  );
  process.exit(result.behind ? 1 : 0);
}

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

/**
 * A question --quick does not ask: its default is taken silently. Kept to the
 * questions with a default that is safe to run on (the seats, the schedule,
 * the paths a generation may never touch), so the short path never trades
 * safety for speed.
 */
async function detail(rl, question, opts) {
  return QUICK ? (opts?.default ?? '') : ask(rl, question, opts);
}

/** Explanatory text for a question --quick skips. */
function explain(...lines) {
  if (!QUICK) for (const line of lines) console.log(line);
}

/** "Which labs?" — shared by the full install and --detector-only. Exits when none is valid. */
async function askProviders(rl) {
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
  return { providerNames, providers: providerNames.map((name) => ({ name, envKey: getProvider(name).envKey })) };
}

/**
 * `--detector-only`: the release notice without the loop. One question, one
 * workflow file, and the env file so `check-keys` can prove the keys first.
 */
async function detectorOnly() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('Self-optimisation harness — release detector only\n');
  const { providers } = await askProviders(rl);
  const cadenceCron = await ask(rl, 'Cadence (cron, UTC)', { default: '0 0 1 * *' });
  rl.close();

  console.log('\nWriting files...\n');
  writeIfAbsentOrForced('.github/workflows/watch-releases.yml', renderDetectorWorkflow({ providers, cadenceCron }), 'the detector workflow');
  writeEnvTemplate();
  console.log(
    '\nDone. Add one repository secret per lab (Settings → Secrets and variables → Actions):\n' +
    providers.map((p) => `  - ${p.envKey}`).join('\n') +
    '\n\nThen commit, push, and use "Run workflow" in the Actions tab to try it now.' +
    '\nThe full loop is plain `node harness/cli/init.mjs`, whenever you want it.'
  );
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`Self-optimisation harness — installation scaffolder${QUICK ? ' (quick: five questions; everything else takes its default)' : ''}\n`);
  let answersAmbitionOverride = null;

  try {
    const projectId = await detail(rl, 'Project id', { default: path.basename(repoRoot) });
    const repository = await detail(rl, 'Repository URL', { default: detectGitRemote() });
    // The repository's default branch, not the one you're on: the
    // walkthrough has you on a setup branch by now. See git-default-branch.mjs.
    const defaultBranch = await detail(rl, 'Default branch', { default: detectDefaultBranch(gitRunner(repoRoot)) || detectGitBranch() || 'main' });

    // The committed goal (docs/curiosity/C1). Optional, strongly
    // recommended, and the one thing every stage is judged against once it
    // exists. Direction, not a metric — a number here would be gamed.
    explain('\nWhat is this project trying to become? One or two sentences of direction, not a metric.',
      'Optional, but every proposal and every review is judged against it once it exists.\n');
    const goalStatement = await detail(rl, 'Goal (blank to skip)');

    // Proposals from the repository itself (package.json, pyproject.toml,
    // Cargo.toml, go.mod, pom.xml, *.csproj, Makefile): the defaults below,
    // which Enter accepts and anything typed replaces.
    const detected = detectProject(repoRoot);
    if (detected.ecosystems.length) {
      console.log(`\nDetected: ${detected.ecosystems.join(', ')}. The defaults below come from your project's own files — check them.\n`);
    }

    const allowedPathsRaw = await ask(rl, 'Editable paths (comma-separated globs, e.g. index.html,src/**/*.js)', { default: detected.allowedPaths.join(',') });
    const allowedPaths = splitList(allowedPathsRaw);
    if (allowedPaths.length === 0) {
      console.log('\n⚠️  No editable paths given — the agent will have nothing it may edit until you add some to constitution.allowed_paths by hand.\n');
    }

    const frozenDefaults = ['.github/**', '.claude/agents/**'];
    const frozenPathsRaw = await detail(rl, 'Frozen paths — never touched autonomously (comma-separated globs)', { default: frozenDefaults.join(',') });
    const frozenPaths = splitList(frozenPathsRaw);

    const appendOnlyPathsRaw = await detail(rl, 'Append-only paths — new files may be added, existing ones may not change (comma-separated globs)', { default: 'tests/**' });
    const appendOnlyPaths = splitList(appendOnlyPathsRaw);

    const testCommandsRaw = await ask(rl, 'Test commands — one or more shell commands that must exit 0 (comma-separated)', { default: detected.testCommands.join(',') || 'npm test' });
    const testCommands = splitList(testCommandsRaw);

    // What the workflow runs before the tests, on a fresh runner. Without it a
    // copied install's preflight cannot find the project's own test runner
    // (WORKPLAN I10) — so it is asked here rather than left for the adapter.
    const setupCommandsRaw = await ask(rl, 'Setup commands — install what the tests need on a fresh machine (comma-separated, blank for none)', { default: detected.setupCommands.join(',') });
    const setupCommands = splitList(setupCommandsRaw);

    const known = registeredProviders();
    const { providerNames, providers } = await askProviders(rl);

    // The three pinned seats. The suggest seat rotates — whichever watched
    // lab shipped something new wins it — but implement, review and rank
    // stay on a model the project chose and trusts, which is the whole
    // point of pinning them (see learning/01-principles.md). Defaulting all
    // three to claude-opus-5 matches the reference implementation; a
    // project is free to point any of them at any registered lab's model.
    explain('\nThe pinned seats — the suggest seat rotates to whichever watched lab ships something new,',
      'but these three stay on a model you choose. Blank accepts the default.\n');
    const implementModel = await detail(rl, 'Implement model — writes the actual edit when the suggester offers none', { default: 'claude-opus-5' });
    const reviewModel = await detail(rl, 'Review model — the independent gate; fails closed. Prefer a DIFFERENT lab than the implementer', { default: 'claude-opus-5' });
    // Blank means "let the run choose a different family from the snapshot"
    // (harness/lib/seats.mjs), which is the better default than echoing the
    // implementer — see run-generation.mjs for why the rank seat can be
    // auto-assigned and the review seat cannot.
    const rankModel = await detail(rl, 'Rank model — only called when more than one lab proposed; blank picks another lab\'s model at run time', { default: '' });

    const seats = describeSeats({ implementModel, reviewModel, rankModel: rankModel || implementModel });
    for (const warning of seats.warnings) {
      if (!rankModel && warning.includes('rank seat')) continue;
      console.log(`   ⚠️  ${warning}`);
    }

    // Resolve each pinned model back to the lab that serves it, so the
    // generated workflow gets that lab's API-key secret even when nobody is
    // watching it for releases. Resolution happens here, in the CLI, rather
    // than in scaffold.mjs, so that file stays pure data-in/string-out with
    // no dependency on the provider registry being loaded.
    const roleProviders = [];
    for (const [seat, model] of [['implement', implementModel], ['review', reviewModel], ['rank', rankModel]]) {
      if (!model) continue;
      try {
        const name = resolveProvider(model);
        roleProviders.push({ name, envKey: getProvider(name).envKey });
        if (!providerNames.includes(name)) {
          console.log(`   ℹ️  ${seat} model "${model}" is served by ${name}, which you are not watching.`);
          console.log(`      That's fine — but the workflow will need ${getProvider(name).envKey} set as a repository secret too.`);
        }
      } catch {
        console.log(`   ⚠️  Could not resolve a provider for the ${seat} model "${model}".`);
        console.log(`      No secret will be wired for it, and the run will fail when it calls that model.`);
        console.log(`      Known labs: ${known.join(', ')}. Fix roles.${seat}.model in project-adapter.yml before running.`);
      }
    }

    // The merge model. Phrased as an opt-IN to autonomous merge rather than
    // as a two-way choice with an equally-weighted alternative: a blank
    // answer, an unrecognised answer, and a nervous answer all land on the
    // pull-request path. console/DESIGN.md §Step 7 — "defaulting a
    // non-technical user into autonomous merge is the single worst decision
    // this console could make" — applies just as much to a CLI.
    console.log('\nWhen a generation passes every gate, the workflow can either open a pull request for you');
    console.log('to merge, or merge and tag it itself. Opening a pull request is the default.\n');
    const wantsAutoMerge = (await ask(rl, 'Merge automatically once every gate passes, with no human step? (y/N)', { default: 'n' }))
      .toLowerCase()
      .startsWith('y');
    const approvalClass = wantsAutoMerge ? 'autonomous-merge' : 'human-approval-required';
    if (wantsAutoMerge) {
      console.log('   ℹ️  Autonomous merge selected. Every generation is still tagged gen-NNN, so any merge');
      console.log('      is revertible — but nothing will ask you first. Rehearse at least one run by hand.');
    }

    // The ambition dial. Phrased with "earned" as the default and the
    // ambitious setting behind an explicit risk statement — the gates are
    // the same at every setting, but what a run ATTEMPTS is not, and an
    // owner who picks "ambitious" with autonomous merge has chosen to have
    // structural change land unattended. docs/Ambition-Control.md.
    explain('\nHow ambitious may each generation be? "focused" is one small localised change every time;',
      '"earned" (the default) unlocks one ambitious generation after a clean streak; "ambitious" attempts',
      'structural work on every run. Every setting passes the same gates.\n');
    const ambition = normalizeAmbition(await detail(rl, 'Ambition (focused / earned / ambitious)', { default: 'earned' }));
    if (ambition === 'ambitious') {
      console.log('   ⚠️  Ambitious on every run. Expect more rejected attempts and more tokens per generation, and');
      console.log('      read docs/Ambition-Control.md — in particular, keep the pull-request merge model, and know');
      console.log('      that `node harness/scripts/revert-generation.mjs NNN` undoes a shipped generation.');
      if (wantsAutoMerge) {
        console.log('   ⚠️  Ambitious AND autonomous merge: structural change will land on your default branch with');
        console.log('      nobody asked first. That is the riskiest combination this harness offers.');
        const sure = (await ask(rl, '      Type "ambitious" to confirm, or anything else to fall back to "earned"', { default: 'earned' })).trim().toLowerCase();
        if (sure !== 'ambitious') console.log('      Falling back to "earned".');
        answersAmbitionOverride = sure === 'ambitious' ? 'ambitious' : 'earned';
      }
    }

    const cadenceCron = await detail(rl, 'Cadence (cron, UTC)', { default: '0 0 1 * *' });
    // Defaulted ON here and OFF for the console (console/DESIGN.md §Step 9):
    // someone running this CLI in their own checkout has already done the
    // equivalent of reviewing and merging the install, which is the step the
    // console's two-phase onboarding is protecting.
    const includeSchedule = !(await detail(rl, 'Leave the schedule off until you have rehearsed a run by hand? (y/N)', { default: 'n' }))
      .toLowerCase()
      .startsWith('y');
    const runner = await detail(rl, 'CI runner (ubuntu-latest / windows-latest / macos-latest)', { default: 'ubuntu-latest' });
    // context.strategy is not asked: nothing in the harness reads it yet, and a
    // question whose answer changes nothing is a question in the way. The
    // adapter still records full-dump, which is what every run does.
    const contextStrategy = 'full-dump';

    const deploymentStrategy = await detail(rl, 'Deployment verify strategy (url / registry / artifact / none)', { default: 'none' });
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

    const wantsNotify = (await detail(rl, 'Set up email notifications via SendGrid? (y/N)', { default: 'n' })).toLowerCase().startsWith('y');
    let notify = null;
    if (wantsNotify) {
      const recipient = await ask(rl, '  Recipient email');
      const recipientName = await ask(rl, '  Recipient name (used in the digest\'s tone)');
      const fromEmail = await ask(rl, '  From email');
      const fromName = await ask(rl, '  From name', { default: `${projectId}'s Self-Improvement` });
      notify = { provider: 'sendgrid', envKey: 'SENDGRID_API_KEY', recipient, recipientName, fromEmail, fromName };
      // The digest is written by a model (notify.digest_model, default
      // claude-opus-5). Without its lab's key wired into the two notify
      // steps, every email quietly fell back to the terse template.
      try {
        const name = resolveProvider('claude-opus-5');
        roleProviders.push({ name, envKey: getProvider(name).envKey });
      } catch { /* the terse fallback still sends */ }
    }

    const agentBriefPath = await detail(rl, 'Agent brief path', { default: '.claude/agents/improve.md' });
    const reviewerBriefPath = await detail(rl, 'Reviewer brief path', { default: '.claude/agents/review.md' });

    rl.close();

    const answers = {
      harnessVersion: harnessVersion(),
      ambition: answersAmbitionOverride ?? ambition,
      goalStatement: goalStatement || undefined,
      projectId, repository, defaultBranch,
      allowedPaths, createOnlyPaths: [], frozenPaths, appendOnlyPaths,
      testCommands, setupCommands, providers, roleProviders, snapshotPath: '.agent/model-snapshot.json',
      implementModel, reviewModel, rankModel,
      approvalClass, cadenceCron, includeSchedule, runner, contextStrategy,
      agentBriefPath, reviewerBriefPath,
      deploymentStrategy, deploymentUrl, deploymentRegistry, deploymentArtifact,
      notify,
      ...(SHARED ? { sharedHarness: SHARED } : {}),
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

/**
 * Lay down the local env file the harness reads its API keys from, so an
 * import arrives ready for keys to be pasted in rather than needing the
 * template found and copied by hand.
 *
 * Two deliberate choices, both learned the hard way:
 *
 *   - It is `.env.harness.local`, never `.env`. Most projects already keep a
 *     `.env` at the root for the application itself, and the harness must not
 *     collide with it or overwrite it — the web server has no reason to hold
 *     nine labs' keys, and the harness has no reason to hold a database
 *     service-role key.
 *   - It lives at `harness/.env.harness.local`, beside the code that reads it,
 *     so the harness stays self-contained and a project's root stays clean.
 *     The cost is that a harness upgrade replaces this directory: preserve
 *     this one file across a re-import (the upgrade note in
 *     .env.harness.example says so too).
 *
 * Unlike every other write here this is skip-if-present even under --force:
 * the file holds real keys once filled in, and no flag should overwrite it.
 */
/**
 * `SELF-IMPROVE-CHECKLIST.md` — written once, then owned by the project.
 *
 * Skip-if-present even under --force, for the same reason as the env file
 * below: once anyone has ticked a box this is a record of how far the
 * installation actually got, and regenerating it silently un-ticks that
 * record. The workflow and the README are derived artefacts and may be
 * overwritten; this one accumulates state, so it may not.
 */
function writeChecklist(answers) {
  const target = path.join(repoRoot, 'SELF-IMPROVE-CHECKLIST.md');
  if (fs.existsSync(target)) {
    const ticked = (fs.readFileSync(target, 'utf8').match(/- \[[xX]\]/g) || []).length;
    console.log(
      `   ⚠️  SELF-IMPROVE-CHECKLIST.md already exists${ticked ? ` (${ticked} item(s) already ticked)` : ''} — leaving it alone; --force does not apply.`
    );
    return;
  }
  fs.writeFileSync(target, renderChecklist(answers));
  console.log('   ✅ wrote SELF-IMPROVE-CHECKLIST.md (work through it before the schedule runs)');
}

function writeEnvTemplate() {
  const target = path.join(repoRoot, 'harness', '.env.harness.local');
  if (fs.existsSync(target)) {
    console.log('   ⚠️  harness/.env.harness.local already exists — leaving it alone (it holds real keys; --force does not apply).');
    return;
  }
  const template = fs.readFileSync(path.join(harnessDir, '../.env.harness.example'), 'utf8');
  fs.writeFileSync(target, template);

  const ignorePath = path.join(repoRoot, '.gitignore');
  const ignored = fs.existsSync(ignorePath) && /^\s*\.env\.\*\s*$|^\s*\.env\.harness\.local\s*$|^\s*\.env\.\*\.local\s*$/m.test(fs.readFileSync(ignorePath, 'utf8'));
  console.log(`   ✅ wrote harness/.env.harness.local (placeholders — paste your keys in${ignored ? '; it is git-ignored' : ''})`);
  if (!ignored) {
    console.log('   ❗ .gitignore does not appear to cover harness/.env.harness.local — add a `.env.*` line');
    console.log('      (plus `!.env.harness.example`) before you put a real key in it. Confirm with');
    console.log('      `git check-ignore -v harness/.env.harness.local`.');
  }
}

function writeFiles(answers) {
  // Rendered first, so a bad shared pin stops init before any file is written.
  const workflow = renderOrExit(answers);
  console.log('\nWriting files...\n');

  writeIfAbsentOrForced('project-adapter.yml', renderAdapterYaml(answers), 'project-adapter.yml');
  writeIfAbsentOrForced('.github/workflows/self-improve.yml', workflow, 'the generated workflow');

  const agentBriefTemplate = fs.readFileSync(path.join(harnessDir, '../templates/agent-brief.md.tmpl'), 'utf8');
  writeIfAbsentOrForced(answers.agentBriefPath, agentBriefTemplate, 'the agent brief');

  const reviewerBriefTemplate = fs.readFileSync(path.join(harnessDir, '../templates/reviewer-brief.md.tmpl'), 'utf8');
  writeIfAbsentOrForced(answers.reviewerBriefPath, reviewerBriefTemplate, 'the reviewer brief');

  writeIfAbsentOrForced('SELF-IMPROVE-README.md', renderReadme(answers), 'the install README');
  writeChecklist(answers);

  writeEnvTemplate();

  console.log('\nChecking what was just written...');
  const { errors, warnings } = validateAdapter(buildAdapterObject(answers), { repoRoot, env: process.env, remoteDefaultBranch: remoteDefaultBranch(gitRunner(repoRoot)) });
  for (const e of errors) console.log(`   ❌ ${e}`);
  for (const w of warnings) console.log(`   ⚠️  ${w}`);
  if (!errors.length && !warnings.length) console.log('   No issues found.');
  console.log(
    (QUICK ? '\nEvery other setting took its default — see project-adapter.yml, or re-run without --quick.\n' : '') +
    '\nDone. Three things next, in this order:\n' +
    '\n  1. Prove your keys work — this is the cheapest failure to catch, and the\n' +
    '     only one that otherwise surfaces mid-generation after money is spent:\n' +
    '       node --env-file=harness/.env.harness.local harness/scripts/check-keys.mjs\n' +
    '\n  2. Put the same keys on GitHub, and allow the workflow to open pull\n' +
    '     requests (with the GitHub CLI signed in; it prints the steps otherwise):\n' +
    '       node harness/cli/init.mjs --configure-github\n' +
    '\n  3. Work through SELF-IMPROVE-CHECKLIST.md, then SELF-IMPROVE-README.md —\n' +
    '     between them they say exactly what still needs a human before the\n' +
    '     schedule should run unattended.\n' +
    '\n  Any time after that, one command says what is still missing:\n' +
    '       node harness/scripts/doctor.mjs' +
    (errors.length ? '\n\n  Fix the error(s) above first — `node harness/scripts/validate.mjs` re-checks them any time.' : '')
  );
}

/**
 * `--from-adapter`: regenerate the workflow and the install README from the
 * project-adapter.yml that already exists — after changing
 * `approval_class`, the schedule, the test commands, or the watched labs,
 * or after upgrading harness/. Asks nothing, and never touches the adapter
 * or the briefs. Combine with --force to replace the existing workflow.
 */
async function fromAdapter() {
  const adapterPath = path.join(repoRoot, 'project-adapter.yml');
  const adapter = await loadAdapter(adapterPath);
  if (!adapter) {
    console.error(`No project-adapter.yml at ${adapterPath}. Run init without --from-adapter to create one.`);
    process.exit(1);
  }
  const answers = answersFromAdapter(adapter, {
    providerEnvKey: (name) => getProvider(name)?.envKey ?? `${String(name).toUpperCase()}_API_KEY`,
    modelProvider: (model) => { try { return resolveProvider(model); } catch { return null; } },
  });
  const recorded = answers.sharedHarness?.ref;
  if (SHARED) answers.sharedHarness = SHARED;
  const workflow = renderOrExit(answers);
  console.log('Rendering from project-adapter.yml — the adapter and the briefs are not touched.\n');
  if (SHARED && recorded !== SHARED.ref) {
    console.log(`   ⚠️  project-adapter.yml records ${recorded ? `harness.shared.ref ${recorded}` : 'no shared harness'}; the workflow now pins ${SHARED.ref}.`);
    console.log('      Update harness.shared in the adapter to match, so the record says what runs.\n');
  }
  writeIfAbsentOrForced('.github/workflows/self-improve.yml', workflow, 'the generated workflow');
  writeIfAbsentOrForced('SELF-IMPROVE-README.md', renderReadme(answers), 'the install README');
  writeChecklist(answers);

  const { errors, warnings } = validateAdapter(adapter, { repoRoot, env: process.env, remoteDefaultBranch: remoteDefaultBranch(gitRunner(repoRoot)) });
  for (const e of errors) console.log(`   ❌ ${e}`);
  for (const w of warnings) console.log(`   ⚠️  ${w}`);
  process.exit(errors.length ? 1 : 0);
}

/**
 * `--configure-github`: the secrets and the pull-request tickbox, from the
 * adapter and the local env file that already exist. Only the labs this
 * installation calls get a secret; a blank key is reported, never uploaded.
 */
async function configureGithub() {
  const adapter = await loadAdapter(path.join(repoRoot, 'project-adapter.yml'));
  if (!adapter) {
    console.error('No project-adapter.yml here. Run init first, then --configure-github.');
    process.exit(1);
  }
  const answers = answersFromAdapter(adapter, {
    providerEnvKey: (name) => getProvider(name)?.envKey ?? `${String(name).toUpperCase()}_API_KEY`,
    modelProvider: (model) => { try { return resolveProvider(model); } catch { return null; } },
  });
  const names = [...requiredProviders(answers).map((p) => p.envKey), ...(answers.notify?.envKey ? [answers.notify.envKey] : [])];
  const pullRequests = normalizeApprovalClass(answers.approvalClass) !== 'autonomous-merge';
  const slug = repoSlug(answers.repository || detectGitRemote());

  const gh = ghRunner({ cwd: repoRoot });
  if (!slug || !ghReady(gh)) {
    console.log(slug
      ? 'The GitHub CLI (`gh`) is not installed or not signed in (`gh auth login`), so here are the steps by hand:\n'
      : 'Could not tell which GitHub repository this is (project.repository in the adapter), so here are the steps by hand:\n');
    console.log(manualSteps(slug, names, { pullRequests }));
    process.exit(1);
  }

  const envPath = path.join(repoRoot, 'harness', '.env.harness.local');
  const env = fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, 'utf8')) : {};
  console.log(`Repository: ${slug}`);
  console.log(`Secrets to set from harness/.env.harness.local: ${names.join(', ')}`);
  if (pullRequests) console.log('Setting: allow GitHub Actions to create pull requests (your default workflow permission is left as it is).');
  if (!AUTO_YES) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const go = (await rl.question('Proceed? (y/N): ')).trim().toLowerCase().startsWith('y');
    rl.close();
    if (!go) { console.log('Nothing changed.'); process.exit(1); }
  }

  let failed = false;
  const secrets = setSecrets(gh, slug, names, env);
  for (const n of secrets.set) console.log(`   ✅ secret ${n}`);
  for (const n of secrets.missing) {
    console.log(`   ❌ ${n} is blank or missing in harness/.env.harness.local — not set. Paste the key in and re-run.`);
    failed = true;
  }
  for (const { name, error } of secrets.failed) {
    console.log(`   ❌ secret ${name}: ${error}`);
    failed = true;
  }
  if (pullRequests) {
    const pr = allowPullRequests(gh, slug);
    if (pr.ok) console.log(`   ✅ pull requests allowed${pr.alreadySet ? ' (already on)' : ', and it reads back as saved'}`);
    else {
      console.log(`   ❌ pull-request permission: ${pr.error}`);
      failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv.includes('--configure-github')) await configureGithub();
else if (process.argv.includes('--from-adapter')) await fromAdapter();
else if (process.argv.includes('--detector-only')) await detectorOnly();
else await main();
