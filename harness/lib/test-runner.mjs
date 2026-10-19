/**
 * Run a project's own test commands against the working tree, from inside
 * a generation — so a candidate change that breaks the tests is repaired in
 * the loop, with the failure in hand, rather than discovered by the
 * workflow's test step after the loop has already finished and nothing can
 * be done about it except abandon the run.
 *
 * Two properties this file exists to guarantee, because both are easy to
 * lose:
 *
 * 1. THE CHILD NEVER SEES A CREDENTIAL. In the loop, the tests run BEFORE
 *    the independent review, on code a model just wrote, in a process whose
 *    own environment holds every lab's API key. scrubEnv() removes anything
 *    shaped like a secret (and every key the provider registry knows about)
 *    before the child starts. A test suite that genuinely needs one names it
 *    in `evaluation.test_env_passthrough`, deliberately.
 *
 * 2. IT ALWAYS ENDS. Each command has a timeout, and on timeout the whole
 *    process tree is killed — not just the shell that `shell: true` put in
 *    front of it, which is what `child.kill()` alone would reach.
 *
 * Output is captured and kept as a TAIL (the end of a failing test run is
 * where the failure is), and everything returned for a prompt is fenced as
 * untrusted: test output is produced by code a model wrote, and can say
 * anything — including things addressed to the next model that reads it.
 */

import { spawn, spawnSync } from 'node:child_process';
import { fenceUntrusted } from './context-pack.mjs';

/**
 * Names that look like credentials, by convention — matched as whole
 * `_`-separated segments, so ANTHROPIC_API_KEY, NPM_TOKEN and GH_PAT go but
 * GIT_AUTHOR_NAME (which a suite that commits needs) and KEYBOARD_LAYOUT stay.
 */
const SECRET_NAME = /(^|_)(KEY|KEYS|TOKEN|TOKENS|SECRET|SECRETS|PASSWORD|PASSWD|PASS|PAT|CREDENTIAL|CREDENTIALS|AUTH|COOKIE|DSN)(_|$)/i;
/**
 * Whether a variable name looks like a credential. The one rule for it: the
 * test runner scrubs by it, and scaffold.mjs uses it to wire a provider's
 * variable from repository secrets rather than plaintext variables.
 */
export function isSecretName(name) {
  return SECRET_NAME.test(String(name ?? ''));
}

/** Variables that are only ever about the CI system's own authority. */
const CI_AUTHORITY = /^(ACTIONS_(ID_TOKEN|RUNTIME)_|GITHUB_TOKEN$|GH_TOKEN$|GH_ENTERPRISE_TOKEN$)/;

/**
 * A copy of `env` with every credential-shaped variable removed.
 * @param {Record<string, string|undefined>} env
 * @param {{keep?: string[], extraSecretNames?: string[]}} [opts]
 *   `keep`: names to pass through anyway (evaluation.test_env_passthrough).
 *   `extraSecretNames`: exact names to remove even if they don't look like
 *   secrets — the provider registry's envKeys.
 */
export function scrubEnv(env, { keep = [], extraSecretNames = [] } = {}) {
  const keepSet = new Set(keep);
  const extra = new Set(extraSecretNames);
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!keepSet.has(name) && (SECRET_NAME.test(name) || CI_AUTHORITY.test(name) || extra.has(name))) continue;
    out[name] = value;
  }
  return out;
}

function tail(text, max) {
  return text.length <= max ? text : `[… ${text.length - max} earlier characters omitted …]\n${text.slice(-max)}`;
}

function killTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { /* already gone */ }
}

function runOne(command, { cwd, env, timeoutMs, maxOutput }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, {
      cwd, env, shell: true,
      // Its own process group on POSIX, so a timeout can kill the group.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    const collect = (chunk) => {
      output += chunk;
      // Bound memory for a runaway suite; the tail is what matters.
      if (output.length > maxOutput * 4) output = output.slice(-maxOutput * 2);
    };
    child.stdout.setEncoding('utf8').on('data', collect);
    child.stderr.setEncoding('utf8').on('data', collect);
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.on('error', (err) => { output += `\n${err.message}`; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        command,
        exitCode: timedOut ? null : code,
        signal: signal ?? null,
        timedOut,
        durationMs: Date.now() - started,
        passed: !timedOut && code === 0,
        output: tail(output, maxOutput),
      });
    });
  });
}

/**
 * Run each command in order; stop at the first failure, the way a CI step
 * would.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string[]} opts.commands
 * @param {number} [opts.timeoutMs]      Per command. Default 10 minutes.
 * @param {Record<string,string>} [opts.env]  Already scrubbed; see scrubEnv().
 * @param {number} [opts.maxOutput]      Characters of output kept per command.
 * @returns {Promise<{passed: boolean, results: Array, durationMs: number}>}
 */
export async function runProjectTests({ repoRoot, commands, timeoutMs = 600000, env = scrubEnv(process.env), maxOutput = 6000 }) {
  const started = Date.now();
  const results = [];
  for (const command of commands) {
    const r = await runOne(command, { cwd: repoRoot, env, timeoutMs, maxOutput });
    results.push(r);
    if (!r.passed) break;
  }
  return { passed: results.length > 0 && results.every((r) => r.passed), results, durationMs: Date.now() - started };
}

/** Lines a test runner uses to say something failed, across the common ones. */
const FAILURE_LINE = /\b(FAIL(ED|URE)?|ERROR|Error|Exception|Traceback|AssertionError|assert(ion)?\b|not ok|✖|✗|panicked)\b/;

/**
 * The lines of a run's output that say what failed, or null if none do.
 * The tail of a failing run is not always where its failure is: the first
 * real campaign's suite printed its one FAIL line mid-run and then pages of
 * PASS lines, and the record kept 300 characters of PASS.
 */
export function failureExcerpt(output, { maxLines = 8, maxChars = 1200 } = {}) {
  const lines = String(output ?? '').split(/\r?\n/).filter((l) => FAILURE_LINE.test(l) && !/^\s*(PASS|ok)\b/.test(l));
  if (!lines.length) return null;
  return lines.slice(-maxLines).join('\n').slice(-maxChars);
}

/** The compact shape kept in attempts.json: what ran and how it ended, no output. */
export function summarizeTestRun(run) {
  if (!run) return null;
  return {
    passed: run.passed,
    durationMs: run.durationMs,
    commands: run.results.map((r) => ({ command: r.command, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs })),
  };
}

/**
 * The failing command and the tail of its output, for the implementer's
 * next attempt. Fenced: this text came out of code a model wrote.
 */
export function renderTestFailure(run) {
  const failed = run.results.find((r) => !r.passed);
  if (!failed) return null;
  const how = failed.timedOut ? 'timed out' : `exited ${failed.exitCode}${failed.signal ? ` (${failed.signal})` : ''}`;
  const excerpt = failureExcerpt(failed.output);
  return `\`${failed.command}\` ${how} after ${Math.round(failed.durationMs / 1000)}s.${excerpt ? `\n\nThe lines that report a failure:\n\n${fenceUntrusted('FAILING LINES', excerpt)}` : ''}\n\nThe end of its output:\n\n${fenceUntrusted('TEST OUTPUT', failed.output.trim() || '(no output)')}`;
}

/** One paragraph for the reviewer: which commands ran against this exact change, and that they passed. */
export function renderTestPass(run) {
  const lines = run.results.map((r) => `- \`${r.command}\` — passed in ${(r.durationMs / 1000).toFixed(1)}s`);
  return `The project's own test commands were run against the working tree these edits produced, and all passed:\n${lines.join('\n')}`;
}
