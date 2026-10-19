/**
 * One command that says whether an installation is ready, and for everything
 * that is not, the exact command that fixes it. Before this the same answers
 * were spread over validate.mjs, check-keys.mjs, `init --check-upgrade` and a
 * `gh api` call the README spelled out by hand.
 *
 * Every dependency with a side (git, gh, the network, the lab APIs) arrives
 * in `deps`, so the checks are tested without any of them. The order is the
 * order a person fixes things in: nothing downstream of a missing adapter is
 * worth reporting until the adapter exists.
 *
 * A check is `{name, status: 'ok'|'fail'|'warn'|'skip', detail, fix?}`. Only
 * `fail` makes the command exit non-zero: a warning is true and worth
 * knowing, but not a reason the schedule cannot run.
 */

import { validateAdapter } from './validate.mjs';
import { answersFromAdapter, requiredProviders } from './scaffold.mjs';
import { normalizeApprovalClass, snapshotPath as adapterSnapshotPath } from './adapter.mjs';
import { repoSlug, ghReady, listSecretNames, readWorkflowPermissions } from './github-setup.mjs';
import { compareVersions } from './version.mjs';

export const MIN_NODE = '22.11.0';
export const ENV_FILE = 'harness/.env.harness.local';

/**
 * @param {object} deps
 * @param {string} deps.nodeVersion         process.versions.node
 * @param {string} deps.repoRoot
 * @param {(p: string) => boolean} deps.exists   relative to repoRoot
 * @param {(args: string[]) => {status: number|null, stdout: string}} deps.git
 * @param {Function} deps.gh               a github-setup.mjs runner
 * @param {object|null} deps.adapter        parsed, or null when absent
 * @param {string|null} [deps.adapterError] a parse failure
 * @param {Record<string,string>|null} deps.env   the parsed env file, or null when absent
 * @param {(providers: string[]) => Promise<{results: {provider: string, envKey: string, state: string, detail?: string}[]}>} [deps.checkKeys]
 * @param {() => Promise<{local: string, upstream: string|null, behind: boolean|null, error?: string}>} [deps.checkUpgrade]
 * @param {(model: string) => string|null} deps.modelProvider
 * @param {(name: string) => string} deps.providerEnvKey
 * @param {boolean} [deps.offline]          skip everything that calls out
 * @param {string|null} [deps.remoteDefaultBranch]
 */
