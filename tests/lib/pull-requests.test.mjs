import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePullRequestUrl, normalizePullRequest, findUnsynced, recordPullRequestState, syncPullRequests } from '../../harness/lib/pull-requests.mjs';

function repoWith(records) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prs-'));
  for (const [gen, record] of Object.entries(records)) {
    const dir = path.join(repoRoot, 'docs/generations', `gen-${gen}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'attempts.json'), JSON.stringify(record, null, 2));
  }
  return repoRoot;
}

test('parsePullRequestUrl accepts a github.com PR URL and rejects anything else', () => {
  assert.deepEqual(parsePullRequestUrl('https://github.com/o/r/pull/12'), { owner: 'o', repo: 'r', number: 12 });
  assert.equal(parsePullRequestUrl('https://github.com/o/r/issues/12'), null);
  assert.equal(parsePullRequestUrl(null), null);
});

test('normalizePullRequest lowercases gh\'s state and refuses an unknown one', () => {
  const now = new Date('2026-09-02T10:00:00Z');
  assert.deepEqual(
    normalizePullRequest({ state: 'MERGED', mergedAt: '2026-09-01T00:00:00Z', closedAt: '2026-09-01T00:00:00Z', mergeCommit: { oid: 'abc' } }, { now }),
    { state: 'merged', mergedAt: '2026-09-01T00:00:00Z', closedAt: '2026-09-01T00:00:00Z', mergeCommit: 'abc', syncedAt: '2026-09-02' }
  );
  assert.equal(normalizePullRequest({ state: 'DRAFT?' }), null);
});

test('findUnsynced lists records with a URL and no final state, and skips the rest', (t) => {
  const repoRoot = repoWith({
    '001': { outcome: 'approved', pullRequestUrl: 'https://github.com/o/r/pull/1' },
    '002': { outcome: 'approved', pullRequestUrl: 'https://github.com/o/r/pull/2', pullRequest: { state: 'merged' } },
    '003': { outcome: 'approved', pullRequestUrl: 'https://github.com/o/r/pull/3', pullRequest: { state: 'open' } },
    '004': { outcome: 'abandoned' },
  });
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  assert.deepEqual(findUnsynced({ repoRoot }).map((u) => [u.genNumber, u.previousState]), [['001', null], ['003', 'open']]);
  assert.deepEqual(findUnsynced({ repoRoot: path.join(repoRoot, 'nowhere') }), []);
});

test('syncPullRequests writes back merged and closed states, re-checks open ones, and survives a failing gh call', (t) => {
  const repoRoot = repoWith({
    '001': { outcome: 'approved', pullRequestUrl: 'https://github.com/o/r/pull/1' },
    '002': { outcome: 'approved', pullRequestUrl: 'https://github.com/o/r/pull/2' },
    '003': { outcome: 'approved', pullRequestUrl: 'https://github.com/o/r/pull/3', pullRequest: { state: 'open' } },
    '004': { outcome: 'approved', pullRequestUrl: 'https://github.com/o/r/pull/4' },
  });
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const exec = (url) => {
    if (url.endsWith('/1')) return { state: 'MERGED', mergedAt: 'm', mergeCommit: { oid: 'sha1' } };
    if (url.endsWith('/2')) return { state: 'CLOSED', closedAt: 'c' };
    if (url.endsWith('/3')) return { state: 'OPEN' };
    throw new Error('gh: HTTP 502');
  };
  const result = syncPullRequests({ repoRoot, exec, now: new Date('2026-09-02T00:00:00Z') });
  assert.equal(result.checked, 4);
  assert.deepEqual(result.updated, [{ genNumber: '001', state: 'merged' }, { genNumber: '002', state: 'closed' }]);
  assert.deepEqual(result.failed.map((f) => f.genNumber), ['004']);
  const read = (g) => JSON.parse(fs.readFileSync(path.join(repoRoot, 'docs/generations', `gen-${g}`, 'attempts.json'), 'utf8'));
  assert.equal(read('001').pullRequest.mergeCommit, 'sha1');
  assert.equal(read('002').pullRequest.state, 'closed');
  assert.equal(read('003').pullRequest.state, 'open', 'unchanged open state is left alone');
  assert.equal(read('004').pullRequest, undefined);
  assert.equal(read('001').outcome, 'approved', 'nothing else in the record is touched');
});

test('recordPullRequestState fails loudly on a missing record', () => {
  assert.throws(() => recordPullRequestState({ repoRoot: os.tmpdir(), genNumber: '999', pullRequest: { state: 'merged' } }), /missing or not valid JSON/);
});
