#!/usr/bin/env node

/**
 * Structural validation for a project-adapter.yml — the `validateAnswers()`
 * console/DESIGN.md §2.1 calls "the whole value of the thing" and that,
 * until this file existed, neither the CLI nor the console had. Every
 * check here is an invariant a config file can violate silently: nothing
 * downstream refuses to start, the first sign of trouble is a generation
 * that fails for a reason that was true the moment the file was written.
 *
 * Two severities:
 *
 *   errors    a structural contradiction, or a value nothing downstream can
 *             recover from. A run should refuse to start.
 *   warnings  something that will bite later, or that this function cannot
 *             verify structurally (a missing API key, an unresolved pinned
 *             model) but is worth saying out loud before the first run
 *             discovers it mid-cycle.
 *
 * Pure aside from reading the repository's own files to check existence —
 * same convention as context-pack.mjs's read()/sizeOf(): real fs, a
 * repoRoot parameter, no injected filesystem. `env` is injectable (defaults
 * to process.env) purely so a test can assert the key-presence warnings
 * without touching real environment variables.
 */

import fs from 'fs';
import path from 'path';
import { constitutionAllowlist, guardConfig, briefPaths, rolesConfig, watchedProviders, goalConfig, snapshotPath } from './adapter.mjs';
import { globToRegExp, isGlob, expandGlob } from './glob.mjs';
import { resolveProvider, getProvider, registeredProviders } from './llm-provider.mjs';
import { resolveProviderModule } from './context-providers.mjs';

/**
 * A bracketed placeholder left over from a template — `[TRIGGER CONDITION]`,
 * `[the live thing]`, `[path]` — as opposed to a markdown link, which this
 * excludes by refusing to match a `]` immediately followed by `(`. Neither
 * brief template uses markdown links, so this has no known false positive
 * against them; a project that adds one to its own filled-in brief would.
 */
/**
 * Whether git ignores this adapter's model snapshot, asked through a
 * gitRunner() (git-default-branch.mjs): `git check-ignore` prints the path
 * and exits 0 when it is ignored, and the runner returns null otherwise.
 */
export function snapshotIgnoredBy(git, adapter) {
  return Boolean(git('check-ignore', snapshotPath(adapter) || '.agent/model-snapshot.json'));
}