export async function runChecks(deps) {
  const checks = [];
  const add = (name, status, detail, fix) => checks.push({ name, status, detail, ...(fix ? { fix } : {}) });

  // --- Node ---------------------------------------------------------------
  const nodeOk = compareVersions(deps.nodeVersion, MIN_NODE) >= 0;
  add('Node', nodeOk ? 'ok' : 'fail', `v${deps.nodeVersion}${nodeOk ? '' : ` — ${MIN_NODE} or newer is needed`}`,
    nodeOk ? null : `Install Node ${MIN_NODE}+ from https://nodejs.org, then open a new terminal.`);

  // --- The adapter ---------------------------------------------------------
  if (deps.adapterError) {
    add('Adapter', 'fail', `project-adapter.yml could not be parsed: ${deps.adapterError}`, 'Fix the YAML, then: node harness/scripts/validate.mjs');
    return checks;
  }
  if (!deps.adapter) {
    add('Adapter', 'fail', 'no project-adapter.yml here', 'node harness/cli/init.mjs --quick');
    return checks;
  }
  // The keys come from the env file, not the shell this runs in — the same
  // place a local run reads them from.
  const { errors, warnings } = validateAdapter(deps.adapter, { repoRoot: deps.repoRoot, env: deps.env || {}, remoteDefaultBranch: deps.remoteDefaultBranch ?? null });
  if (errors.length) add('Adapter', 'fail', `${errors.length} error(s): ${errors[0]}${errors.length > 1 ? ' …' : ''}`, 'node harness/scripts/validate.mjs');
  else add('Adapter', warnings.length ? 'warn' : 'ok', warnings.length ? `valid, ${warnings.length} warning(s): ${warnings[0]}` : 'valid',
    warnings.length ? 'node harness/scripts/validate.mjs' : null);

  const answers = answersFromAdapter(deps.adapter, { providerEnvKey: deps.providerEnvKey, modelProvider: deps.modelProvider });
  const labs = requiredProviders(answers);
  const needed = [...labs.map((p) => p.envKey), ...(answers.notify?.envKey ? [answers.notify.envKey] : [])];
  const shared = Boolean(answers.sharedHarness);
  const pullRequests = normalizeApprovalClass(answers.approvalClass) !== 'autonomous-merge';

  // --- The workflow ---------------------------------------------------------
  const workflow = deps.exists('.github/workflows/self-improve.yml');
  add('Workflow', workflow ? 'ok' : 'fail', workflow ? '.github/workflows/self-improve.yml' : 'no generated workflow',
    workflow ? null : 'node harness/cli/init.mjs --from-adapter');

  // --- The env file ---------------------------------------------------------
  if (!deps.env) {
    add('Env file', 'fail', `${ENV_FILE} does not exist`, `node harness/cli/init.mjs --from-adapter (it writes the file), then paste your keys in`);
  } else {
    const ignored = deps.git(['check-ignore', '-q', ENV_FILE]);
    if (ignored.status === 0) add('Env file', 'ok', `${ENV_FILE}, git-ignored`);
    else if (ignored.status === 1) add('Env file', 'fail', `${ENV_FILE} is NOT git-ignored — a commit would publish your keys`, 'Add `.env.*` and `!.env.harness.example` to .gitignore, then: git check-ignore -v ' + ENV_FILE);
    else add('Env file', 'warn', `${ENV_FILE} exists; could not ask git whether it is ignored (not a git repository?)`);
  }

  // --- The keys -------------------------------------------------------------
  const env = deps.env || {};
  const absent = needed.filter((k) => !env[k] || !String(env[k]).trim());
  if (absent.length) {
    add('Keys', 'fail', `blank or missing in ${ENV_FILE}: ${absent.join(', ')}`, `Paste them into ${ENV_FILE}`);
  } else if (deps.offline || !deps.checkKeys) {
    add('Keys', 'skip', `all ${needed.length} present; not tried (--offline)`);
  } else {
    const { results } = await deps.checkKeys(labs.map((p) => p.name));
    const bad = results.filter((r) => r.state === 'rejected' || r.state === 'blank');
    add('Keys', bad.length ? 'fail' : 'ok',
      bad.length ? bad.map((r) => `${r.envKey}: ${r.detail || r.state}`).join('; ') : `all ${needed.length} accepted`,
      bad.length ? `node --env-file=${ENV_FILE} harness/scripts/check-keys.mjs` : null);
  }

  // --- The model snapshot -----------------------------------------------------
  const snapshot = adapterSnapshotPath(deps.adapter) || '.agent/model-snapshot.json';
  if (deps.git(['check-ignore', '-q', snapshot]).status === 0) {
    add('Snapshot', 'fail', `${snapshot} is git-ignored — it never persists, so every run records a fresh baseline and no release is ever detected`, `Remove the rule that ignores ${snapshot} from .gitignore`);
  } else if (deps.git(['ls-files', '--error-unmatch', snapshot]).status === 0) {
    add('Snapshot', 'ok', `${snapshot}, committed`);
  } else {
    add('Snapshot', 'warn', `${snapshot} is not committed yet — the first run writes and commits it`);
  }

  // --- GitHub ----------------------------------------------------------------
  const slug = repoSlug(answers.repository);
  if (deps.offline) {
    add('GitHub', 'skip', 'not checked (--offline)');
  } else if (!slug) {
    add('GitHub', 'warn', 'project.repository is not a GitHub repository, so its settings were not checked');
  } else if (!ghReady(deps.gh)) {
    add('GitHub', 'skip', 'GitHub CLI not installed or not signed in, so secrets and permissions were not checked', 'gh auth login');
  } else {
    const secrets = listSecretNames(deps.gh, slug);
    if (secrets.error) add('Secrets', 'warn', `could not list ${slug}'s secrets: ${secrets.error}`);
    else {
      const missing = needed.filter((n) => !secrets.names.includes(n));
      add('Secrets', missing.length ? 'fail' : 'ok', missing.length ? `not set on ${slug}: ${missing.join(', ')}` : `all ${needed.length} set on ${slug}`,
        missing.length ? 'node harness/cli/init.mjs --configure-github' : null);
    }
    if (pullRequests) {
      const perms = readWorkflowPermissions(deps.gh, slug);
      if (perms.error) add('PR permission', 'warn', `could not read ${slug}'s workflow permissions: ${perms.error}`);
      else add('PR permission', perms.can_approve_pull_request_reviews ? 'ok' : 'fail',
        perms.can_approve_pull_request_reviews ? 'Actions may open pull requests' : 'Actions may NOT open pull requests — every generation would pass its gates and then stop',
        perms.can_approve_pull_request_reviews ? null : 'node harness/cli/init.mjs --configure-github');
    }
  }

  // --- The harness version ------------------------------------------------------
  if (shared) {
    add('Harness', 'ok', `shared, pinned at ${answers.sharedHarness.ref?.slice(0, 12)}`);
  } else if (deps.offline || !deps.checkUpgrade) {
    add('Harness', 'skip', 'upstream version not checked (--offline)');
  } else {
    const up = await deps.checkUpgrade();
    if (up.error || up.behind === null) add('Harness', 'warn', `local ${up.local}; could not compare with upstream${up.error ? ` (${up.error})` : ''}`);
    else if (up.behind) add('Harness', 'warn', `local ${up.local} is behind upstream ${up.upstream}`, 'Re-copy harness/ from the repository, then: node harness/cli/init.mjs --from-adapter --force');
    else add('Harness', 'ok', `${up.local}, current`);
  }

  return checks;
}

/** Terminal lines for a list of checks, and the exit code they add up to. */
export function report(checks) {
  const icon = { ok: '✅', fail: '❌', warn: '⚠️ ', skip: '·  ' };
  const width = Math.max(...checks.map((c) => c.name.length));
  const lines = [];
  for (const c of checks) {
    lines.push(`${icon[c.status]} ${c.name.padEnd(width)}  ${c.detail}`);
    if (c.fix && c.status !== 'ok') lines.push(`   ${' '.repeat(width)}  → ${c.fix}`);
  }
  const failed = checks.filter((c) => c.status === 'fail').length;
  lines.push('', failed ? `${failed} thing(s) to fix before the schedule should run.` : 'Ready.');
  return { lines, code: failed ? 1 : 0 };
}
