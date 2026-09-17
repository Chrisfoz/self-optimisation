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
import { constitutionAllowlist, guardConfig, briefPaths, rolesConfig, watchedProviders, goalConfig } from './adapter.mjs';
import { globToRegExp } from './glob.mjs';
import { resolveProvider, getProvider } from './llm-provider.mjs';

/**
 * A bracketed placeholder left over from a template — `[TRIGGER CONDITION]`,
 * `[the live thing]`, `[path]` — as opposed to a markdown link, which this
 * excludes by refusing to match a `]` immediately followed by `(`. Neither
 * brief template uses markdown links, so this has no known false positive
 * against them; a project that adds one to its own filled-in brief would.
 */
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
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateAdapter(adapter, { repoRoot = process.cwd(), env = process.env, remoteDefaultBranch = null } = {}) {
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

  // Every editable path must actually exist. A typo here is a silent gap:
  // edit-format.mjs's compileAllowlist() would let the agent write to it if
  // asked, buildSourceBundle() would simply skip a file it can't read, and
  // a proposal could legitimately target a file nobody ever showed the
  // model — the exact incident learning/03-failure-modes.md Part 2 warns
  // against ("a file the agent may edit is a file the agent must have read").
  for (const p of allowedPaths) {
    if (!fs.existsSync(path.join(repoRoot, p))) {
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
