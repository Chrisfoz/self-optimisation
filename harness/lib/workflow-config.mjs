/**
 * What the shared workflow reads from a project's `project-adapter.yml`,
 * once, at the start of a run.
 *
 * A copied-in installation bakes these values into its own generated
 * workflow at scaffold time. The shared workflow (`renderSharedWorkflow()`
 * in scaffold.mjs) lives in the harness's repository instead and serves
 * every project, so it has to learn them per run. It keeps the rule
 * adapter.mjs's `evaluationConfig()` states for test commands: one source
 * of truth within a run. This is read from the default branch before any
 * agent change exists, saved, and every later step uses the saved copy —
 * never the adapter as the agent's branch may have left it.
 *
 * Every value here ends up in `$GITHUB_ENV` or a file a shell loop reads,
 * so each is checked for anything that could break out of one line or one
 * argument. A value that fails is an error, not something to clean up: an
 * adapter that asks for a branch called `main\nEVIL=1` should stop the run.
 */

import { approvalClass, constitutionAllowlist, evaluationConfig, snapshotPath, watchedProviders } from './adapter.mjs';

const BRANCH = /^[A-Za-z0-9._/-]+$/;
const PROVIDER = /^[a-z0-9-]+$/;
const UNSAFE_LINE = /[\r\n\0]/;

function line(label, value) {
  if (typeof value !== 'string' || !value.trim() || UNSAFE_LINE.test(value)) {
    throw new Error(`${label} must be a single, non-empty line.`);
  }
  return value;
}

function lines(label, list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error(`${label} must be a list.`);
  return list.map((value, i) => line(`${label}[${i}]`, value));
}

/**
 * @param {object|null} adapter  A parsed project-adapter.yml.
 * @returns {{defaultBranch: string, providersCsv: string, snapshotPath: string, generationsDir: string,
 *   approvalClass: string, notify: boolean, testCommands: string[], setupCommands: string[], editablePaths: string[]}}
 */
export function workflowConfig(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new Error('No project-adapter.yml was found to read.');

  const defaultBranch = line('project.default_branch', adapter.project?.default_branch || 'main');
  if (!BRANCH.test(defaultBranch) || defaultBranch.includes('..') || defaultBranch.startsWith('-')) {
    throw new Error(`project.default_branch "${defaultBranch}" is not a usable branch name.`);
  }

  const providers = watchedProviders(adapter) ?? [];
  for (const name of providers) {
    if (typeof name !== 'string' || !PROVIDER.test(name)) throw new Error(`providers.watched: "${name}" is not a provider name.`);
  }

  const { allowedPaths, createOnlyPaths } = constitutionAllowlist(adapter);
  const editablePaths = [...new Set(lines('constitution editable paths', [...allowedPaths, ...createOnlyPaths]))];

  return {
    defaultBranch,
    providersCsv: providers.join(','),
    snapshotPath: line('providers.snapshot_path', snapshotPath(adapter) || '.agent/model-snapshot.json'),
    generationsDir: line('context.generations_dir', adapter.context?.generations_dir || 'docs/generations'),
    // Normalised, so anything unrecognised is the pull-request path.
    approvalClass: approvalClass(adapter),
    notify: Boolean(adapter.notify),
    testCommands: lines('evaluation.test_commands', evaluationConfig(adapter).testCommands),
    setupCommands: lines('evaluation.setup_commands', adapter.evaluation?.setup_commands),
    editablePaths,
  };
}

/** The `KEY=value` lines the config step appends to `$GITHUB_ENV`. Values were checked by workflowConfig(). */
export function githubEnvLines(config) {
  return [
    `DEFAULT_BRANCH=${config.defaultBranch}`,
    `PROVIDERS_CSV=${config.providersCsv}`,
    `SNAPSHOT_PATH=${config.snapshotPath}`,
    `GENERATIONS_DIR=${config.generationsDir}`,
    `APPROVAL_CLASS=${config.approvalClass}`,
    `NOTIFY_CONFIGURED=${config.notify ? 'true' : 'false'}`,
  ].join('\n') + '\n';
}
