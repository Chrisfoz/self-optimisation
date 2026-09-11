import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { reviewChanges, parseVerdict, REVIEW_END_MARKER, REVIEW_CONTRACT } from '../../harness/lib/review.mjs';

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'review-test-'));
}

const BRIEF = 'You are a critical reviewer. Respond with VERDICT: APPROVED or VERDICT: REJECTED.';

test('reviewChanges throws without a reviewerBrief — a gate with no criteria is not a gate', async () => {
  await assert.rejects(
    () => reviewChanges({ reviewerBrief: '', genLabel: 'gen-1', diff: 'x', call: async () => ({ text: 'VERDICT: APPROVED\n\nEND OF REVIEW' }) }),
    /requires a non-empty reviewerBrief/
  );
});

test('reviewChanges: an APPROVED verdict parses correctly', async () => {
  const fakeCall = async ({ system }) => {
    assert.equal(system, BRIEF); // the brief becomes the system prompt verbatim
    return { text: 'VERDICT: APPROVED\n\nREASON: Looks good.\n\nEND OF REVIEW' };
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
    return { text: 'VERDICT: APPROVED\n\nEND OF REVIEW' };
  };
  await reviewChanges({ reviewerBrief: BRIEF, genLabel: 'gen-1', diff: 'x', call: fakeCall });
  assert.match(seenUser, /no visual capture configured for this project/);
});

