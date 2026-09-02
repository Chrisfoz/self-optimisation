#!/usr/bin/env node

/**
 * Regenerate `<generationsDir>/REPORT.md` from the records. See
 * harness/lib/report.mjs. Run from the project root; the generated
 * workflow runs it at the top of every cycle and commits the result.
 *
 * Usage: node harness/scripts/report.mjs [--generations-dir <dir>] [--stdout]
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadAdapter, contextConfig } from '../lib/adapter.mjs';
import { loadRecords, computeMetrics, renderReport } from '../lib/report.mjs';
import { setOutput } from '../lib/gh-output.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--generations-dir') out.generationsDir = argv[++i];
    else if (argv[i] === '--stdout') out.stdout = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd();
const adapter = await loadAdapter();
const generationsDir = args.generationsDir || process.env.GENERATIONS_DIR || contextConfig(adapter).generationsDir || 'docs/generations';

const { records, malformed } = loadRecords({ repoRoot, generationsDir });
const metrics = computeMetrics(records);
const page = renderReport(metrics, { generationsDir, malformed });

if (args.stdout) {
  process.stdout.write(page);
} else {
  const relative = `${generationsDir}/REPORT.md`;
  fs.mkdirSync(path.join(repoRoot, generationsDir), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, relative), page, 'utf8');
  console.error(`Wrote ${relative} from ${records.length} record(s).`);
  setOutput('path', relative);
}
setOutput('generations', String(metrics.total));
setOutput('release-yield', `${metrics.releaseYield.kept}/${metrics.releaseYield.total}`);
process.exit(0);
