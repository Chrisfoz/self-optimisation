import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, classifyStatusCode, summarizeApiIssues, ACTIONABLE_KINDS } from '../../harness/lib/api-errors.mjs';

test('classifyStatusCode: 401 is always invalid_key', () => {
  assert.equal(classifyStatusCode(401), 'invalid_key');
  assert.equal(classifyStatusCode(401, 'anything at all'), 'invalid_key');
});

test('classifyStatusCode: 402 is always billing', () => {
  assert.equal(classifyStatusCode(402), 'billing');
});

test('classifyStatusCode: 403 is billing only when the body says so, otherwise invalid_key', () => {
  assert.equal(classifyStatusCode(403, '{"error":"insufficient credit balance"}'), 'billing');
  assert.equal(classifyStatusCode(403, '{"error":"forbidden"}'), 'invalid_key');
});

test('classifyStatusCode: 429 is billing only when the body says so, otherwise rate_limited', () => {
  assert.equal(classifyStatusCode(429, '{"error":"insufficient_quota"}'), 'billing');
  assert.equal(classifyStatusCode(429, '{"error":"rate limit exceeded, try again in 2s"}'), 'rate_limited');
});

test('classifyStatusCode: an ordinary server error is neither', () => {
  assert.equal(classifyStatusCode(500, 'internal server error'), 'other');
  assert.equal(classifyStatusCode(503), 'other');
});

test('ApiError carries kind, provider and statusCode as real fields, not buried in the message', () => {
  const err = new ApiError('anthropic API error 401: {...}', { kind: 'invalid_key', provider: 'anthropic', statusCode: 401 });
  assert.equal(err.kind, 'invalid_key');
  assert.equal(err.provider, 'anthropic');
  assert.equal(err.statusCode, 401);
  assert.ok(err instanceof Error);
});

test('ApiError defaults statusCode to null for the missing-key case, which has no HTTP response', () => {
  const err = new ApiError('OPENAI_API_KEY is not set', { kind: 'missing_key', provider: 'openai' });
  assert.equal(err.statusCode, null);
});

test('summarizeApiIssues: keeps only actionable kinds, drops rate_limited and other', () => {
  const issues = summarizeApiIssues([
    { id: 'model-a', provider: 'openai', kind: 'invalid_key', statusCode: 401 },
    { id: 'model-b', provider: 'xai', kind: 'rate_limited', statusCode: 429 },
    { id: 'model-c', provider: 'google', kind: 'other', statusCode: 500 },
  ]);
  assert.deepEqual(issues.map((i) => i.provider), ['openai']);
});

test('summarizeApiIssues: dedupes by provider+kind and collects every model id that hit it', () => {
  const issues = summarizeApiIssues([
    { id: 'model-a', provider: 'openai', kind: 'billing', statusCode: 402 },
    { id: 'model-b', provider: 'openai', kind: 'billing', statusCode: 402 },
  ]);
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0].ids, ['model-a', 'model-b']);
});

test('summarizeApiIssues: ignores null/undefined entries and entries with no kind', () => {
  assert.deepEqual(summarizeApiIssues([null, undefined, { id: 'x', provider: 'openai' }]), []);
});

test('summarizeApiIssues: empty input gives an empty array', () => {
  assert.deepEqual(summarizeApiIssues([]), []);
  assert.deepEqual(summarizeApiIssues(undefined), []);
});

test('ACTIONABLE_KINDS is exactly the three kinds a user needs to act on', () => {
  assert.deepEqual([...ACTIONABLE_KINDS].sort(), ['billing', 'invalid_key', 'missing_key']);
});
