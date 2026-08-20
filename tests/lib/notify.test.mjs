import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDigestSystemPrompt, buildGenerationDigestPrompt, buildEscalationDigestPrompt, parseEmailResponse,
  gatesBlock, blockedByLine, buildGenerationDigestEmail, buildEscalationNoticeEmail, sendViaSendGrid,
  registerSender, getSender,
} from '../../harness/lib/notify.mjs';

const BASE = { recipientName: 'Alex', projectDescription: 'a test project' };

// --- prompt building ---------------------------------------------------------

test('buildDigestSystemPrompt: works with no calibration examples (a fresh project)', () => {
  const prompt = buildDigestSystemPrompt(BASE);
  assert.match(prompt, /writing an email to Alex/);
  assert.match(prompt, /a test project/);
  assert.doesNotMatch(prompt, /EXAMPLE 1/);
});

test('buildDigestSystemPrompt: includes supplied calibration examples', () => {
  const prompt = buildDigestSystemPrompt({ ...BASE, calibrationExamples: ['A great example email body.'] });
  assert.match(prompt, /EXAMPLE 1:/);
  assert.match(prompt, /A great example email body\./);
});

test('buildGenerationDigestPrompt and buildEscalationDigestPrompt embed the facts', () => {
  assert.match(buildGenerationDigestPrompt('FACT LINE'), /FACT LINE/);
  assert.match(buildEscalationDigestPrompt('FACT LINE'), /FACT LINE/);
  assert.match(buildEscalationDigestPrompt('x'), /decide/i);
});

// --- parseEmailResponse ------------------------------------------------------

test('parseEmailResponse: parses a well-formed response', () => {
  const parsed = parseEmailResponse('SUBJECT: A good subject\nBODY:\nA long enough email body to pass the length check.');
  assert.equal(parsed.subject, 'A good subject');
  assert.match(parsed.body, /long enough email body/);
});

test('parseEmailResponse: rejects empty, missing SUBJECT, missing BODY, or a too-short body', () => {
  assert.throws(() => parseEmailResponse(''), /Empty response/);
  assert.throws(() => parseEmailResponse('BODY:\nsomething long enough here for the check'), /No SUBJECT/);
  assert.throws(() => parseEmailResponse('SUBJECT: x'), /No BODY/);
  assert.throws(() => parseEmailResponse('SUBJECT: x\nBODY:\ntoo short'), /too short/);
});

// --- computed facts -----------------------------------------------------------

test('gatesBlock: maps result to the right icon', () => {
  const block = gatesBlock([{ name: 'tests', result: 'success' }, { name: 'guard', result: 'failure' }, { name: 'deploy', result: 'skipped' }]);
  assert.match(block, /✅ tests/);
  assert.match(block, /❌ guard/);
  assert.match(block, /⏭️ deploy/);
});

test('blockedByLine: merged reports nothing was blocked, regardless of gate content', () => {
  assert.equal(blockedByLine({ merged: true, gates: [{ name: 'x', result: 'failure' }] }), 'It merged — nothing was blocked.');
});

test('blockedByLine: reports the first non-success gate, using its own note when supplied', () => {
  const gates = [
    { name: 'review', result: 'success' },
    { name: 'guard', result: 'failure', note: 'An automated file check, unrelated to the AI review.' },
    { name: 'test', result: 'failure' },
  ];
  assert.equal(blockedByLine({ merged: false, gates }), 'An automated file check, unrelated to the AI review.');
});

test('blockedByLine: falls back to a generic message when a failing gate has no note', () => {
  const gates = [{ name: 'test', result: 'failure' }];
  assert.equal(blockedByLine({ merged: false, gates }), 'Blocked by the "test" gate.');
});

test('blockedByLine: honestly unclear when nothing failed but it still did not merge', () => {
  const gates = [{ name: 'review', result: 'success' }];
  assert.match(blockedByLine({ merged: false, gates }), /genuinely unclear/);
});

test('blockedByLine: a skipped gate is not treated as a blocker', () => {
  const gates = [{ name: 'optional-step', result: 'skipped' }, { name: 'review', result: 'success' }];
  assert.match(blockedByLine({ merged: false, gates }), /genuinely unclear/);
});

// --- buildGenerationDigestEmail -----------------------------------------------

const GATES = [{ name: 'review', result: 'success' }, { name: 'merge', result: 'success' }];

test('buildGenerationDigestEmail: plain-language path wraps the prose with a banner, credits, gates and escalations', async () => {
  const call = async () => ({ text: 'SUBJECT: A great subject line\nBODY:\nA nicely written explanation of what happened, in plain language for a reader.' });
  const email = await buildGenerationDigestEmail(
    { ...BASE, genLabel: 'generation 001', scope: 'focused', merged: true, suggestModel: 'claude-opus-5', suggestProvider: 'anthropic', implementModel: 'claude-opus-5', selfImplemented: false, summary: 'Added a button', gates: GATES },
    { call }
  );
  assert.equal(email.subject, 'A great subject line');
  assert.match(email.body, /✅ MERGED — generation 001/);
  assert.match(email.body, /Suggested by:   claude-opus-5 \(anthropic\)/);
  assert.match(email.body, /A nicely written explanation/);
  assert.match(email.body, /✅ review/);
});

