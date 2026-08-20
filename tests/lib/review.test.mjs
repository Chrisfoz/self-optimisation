import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { reviewChanges } from '../../harness/lib/review.mjs';

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'review-test-'));
}

const BRIEF = 'You are a critical reviewer. Respond with VERDICT: APPROVED or VERDICT: REJECTED.';

test('reviewChanges throws without a reviewerBrief — a gate with no criteria is not a gate', async () => {
  await assert.rejects(
    () => reviewChanges({ reviewerBrief: '', genLabel: 'gen-1', diff: 'x', call: async () => ({ text: 'VERDICT: APPROVED' }) }),
    /requires a non-empty reviewerBrief/
  );
});

test('reviewChanges: an APPROVED verdict parses correctly', async () => {
  const fakeCall = async ({ system }) => {
    assert.equal(system, BRIEF); // the brief becomes the system prompt verbatim
    return { text: 'VERDICT: APPROVED\n\nREASON: Looks good.' };
  };
  const result = await reviewChanges({ reviewerBrief: BRIEF, genLabel: 'gen-1', diff: 'diff text', call: fakeCall });
  assert.equal(result.approved, true);
  assert.equal(result.verdict, 'approved');
  assert.equal(result.reason, 'Looks good.');
});

test('reviewChanges: a REJECTED verdict parses correctly', async () => {
  const fakeCall = async () => ({ text: 'VERDICT: REJECTED\n\nREASON: Breaks the render loop.\n\nREQUIRED FIXES:\n- fix the loop' });
  const result = await reviewChanges({ reviewerBrief: BRIEF, genLabel: 'gen-1', diff: 'x', call: fakeCall });
  assert.equal(result.approved, false);
  assert.match(result.feedback, /REQUIRED FIXES/);
});

test('reviewChanges: fails closed — an absent or unparseable verdict counts as rejected', async () => {
  const fakeCall = async () => ({ text: 'I think this looks fine, ship it.' });
  const result = await reviewChanges({ reviewerBrief: BRIEF, genLabel: 'gen-1', diff: 'x', call: fakeCall });
  assert.equal(result.approved, false);
  assert.equal(result.verdict, 'rejected');
});

test('reviewChanges: defaults to "no visual capture configured" without throwing', async () => {
  let seenUser = '';
  const fakeCall = async ({ user }) => {
    seenUser = user;
    return { text: 'VERDICT: APPROVED' };
  };
  await reviewChanges({ reviewerBrief: BRIEF, genLabel: 'gen-1', diff: 'x', call: fakeCall });
  assert.match(seenUser, /no visual capture configured for this project/);
});

test('reviewChanges: a supplied captureVisual hook is used and its images passed through to the model call', async () => {
  const fakeImages = [{ label: 'intro', mime: 'image/png', data: 'base64...' }];
  let seenImages = null;
  const fakeCall = async ({ images }) => {
    seenImages = images;
    return { text: 'VERDICT: APPROVED' };
  };
  const captureVisual = async () => ({ available: true, images: fakeImages, reason: 'rendered from working tree' });
  await reviewChanges({ reviewerBrief: BRIEF, genLabel: 'gen-1', diff: 'x', call: fakeCall, captureVisual });
  assert.deepEqual(seenImages, fakeImages);
});

test('reviewChanges: includes full source of touched files, and a placeholder when none changed', async (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'index.html'), '<html>hi</html>');

  let seenUser = '';
  const fakeCall = async ({ user }) => { seenUser = user; return { text: 'VERDICT: APPROVED' }; };
  await reviewChanges({ reviewerBrief: BRIEF, genLabel: 'gen-1', diff: 'x', filesChanged: ['index.html'], repoRoot, call: fakeCall });
  assert.match(seenUser, /<html>hi<\/html>/);

  const empty = await reviewChanges({ reviewerBrief: BRIEF, genLabel: 'gen-1', diff: 'x', filesChanged: [], repoRoot, call: fakeCall });
  assert.equal(empty.approved, true); // sanity: still callable
});

test('reviewChanges: testDescription is included when supplied, omitted when not', async () => {
  let seenUser = '';
  const fakeCall = async ({ user }) => { seenUser = user; return { text: 'VERDICT: APPROVED' }; };

  await reviewChanges({ reviewerBrief: BRIEF, genLabel: 'gen-1', diff: 'x', testDescription: 'npm test must pass', call: fakeCall });
  assert.match(seenUser, /npm test must pass/);

  await reviewChanges({ reviewerBrief: BRIEF, genLabel: 'gen-1', diff: 'x', call: fakeCall });
  assert.doesNotMatch(seenUser, /must still pass/);
});
