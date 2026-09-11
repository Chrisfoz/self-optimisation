/**
 * A generation's identity: which number it gets, which run produced it, and
 * how that number is claimed so two runs cannot both have it.
 *
 * The number used to come from `git tag -l 'gen-*'` alone. Only the
 * autonomous-merge path ever tags, so on the default pull-request path every
 * run was generation 001: the same branch name, the same record directory,
 * each run's record overwriting the last. Nothing in the loop can learn from
 * a history that keeps being erased, and the failures (which never merge,
 * so were never tagged on either path) were the part erased first.
 *
 * Now the next number is one past the highest seen in ANY of the places a
 * generation leaves a trace:
 *   - a `gen-NNN` tag (autonomous merge)
 *   - an `agent/gen-NNN` branch, local or remote (every path — it is
 *     reserved before anything else happens, see reserveGeneration())
 *   - a `gen-NNN/` record directory on the default branch (every outcome,
 *     now that harness/scripts/persist-records.mjs commits the record
 *     whether or not the change shipped)
 * and it is claimed by creating the branch with a lease that says "this ref
 * must not exist yet", so a race between two runs is lost by one of them
 * visibly, rather than won by both.
 */

import { padGeneration } from './generate-themes.mjs';

const GEN = /(?:^|\/)gen-(\d+)(?:$|\/)/;

/** The generation number a ref or path names, or null. `gen-012`, `origin/agent/gen-012`, `docs/generations/gen-012` all give 12. */
export function generationOf(name) {
  const m = String(name).trim().match(GEN);
  return m ? Number(m[1]) : null;
}

/**
 * Pure: the highest generation number named anywhere in these lists.
 * @param {{tags?: string[], branches?: string[], recordDirs?: string[]}} seen
 */
export function highestGeneration({ tags = [], branches = [], recordDirs = [] } = {}) {
  let max = 0;
  for (const name of [...tags, ...branches, ...recordDirs]) {
    const n = generationOf(name);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

const lines = (text) => String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);

/**
 * Everything the repository knows about generations so far.
 * @param {(...args: string[]) => string} git
 * @param {{generationsDir?: string, baseRef?: string|null}} [opts]
 *   `baseRef` is the ref whose tree holds the records (e.g. `origin/main`,
 *   or `main` for a local rehearsal). Read with `git ls-tree`, not from the
 *   working tree, because by the time this runs the working tree may be an
 *   agent branch that does not carry them.
 */
export function collectGenerationTraces(git, { generationsDir = 'docs/generations', baseRef = null } = {}) {
  const safe = (...args) => { try { return git(...args); } catch { return ''; } };
  const tags = lines(safe('tag', '-l', 'gen-*'));
  const branches = lines(safe('branch', '-a', '--list', '*agent/gen-*', '--format=%(refname:short)'));
  const refs = [...new Set([baseRef, 'HEAD'].filter(Boolean))];
  const recordDirs = refs.flatMap((ref) => lines(safe('ls-tree', '--name-only', `${ref}:${generationsDir}`)));
  return { tags, branches, recordDirs };
}

/**
 * @param {(...args: string[]) => string} git
 * @param {{generationsDir?: string, baseRef?: string|null}} [opts]
 * @returns {string} zero-padded, e.g. "007"
 */
export function nextGenerationNumber(git, opts = {}) {
  return padGeneration(highestGeneration(collectGenerationTraces(git, opts)) + 1);
}

/**
 * Claim a generation number by creating its branch, retrying upward on a
 * collision.
 *
 * With a remote, the branch is pushed with `--force-with-lease=<ref>:` —
 * an empty expected value, which git treats as "only if this ref does not
 * exist on the remote". Plain `git push` would happily fast-forward an
 * existing branch another run had already claimed. Without a remote (a
 * local rehearsal), `git branch` refuses an existing name the same way.
 *
 * What is pushed is a CLAIM COMMIT — empty, on top of HEAD, naming the run —
 * never HEAD itself. Two runs that start from the same default-branch
 * commit would otherwise push the same SHA to the same branch, and git
 * reports that as "Everything up-to-date" without ever evaluating the lease:
 * both runs would believe they had won. A commit unique to this run makes
 * the second push a real update, which the lease then refuses. The agent
 * branch starts from it, so it also records which run owns the branch.
 *
 * @param {(...args: string[]) => string} git
 * @param {object} opts
 * @param {string} opts.start          The first number to try, e.g. from nextGenerationNumber().
 * @param {string|null} [opts.remote]  e.g. "origin"; null for local-only.
 * @param {string|null} [opts.runId]   Written into the claim commit's message.
 * @param {number} [opts.attempts]     How many numbers to try before giving up.
 * @returns {{number: string, branch: string, collisions: string[]}}
 */
export function reserveGeneration(git, { start, remote = null, runId = null, attempts = 5 }) {
  const collisions = [];
  let n = Number(start);
  for (let i = 0; i < attempts; i++, n++) {
    const number = padGeneration(n);
    const branch = `agent/gen-${number}`;
    try {
      if (remote) {
        const claim = git('commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m',
          `Claim generation ${number}${runId ? ` for run ${runId}` : ''}\n\nNonce: ${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`);
        git('push', '--quiet', `--force-with-lease=refs/heads/${branch}:`, remote, `${claim}:refs/heads/${branch}`);
        git('branch', '--quiet', '--force', branch, claim);
      } else {
        git('branch', '--quiet', branch, 'HEAD');
      }
      return { number, branch, collisions };
    } catch {
      collisions.push(number);
    }
  }
  throw new Error(`Could not reserve a generation branch: agent/gen-${collisions.join(', agent/gen-')} all already exist. Another run is probably active.`);
}

/**
 * Which run produced a record. On GitHub Actions, the run id plus its
 * attempt number (a re-run of the same run is a different attempt and must
 * not be mistaken for the first); anywhere else, a local id that is unique
 * enough to tell two rehearsals apart.
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {Date} [now]
 * @returns {{id: string, url: string|null, source: 'github-actions'|'local'}}
 */
export function runIdentity(env = process.env, now = new Date()) {
  if (env.RUN_ID) return { id: env.RUN_ID, url: env.RUN_URL || null, source: env.GITHUB_RUN_ID ? 'github-actions' : 'local' };
  if (env.GITHUB_RUN_ID) {
    const attempt = env.GITHUB_RUN_ATTEMPT || '1';
    const url = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${attempt}`
      : null;
    return { id: `${env.GITHUB_RUN_ID}-${attempt}`, url, source: 'github-actions' };
  }
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return { id: `local-${stamp}-${process.pid}`, url: null, source: 'local' };
}
