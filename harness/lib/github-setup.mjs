/**
 * The two GitHub settings an installation needs and a person most often gets
 * wrong: the repository secrets, and the "Allow GitHub Actions to create and
 * approve pull requests" tickbox — which, on the first real install, did not
 * save and said nothing (WORKPLAN I1). Done through the `gh` CLI when it is
 * there and signed in; otherwise the caller prints the manual steps.
 *
 * Every function takes a `gh` runner — `(args, {input}) => {status, stdout,
 * stderr}` — so tests never touch a real repository. `ghRunner()` is the real
 * one.
 *
 * Secret values go to `gh` on stdin, never in argv, where any process on the
 * machine could read them.
 */

import { spawnSync } from 'node:child_process';

/** The real runner. `status` is null when `gh` is not installed at all. */
export function ghRunner({ cwd = process.cwd() } = {}) {
  return (args, { input } = {}) => {
    const r = spawnSync('gh', args, { cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error?.message ?? '') };
  };
}

/** Installed and signed in. Anything else means "print the manual steps instead". */
export function ghReady(gh) {
  return gh(['auth', 'status']).status === 0;
}

/**
 * "owner/repo" from a repository URL or slug (https, ssh, or bare), or null.
 * @param {string} repository
 */
export function repoSlug(repository) {
  const m = String(repository || '').trim().match(/^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Set each named secret whose value is present and non-blank in `env`.
 * Blank or missing ones are reported, not set: an empty secret is the
 * quietest failure this system has (the step "succeeds" and calls nothing).
 *
 * @returns {{set: string[], missing: string[], failed: {name: string, error: string}[]}}
 */
export function setSecrets(gh, slug, names, env) {
  const out = { set: [], missing: [], failed: [] };
  for (const name of names) {
    const value = env[name];
    if (typeof value !== 'string' || !value.trim()) {
      out.missing.push(name);
      continue;
    }
    const r = gh(['secret', 'set', name, '--repo', slug], { input: value.trim() });
    if (r.status === 0) out.set.push(name);
    else out.failed.push({ name, error: (r.stderr || r.stdout).trim() || `gh exited ${r.status}` });
  }
  return out;
}

/** The repository's workflow-permission settings, or {error}. */
export function readWorkflowPermissions(gh, slug) {
  const r = gh(['api', `repos/${slug}/actions/permissions/workflow`]);
  if (r.status !== 0) return { error: (r.stderr || r.stdout).trim() || `gh exited ${r.status}` };
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { error: `unexpected response: ${r.stdout.slice(0, 200)}` };
  }
}

/**
 * Tick "Allow GitHub Actions to create and approve pull requests", keeping
 * the repository's existing default permission as it is — that radio applies
 * to every other workflow in the repository, and changing it is not this
 * installation's business. The generated workflow declares its own
 * permissions, so it works under either.
 *
 * Reads the setting back afterwards, because a save that silently did not
 * happen is exactly the failure this exists for.
 *
 * @returns {{ok: true, alreadySet: boolean} | {ok: false, error: string}}
 */
export function allowPullRequests(gh, slug) {
  const before = readWorkflowPermissions(gh, slug);
  if (before.error) return { ok: false, error: `could not read the workflow permissions: ${before.error}` };
  if (before.can_approve_pull_request_reviews === true) return { ok: true, alreadySet: true };

  const put = gh([
    'api', '-X', 'PUT', `repos/${slug}/actions/permissions/workflow`,
    '-f', `default_workflow_permissions=${before.default_workflow_permissions || 'read'}`,
    '-F', 'can_approve_pull_request_reviews=true',
  ]);
  if (put.status !== 0) return { ok: false, error: (put.stderr || put.stdout).trim() || `gh exited ${put.status}` };

  const after = readWorkflowPermissions(gh, slug);
  if (after.error) return { ok: false, error: `saved, but could not read it back: ${after.error}` };
  if (after.can_approve_pull_request_reviews !== true) {
    return { ok: false, error: 'GitHub accepted the change but the setting reads back as off. An organisation policy may be overriding it.' };
  }
  return { ok: true, alreadySet: false };
}

/** Names of the repository's Actions secrets, or {error}. Values are never readable, by design. */
export function listSecretNames(gh, slug) {
  const r = gh(['secret', 'list', '--repo', slug, '--json', 'name']);
  if (r.status !== 0) return { error: (r.stderr || r.stdout).trim() || `gh exited ${r.status}` };
  try {
    return { names: JSON.parse(r.stdout).map((s) => s.name) };
  } catch {
    return { error: `unexpected response: ${r.stdout.slice(0, 200)}` };
  }
}

/** The manual steps, for when `gh` is not available. */
export function manualSteps(slug, secretNames, { pullRequests }) {
  const where = slug ? `https://github.com/${slug}/settings` : 'your repository\'s Settings';
  const lines = [
    `Add these as repository secrets (${where}/secrets/actions → New repository secret):`,
    ...secretNames.map((n) => `  - ${n}`),
  ];
  if (pullRequests) {
    lines.push(
      '',
      `Then tick "Allow GitHub Actions to create and approve pull requests" at`,
      `${slug ? `https://github.com/${slug}/settings/actions` : 'Settings → Actions → General'} (Workflow permissions, at the bottom), and check it saved:`,
      `  gh api repos/${slug || 'OWNER/REPO'}/actions/permissions/workflow   → "can_approve_pull_request_reviews": true`,
    );
  }
  return lines.join('\n');
}