test('buildGenerationDigestEmail: falls back to the terse format when the model call throws', async () => {
  const call = async () => { throw new Error('network died'); };
  const email = await buildGenerationDigestEmail(
    { ...BASE, genLabel: 'generation 002', scope: 'focused', merged: false, summary: 'Nothing shipped', gates: [{ name: 'test', result: 'failure', note: 'a real reason' }] },
    { call }
  );
  assert.match(email.subject, /NOT MERGED/);
  assert.match(email.body, /Change: Nothing shipped/);
  // The terse fallback's gatesBlock() is name+icon only, by design — the
  // richer per-gate `note` is what the PLAIN-LANGUAGE path's facts block
  // carries to the model (via blockedByLine()), not something the terse
  // fallback itself renders. Confirm the icon made it through instead.
  assert.match(email.body, /❌ test/);
});

test('buildGenerationDigestEmail: falls back when the response is truncated', async () => {
  const call = async () => ({ text: 'incomplete...', truncated: true, stopReason: 'max_tokens' });
  const email = await buildGenerationDigestEmail(
    { ...BASE, genLabel: 'generation 003', scope: 'focused', merged: true, summary: 'x', gates: GATES },
    { call }
  );
  assert.match(email.subject, /MERGED/);
});

test('buildGenerationDigestEmail: falls back when the model response cannot be parsed', async () => {
  const call = async () => ({ text: 'not the right format at all' });
  const email = await buildGenerationDigestEmail(
    { ...BASE, genLabel: 'generation 004', scope: 'focused', merged: true, summary: 'x', gates: GATES },
    { call }
  );
  assert.match(email.subject, /MERGED/);
  assert.match(email.body, /Change: x/);
});

// --- buildEscalationNoticeEmail ------------------------------------------------

test('buildEscalationNoticeEmail: returns null when nothing was flagged', async () => {
  const result = await buildEscalationNoticeEmail({ ...BASE, genLabel: 'generation 001', flagged: [] });
  assert.equal(result, null);
});

test('buildEscalationNoticeEmail: plain-language path, subject prefixed with the flag emoji', async () => {
  const call = async () => ({ text: 'SUBJECT: Widen the token budget\nBODY:\nA clear explanation of the case and what to do about it, written out.' });
  const email = await buildEscalationNoticeEmail(
    { ...BASE, genLabel: 'generation 005', flagged: [{ id: 'esc-001', title: 'Widen the token budget', notification: 'The case text here.' }] },
    { call }
  );
  assert.equal(email.subject, '🚩 Widen the token budget');
  assert.match(email.body, /clear explanation/);
});

test('buildEscalationNoticeEmail: fallback path includes every flagged case verbatim', async () => {
  const call = async () => { throw new Error('down'); };
  const email = await buildEscalationNoticeEmail(
    {
      ...BASE, genLabel: 'generation 006',
      flagged: [
        { id: 'esc-001', title: 'Case one', notification: 'Notification text one.' },
        { id: 'esc-002', title: 'Case two', notification: 'Notification text two.' },
      ],
    },
    { call }
  );
  assert.match(email.subject, /2 escalations reached consensus/);
  assert.match(email.body, /Notification text one\./);
  assert.match(email.body, /Notification text two\./);
});

// --- sendViaSendGrid ------------------------------------------------------------

test('sendViaSendGrid: a 202 response resolves without throwing', async () => {
  const fetchImpl = async (url, opts) => {
    assert.equal(url, 'https://api.sendgrid.com/v3/mail/send');
    const body = JSON.parse(opts.body);
    assert.equal(body.subject, 'Hi');
    assert.equal(body.personalizations[0].to[0].email, 'you@example.com');
    return { status: 202 };
  };
  await sendViaSendGrid({ subject: 'Hi', body: 'Body text' }, { apiKey: 'key', from: { email: 'a@b.com', name: 'Bot' }, to: 'you@example.com', fetchImpl });
});

test('sendViaSendGrid: a non-202 response throws with the response body', async () => {
  const fetchImpl = async () => ({ status: 401, text: async () => 'Unauthorized' });
  await assert.rejects(
    () => sendViaSendGrid({ subject: 'x', body: 'y' }, { apiKey: 'bad', from: { email: 'a@b.com', name: 'Bot' }, to: 'you@example.com', fetchImpl }),
    /SendGrid error 401: Unauthorized/
  );
});

// --- sender registry ------------------------------------------------------------

test('getSender: "sendgrid" is registered by default and is sendViaSendGrid itself', () => {
  assert.equal(getSender('sendgrid'), sendViaSendGrid);
});

test('getSender: an unregistered name returns null rather than throwing', () => {
  assert.equal(getSender('does-not-exist'), null);
});

test('registerSender: a project can register its own sender under its own name', async () => {
  const calls = [];
  registerSender('test-webhook', async (email, config) => { calls.push({ email, config }); });

  const sender = getSender('test-webhook');
  await sender({ subject: 'Hi', body: 'Body' }, { apiKey: 'k', from: { email: 'a@b.com' }, to: 'you@example.com' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].email.subject, 'Hi');
  assert.equal(calls[0].config.to, 'you@example.com');
});
