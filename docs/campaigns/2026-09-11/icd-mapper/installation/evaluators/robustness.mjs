/**
 * Data robustness — of eight awkward but legitimate mapping-file shapes
 * (a BOM, CRLF, latin-1, padded codes, short rows, blank lines, an extra
 * column), how many does icd_mapper.py read the row from, and how many crash
 * the whole file? Deterministic. Never gating.
 */

import path from 'node:path';
import { execFileSync } from 'node:child_process';

export async function evaluate({ repoRoot, config = {} }) {
  const python = config.python ?? (process.platform === 'win32' ? 'python' : 'python3');
  const out = execFileSync(python, [path.join(repoRoot, 'evaluators', 'robustness.py')], { cwd: repoRoot, encoding: 'utf8', timeout: 60000 });
  const r = JSON.parse(out.trim().split('\n').at(-1));
  return [
    { name: 'edge-case files whose row is recovered', value: r.recovered, unit: `of ${r.total}`, direction: 'higher', detail: r.details.join('; ').slice(0, 500) },
    { name: 'edge-case files that crash the reader', value: r.crashed, direction: 'lower' },
  ];
}

export default { name: 'robustness', evaluate };
