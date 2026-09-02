#!/usr/bin/env node

/**
 * CLI entry point for harness/lib/guard.mjs. Run in CI against a branch an
 * agent owns — e.g. only when the PR's head ref starts with `agent/`, or
 * (per the reference implementation's pattern) unconditionally in the
 * autonomous merge job, which only ever runs on such a branch. Running this
 * against ordinary human work is not a safety measure, it's a false
 * alarm — see the doc comment on checkGuardedPaths() in guard.mjs.
 *
 * Usage: node harness/scripts/check-guarded-paths.mjs [baseRef] [--adapter <path>] [--max-files <n>] [--max-lines <n>]
 *
 * Configuration, in order of precedence — most specific wins:
 *
 *   1. CLI arg/flag           positional baseRef / --max-files / --max-lines
 *   2. Environment variable   GUARD_BASE_REF / GUARD_MAX_FILES / GUARD_MAX_LINES
 *   3. project-adapter.yml    constitution.frozen_paths / append_only_paths /
 *                             frozen_fields / churn_ceiling.max_files / .max_lines
 *   4. Built-in default       'origin/main' / 50 / 10000
 *
 * Exits 1 on any violation, 0 otherwise — the caller's job should fail the
 * build on a non-zero exit, not parse stdout for a verdict.
 */

import path from 'path';
import { checkGuardedPaths } from '../lib/guard.mjs';
import { execFileSync } from 'child_process';
import { loadAdapter, guardConfig, goalConfig, parseAdapterText } from '../lib/adapter.mjs';
import { globToRegExp } from '../lib/glob.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--adapter') out.adapter = argv[++i];
    else if (argv[i] === '--max-files') out.maxFiles = argv[++i];
    else if (argv[i] === '--max-lines') out.maxLines = argv[++i];
    else if (!argv[i].startsWith('--') && !out.baseRef) out.baseRef = argv[i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const adapterPath = args.adapter || process.env.PROJECT_ADAPTER_PATH || path.join(process.cwd(), 'project-adapter.yml');
const adapter = await loadAdapter(adapterPath);
if (adapter) console.error(`Using ${adapterPath}`);

const config = guardConfig(adapter);

const baseRef = args.baseRef || process.env.GUARD_BASE_REF || 'origin/main';
const maxFiles = Number(args.maxFiles || process.env.GUARD_MAX_FILES || config.maxFiles || 50);
const maxLines = Number(args.maxLines || process.env.GUARD_MAX_LINES || config.maxLines || 10000);

const result = checkGuardedPaths({
  baseRef,
  frozenPaths: config.frozenPaths.map(globToRegExp),
  appendOnlyPaths: config.appendOnlyPaths.map(globToRegExp),
  frozenFields: config.frozenFields,
  maxFiles,
  maxLines,
});

// The committed goal (docs/curiosity/C1) is frozen in the constitution
// the same way frozen_paths are: a model may argue with it through the
// escalation ledger and may never edit it. The adapter is YAML, which
// guard.mjs's frozen_fields (JSON) cannot read, so the comparison lives
// here: parse project.goal at the base ref and at HEAD, and refuse a
// difference. Checked only when the adapter file is in the diff.
const adapterRelative = path.relative(process.cwd(), adapterPath).split(path.sep).join('/');
try {
  const changed = execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`, '--', adapterRelative], { encoding: 'utf8' }).trim();
  if (changed) {
    const show = (ref) => { try { return execFileSync('git', ['show', `${ref}:${adapterRelative}`], { encoding: 'utf8' }); } catch { return null; } };
    const [beforeText, afterText] = [show(baseRef), show('HEAD')];
    const goalOf = async (text) => { try { return text === null ? null : goalConfig(await parseAdapterText(text)); } catch { return { unparseable: true }; } };
    const before = JSON.stringify(await goalOf(beforeText));
    const after = JSON.stringify(await goalOf(afterText));
    if (before !== after) {
      result.violations.push(`${adapterRelative}: project.goal is frozen — a model may argue against it through the escalation ledger, never edit it`);
      result.pass = false;
    }
  }
} catch (err) {
  console.error(`⚠️  Could not compare project.goal across refs: ${err.message}`);
}

console.log(`Guarded-path check against ${baseRef}`);
console.log(`  ${result.filesChanged} file(s) changed, ${result.linesChanged} line(s)\n`);

if (result.pass) {
  console.log('PASS — no guarded path was touched.');
  process.exit(0);
}

console.log('FAIL — this change is not allowed to be made autonomously:\n');
for (const v of result.violations) console.log(`  - ${v}`);
console.log('\nA human can make these changes directly. The agent cannot.');
process.exit(1);