test('reviewChanges: a supplied captureVisual hook is used and its images passed through to the model call', async () => {
  const fakeImages = [{ label: 'intro', mime: 'image/png', data: 'base64...' }];
  let seenImages = null;
  const fakeCall = async ({ images }) => {
    seenImages = images;
    return { text: 'VERDICT: APPROVED\n\nEND OF REVIEW' };
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
  const fakeCall = async ({ user }) => { seenUser = user; return { text: 'VERDICT: APPROVED\n\nEND OF REVIEW' }; };
  await reviewChanges({ reviewerBrief: BRIEF, genLabel: 'gen-1', diff: 'x', filesChanged: ['index.html'], repoRoot, call: fakeCall });
  assert.match(seenUser, /<html>hi<\/html>/);

  const empty = await reviewChanges({ reviewerBrief: BRIEF, genLabel: 'gen-1', diff: 'x', filesChanged: [], repoRoot, call: fakeCall });
  assert.equal(empty.approved, true); // sanity: still callable
});

test('reviewChanges: testDescription is included when supplied, omitted when not', async () => {
  let seenUser = '';
  const fakeCall = async ({ user }) => { seenUser = user; return { text: 'VERDICT: APPROVED\n\nEND OF REVIEW' }; };

  await reviewChanges({ reviewerBrief: BRIEF, genLabel: 'gen-1', diff: 'x', testDescription: 'npm test must pass', call: fakeCall });
  assert.match(seenUser, /npm test must pass/);

  await reviewChanges({ reviewerBrief: BRIEF, genLabel: 'gen-1', diff: 'x', call: fakeCall });
  assert.doesNotMatch(seenUser, /must still pass/);
});

// --- parseVerdict: one complete, validated verdict, or a rejection -----------

const COMPLETE_APPROVAL = `VERDICT: APPROVED\n\nREASON: Minimal and correct.\n\nDETAILS:\n- Correctness: fine\n\n${REVIEW_END_MARKER}`;

test('parseVerdict: a complete approval is approved', () => {
  const v = parseVerdict(COMPLETE_APPROVAL);
  assert.equal(v.approved, true);
  assert.equal(v.problem, null);
  assert.equal(v.reason, 'Minimal and correct.');
});

test('parseVerdict: a response cut off right after "VERDICT: APPROVED" is rejected (confirmed defect)', () => {
  // The old parser matched the first line and approved this.
  const v = parseVerdict('VERDICT: APPROVED\n\nREASON: The change is correct but the event handler');
  assert.equal(v.approved, false);
  assert.match(v.problem, /incomplete/);
});

test('parseVerdict: the provider truncation flag rejects even a well-formed approval', () => {
  const v = parseVerdict(COMPLETE_APPROVAL, { truncated: true });
  assert.equal(v.approved, false);
  assert.match(v.problem, /truncated/);
});

test('parseVerdict: approval followed by rejection is rejected, not decided by the first match (confirmed defect)', () => {
  const v = parseVerdict(`VERDICT: APPROVED\n\nOn reflection the loop never exits.\n\nVERDICT: REJECTED\n\n${REVIEW_END_MARKER}`);
  assert.equal(v.approved, false);
  assert.match(v.problem, /more than one verdict/);
});

test('parseVerdict: a second verdict phrased inline also counts as a contradiction', () => {
  const v = parseVerdict(`VERDICT: APPROVED\n\nREASON: fine. Final verdict: rejected, actually.\n\n${REVIEW_END_MARKER}`);
  assert.equal(v.approved, false);
});

test('parseVerdict: malformed verdict values are rejected', () => {
  for (const value of ['APPROVED WITH CHANGES', 'LGTM', 'approve', '']) {
    const v = parseVerdict(`VERDICT: ${value}\n\n${REVIEW_END_MARKER}`);
    assert.equal(v.approved, false, value);
    assert.ok(v.problem, value);
  }
});

test('parseVerdict: no verdict at all is rejected', () => {
  assert.equal(parseVerdict(`Looks good to me, ship it.\n\n${REVIEW_END_MARKER}`).approved, false);
});

test('parseVerdict: an approval that lists required fixes is contradictory and rejected', () => {
  const v = parseVerdict(`VERDICT: APPROVED\n\nREQUIRED FIXES:\n- guard the null case\n\n${REVIEW_END_MARKER}`);
  assert.equal(v.approved, false);
  assert.match(v.problem, /required fixes/);
});

test('parseVerdict: "REQUIRED FIXES: none" is an empty list, not a contradiction', () => {
  assert.equal(parseVerdict(`VERDICT: APPROVED\n\nREQUIRED FIXES:\n- none\n\n${REVIEW_END_MARKER}`).approved, true);
  assert.equal(parseVerdict(`VERDICT: APPROVED\nREQUIRED FIXES: n/a\n${REVIEW_END_MARKER}`).approved, true);
});

test('parseVerdict: markdown a model actually writes — bold, headings, a code fence — still parses', () => {
  assert.equal(parseVerdict(`**VERDICT: APPROVED**\n\n**REASON:** tidy.\n\n**${REVIEW_END_MARKER}**`).approved, true);
  assert.equal(parseVerdict(`## VERDICT: APPROVED\n\n${REVIEW_END_MARKER}`).approved, true);
  assert.equal(parseVerdict(`\`\`\`\nVERDICT: APPROVED\n\n${REVIEW_END_MARKER}\n\`\`\``).approved, true);
});

test('parseVerdict: a rejection needs no end marker — an incomplete rejection is still a rejection', () => {
  const v = parseVerdict('VERDICT: REJECTED\n\nREASON: breaks the save format');
  assert.equal(v.approved, false);
  assert.equal(v.problem, null, 'a real rejection, not an unreadable review');
  assert.equal(v.reason, 'breaks the save format');
});

test('reviewChanges: the response contract goes in the request, and the brief stays the whole system prompt', async () => {
  let seen;
  await reviewChanges({ reviewerBrief: BRIEF, genLabel: 'gen-1', diff: 'x', call: async (o) => { seen = o; return { text: COMPLETE_APPROVAL }; } });
  assert.equal(seen.system, BRIEF);
  assert.ok(seen.user.endsWith(REVIEW_CONTRACT));
});

test('reviewChanges: a truncated result from the provider is a rejection', async () => {
  const r = await reviewChanges({ reviewerBrief: BRIEF, genLabel: 'gen-1', diff: 'x', call: async () => ({ text: COMPLETE_APPROVAL, truncated: true }) });
  assert.equal(r.approved, false);
  assert.match(r.problem, /truncated/);
});