const PLACEHOLDER = /\[[A-Za-z][^\]\n]{0,80}\](?!\()/g;

/**
 * Validate a parsed project-adapter.yml against the repository it belongs
 * to.
 *
 * @param {object} adapter    Parsed YAML, as loadAdapter() returns.
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]  Default process.cwd().
 * @param {object} [opts.env]      Default process.env — where a lab's API
 *   key would be found, checked only to warn, never to fail validation:
 *   a config can be structurally correct on a machine with no keys set at
 *   all (a design-time check, a CI job that only lints).
 * @param {string|null} [opts.remoteDefaultBranch]  The repository's default
 *   branch as its remote reports it (git-default-branch.mjs), or null when
 *   unknown. Passed in rather than read here so this stays free of git.
 * @param {boolean} [opts.snapshotIgnored]  Whether git ignores the model
 *   snapshot path (snapshotIgnoredBy() asks it). Passed in for the same reason.
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateAdapter(adapter, { repoRoot = process.cwd(), env = process.env, remoteDefaultBranch = null, snapshotIgnored = false } = {}) {
  const errors = [];
  const warnings = [];

  if (!adapter || typeof adapter !== 'object') {
    return { errors: ['No adapter object was given — nothing to validate.'], warnings: [] };
  }

  if (!adapter.project?.id) errors.push('project.id is required.');

  // A warning, not an error: a project may deliberately run the loop against
  // a staging branch. But the usual cause is init having recorded the setup
  // branch it was run on, and then every generation is cut from, and every
  // pull request opened against, a branch nothing deploys.
  // An effort the lab does not know is a 400 on every call to that seat.
  for (const seat of ['implement', 'review']) {
    const effort = adapter.roles?.[seat]?.effort;
    if (effort != null && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
      errors.push(`roles.${seat}.effort is \"${effort}\" — use low, medium, high, xhigh or max, or remove it.`);
    }
  }

  // The workflow commits the snapshot after every release check. If git
  // ignores it, that commit fails and, worse, the snapshot never persists:
  // every run records a fresh baseline and no release is ever detected,
  // while each cycle reads as a quiet one (Grammar Game, 2026-10-19).
  if (snapshotIgnored) {
    errors.push(`${snapshotPath(adapter) || '.agent/model-snapshot.json'} is git-ignored, so it can never be committed: every run would record a fresh baseline and no model release would ever be detected. Remove the .gitignore rule that matches it (often ".agent/").`);
  }

  const configuredBranch = adapter.project?.default_branch;
  if (remoteDefaultBranch && configuredBranch && configuredBranch !== remoteDefaultBranch) {
    warnings.push(`project.default_branch is "${configuredBranch}", but the repository's default branch is "${remoteDefaultBranch}". Generations are cut from, and pull requests opened against, "${configuredBranch}". If that is the branch init was run on rather than a deliberate choice, set it to "${remoteDefaultBranch}" and regenerate the workflow (node harness/cli/init.mjs --from-adapter --force).`);
  }

  // A half-specified goal throws from goalConfig() itself (a half-specified
  // goal silently ignored is worse than none, per its own doc comment).
  // Caught here so one malformed field doesn't take the rest of the checks
  // down with it.
  try {
    goalConfig(adapter);
  } catch (err) {
    errors.push(`project.goal: ${err.message}`);
  }

  const { allowedPaths, createOnlyPaths } = constitutionAllowlist(adapter);
  const guard = guardConfig(adapter);

  if (allowedPaths.length === 0) {
    errors.push('constitution.allowed_paths is empty — the agent has nothing it may edit.');
  }

  // context.providers: each must name a module inside the project that
  // exists, and none may ask for a lab key — the loop's credentials are the
  // one thing a provider must never see.
  const labKeys = new Set(registeredProviders().map((n) => getProvider(n)?.envKey).filter(Boolean));
  for (const [i, p] of (Array.isArray(adapter.context?.providers) ? adapter.context.providers : []).entries()) {
    const at = `context.providers[${i}]`;
    if (!p || typeof p.module !== 'string' || !p.module) { warnings.push(`${at} has no module — it is ignored.`); continue; }
    let absolute = null;
    try { absolute = resolveProviderModule({ repoRoot, module: p.module }); } catch { errors.push(`${at}.module "${p.module}" is outside the project.`); }
    if (absolute && !fs.existsSync(absolute)) warnings.push(`${at}.module "${p.module}" does not exist — the section will be skipped every run.`);
    for (const name of Array.isArray(p.env) ? p.env : []) {
      if (labKeys.has(name)) errors.push(`${at}.env names ${name}, a lab key. A context provider may not see the loop's credentials.`);
      else if (!/^[A-Z_][A-Z0-9_]*$/.test(String(name))) warnings.push(`${at}.env: "${name}" is not an environment variable name — it is ignored.`);
    }
  }

  const strategy = adapter.context?.strategy;
  if (strategy !== undefined && strategy !== null && strategy !== 'full-dump' && strategy !== 'scoped') {
    warnings.push(`context.strategy is "${strategy}" — use full-dump or scoped. Anything else runs as full-dump.`);
  }

  // Every editable path must actually exist. A typo here is a silent gap:
  // edit-format.mjs's compileAllowlist() would let the agent write to it if
  // asked, buildSourceBundle() would simply skip a file it can't read, and
  // a proposal could legitimately target a file nobody ever showed the
  // model — the exact incident learning/03-failure-modes.md Part 2 warns
  // against ("a file the agent may edit is a file the agent must have read").
  for (const p of allowedPaths) {
    if (isGlob(p)) {
      // `fs.existsSync("game/**")` is false however many files game/ holds —
      // it is a literal filename check. Checking a pattern means asking
      // whether it matches anything, which is also the honest question: a
      // pattern matching nothing is an editable surface that is empty today,
      // and the agent would be shown no source for it.
      if (expandGlob(p, { repoRoot }).length === 0) {
        errors.push(`constitution.allowed_paths: "${p}" matches no file in the repository. A pattern the agent may edit but that matches nothing gives it an empty editable surface — put the path under create_only_paths until something exists there.`);
      }
    } else if (!fs.existsSync(path.join(repoRoot, p))) {
      errors.push(`constitution.allowed_paths: "${p}" does not exist in the repository.`);
    }
  }

  // An allowed path that also matches a frozen or append-only glob is a
  // structural contradiction: edit-format.mjs would let the agent write it
  // in-process, and check-guarded-paths.mjs would then reject every single
  // proposal that actually touches it, in CI, for a reason baked in at
  // config time rather than found in the change.
  const frozenGlobs = guard.frozenPaths.map((raw) => ({ raw, re: globToRegExp(raw) }));
  const appendOnlyGlobs = guard.appendOnlyPaths.map((raw) => ({ raw, re: globToRegExp(raw) }));
  for (const p of allowedPaths) {
    const frozenHit = frozenGlobs.find((g) => g.re.test(p));
    if (frozenHit) {
      errors.push(`"${p}" is in constitution.allowed_paths and also matches frozen_paths ("${frozenHit.raw}") — every proposal that edits it would pass the allowlist and then fail the guard in CI.`);
    }
    const appendOnlyHit = appendOnlyGlobs.find((g) => g.re.test(p));
    if (appendOnlyHit) {
      errors.push(`"${p}" is in constitution.allowed_paths and also matches append_only_paths ("${appendOnlyHit.raw}") — an edit to it (as opposed to a new file) would fail the guard in CI.`);
    }
  }

  // .github/** should be frozen unless a project has deliberately chosen
  // to make some part of it editable (an allowed_path or create_only_path
  // under .github/ is treated as that deliberate override — the console's
  // own §2.3 argument for why a toggle for something nothing reads is
  // worse than no toggle, applied here to the opposite failure: a freeze
  // that isn't actually in place).
  const overridden = [...allowedPaths, ...createOnlyPaths].some((p) => p.startsWith('.github/'));
  const githubFrozen = frozenGlobs.some((g) => g.re.test('.github/workflows/self-improve.yml'));
  if (!githubFrozen && !overridden) {
    warnings.push('constitution.frozen_paths does not appear to cover .github/** — an autonomous change could rewrite its own workflow definition. Add ".github/**" to frozen_paths, or list a path under .github/ in allowed_paths if that is deliberate.');
  }

  // A test command that needs installed dependencies, in a COPIED install
  // with nothing to install them. This is not theoretical: the first real
  // install on a jest project had `npm run test:unit` as its preflight gate,
  // no setup commands, and no other step that installs anything — preflight
  // exited 127 (command not found) and every generation was skipped before
  // it started. A shared install is exempt: it runs setup_commands from the
  // adapter on every run.
  //
  // Heuristic on purpose, and it warns rather than fails: plenty of suites
  // need no install at all (`node --test`, `go test`), and the harness should
  // not invent a dependency step for them.
  const testCommands = adapter?.evaluation?.test_commands ?? [];
  const setupCommands = adapter?.evaluation?.setup_commands ?? [];
  const NEEDS_INSTALL = /^\s*(npm|npx|yarn|pnpm|bun|jest|vitest|mocha|pytest|poetry|bundle|rake|mvn|gradle)\b/;
  const needsInstall = testCommands.filter((c) => NEEDS_INSTALL.test(String(c)));
  if (!adapter?.harness?.shared && needsInstall.length && !setupCommands.length) {
    warnings.push(
      `evaluation.test_commands runs "${needsInstall[0]}", which needs this project's dependencies installed, ` +
      'but evaluation.setup_commands is empty and a copied installation has no other step that installs them. ' +
      'Preflight will exit 127 and every generation will be skipped. Add the command your own CI uses ' +
      '(for example `- npm ci --ignore-scripts`) under evaluation.setup_commands, then regenerate the workflow ' +
      'with `node harness/cli/init.mjs --from-adapter --force`.'
    );
  }

  // Brief files: must exist (run-generation.mjs would otherwise fail at the
  // very start of a run), and a leftover [placeholder] is sent to a model
  // verbatim as part of its system prompt — a warning, not an error, since
  // a partially-filled brief is a legitimate state while still setting one
  // up.
  const briefs = briefPaths(adapter);
  for (const [label, rel] of [
    ['roles.agent_brief_path', briefs.agentBriefPath],
    ['roles.reviewer_brief_path', briefs.reviewerBriefPath],
  ]) {
    if (!rel) {
      errors.push(`${label} is not set.`);
      continue;
    }
    const absolute = path.join(repoRoot, rel);
    if (!fs.existsSync(absolute)) {
      errors.push(`${label}: "${rel}" does not exist.`);
      continue;
    }
    const text = fs.readFileSync(absolute, 'utf8');
    const placeholders = [...text.matchAll(PLACEHOLDER)].map((m) => m[0]);
    if (placeholders.length) {
      warnings.push(`${label} ("${rel}") still has ${placeholders.length} unfilled placeholder(s), e.g. ${placeholders[0]} — a model reads these verbatim as part of its instructions.`);
    }
  }

  // providers.watched must name labs this harness actually knows how to
  // call — an unregistered name is silently ignored by
  // check-model-releases.mjs (it just never watches that lab) unless
  // caught here.
  const watched = watchedProviders(adapter) ?? [];
  for (const name of watched) {
    if (!getProvider(name)) errors.push(`providers.watched: "${name}" is not a registered provider.`);
  }

  // The three pinned seats must resolve to a lab this harness has a
  // provider file for, the same check init.mjs already warns about at
  // scaffold time — repeated here so a hand-edited adapter gets the same
  // scrutiny a freshly generated one did.
  const roles = rolesConfig(adapter);
  const neededProviders = new Set(watched.filter((name) => getProvider(name)));
  for (const [seat, model, named] of [
    ['implement', roles.implementModel, roles.implementProvider],
    ['review', roles.reviewModel, roles.reviewProvider],
    ['rank', roles.rankModel, roles.rankProvider],
  ]) {
    if (!model) {
      // A named lab with no model beside it configures nothing and will be
      // ignored at run time, which is worth saying out loud rather than
      // letting someone believe the seat was set.
      if (named) warnings.push(`roles.${seat}.provider: "${named}" is set but roles.${seat}.model is empty — this seat is not pinned.`);
      continue;
    }
    // An explicitly named lab is the answer, not a hint: it exists so a
    // model released after this harness was written can fill a seat at all.
    // It only has to be a lab this harness can actually call.
    if (named) {
      if (getProvider(named)) neededProviders.add(named);
      else errors.push(`roles.${seat}.provider: "${named}" is not a registered provider.`);
      continue;
    }
    try {
      neededProviders.add(resolveProvider(model));
    } catch {
      warnings.push(`roles.${seat}.model: "${model}" does not resolve to a registered provider — a run will fail the moment it reaches this seat. Name its lab in roles.${seat}.provider.`);
    }
  }

  // Every lab this adapter will actually call, watched or pinned, needs its
  // key set somewhere this process can see it. A warning, not an error:
  // this is exactly as true on a machine with no keys at all (a lint-only
  // check, a CI job that only validates) as it is on one about to run for
  // real, and only the second of those should be alarming.
  for (const name of neededProviders) {
    const provider = getProvider(name);
    if (provider && !env[provider.envKey]) {
      warnings.push(`${name}: ${provider.envKey} is not set in this environment — a run needs it to reach this lab.`);
    }
  }

  return { errors, warnings };
}
