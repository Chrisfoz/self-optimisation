import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../harness/providers/index.mjs';
import { familyOf, seatFamilies, pickCrossFamilyRanker, describeSeats, promotionCandidate } from '../../harness/lib/seats.mjs';

test('familyOf resolves a registered id and returns null for an unknown one', () => {
  assert.equal(familyOf('claude-opus-5'), 'anthropic');
  assert.equal(familyOf('gpt-5'), 'openai');
  assert.equal(familyOf('totally-unknown-model'), null);
});

test('seatFamilies says which judges share the implementer\'s family', () => {
  const same = seatFamilies({ implementModel: 'claude-opus-5', reviewModel: 'claude-opus-5', rankModel: 'claude-opus-5' });
  assert.equal(same.reviewSharesFamily, true);
  assert.equal(same.rankSharesFamily, true);
  const split = seatFamilies({ implementModel: 'claude-opus-5', reviewModel: 'gpt-5', rankModel: 'gemini-3-pro' });
  assert.equal(split.reviewSharesFamily, false);
  assert.equal(split.rankSharesFamily, false);
});

test('pickCrossFamilyRanker: another lab with a key wins; the implementer\'s own lab and keyless labs never do', () => {
  const snapshot = {
    anthropic: ['claude-opus-5', 'claude-sonnet-5'],
    openai: ['gpt-5', 'gpt-5-mini', 'text-embedding-3-large'],
    google: ['gemini-3-pro'],
    _unfixable: { openai: { 'gpt-x': {} } },
  };
  const pick = pickCrossFamilyRanker({ implementModel: 'claude-opus-5', snapshot, hasKey: (p) => p !== 'google' });
  assert.deepEqual(pick, { id: 'gpt-5-mini', provider: 'openai' });
  const preferred = pickCrossFamilyRanker({ implementModel: 'claude-opus-5', snapshot, hasKey: () => true, prefer: ['google'] });
  assert.deepEqual(preferred, { id: 'gemini-3-pro', provider: 'google' });
});

test('pickCrossFamilyRanker: null when no other family is reachable, or the snapshot is empty', () => {
  assert.equal(pickCrossFamilyRanker({ implementModel: 'claude-opus-5', snapshot: { anthropic: ['claude-opus-5'] }, hasKey: () => true }), null);
  assert.equal(pickCrossFamilyRanker({ implementModel: 'claude-opus-5', snapshot: { openai: ['gpt-5'] }, hasKey: () => false }), null);
  assert.equal(pickCrossFamilyRanker({ implementModel: 'claude-opus-5', snapshot: {}, hasKey: () => true }), null);
  assert.equal(pickCrossFamilyRanker({ implementModel: 'claude-opus-5', snapshot: { openai: ['whisper-1', 'tts-1'] }, hasKey: () => true }), null);
});

test('describeSeats warns about a shared review family, and is quiet when the seats are split', () => {
  const shared = describeSeats({ implementModel: 'claude-opus-5', reviewModel: 'claude-opus-5', rankModel: 'gpt-5' });
  assert.equal(shared.warnings.length, 1);
  assert.match(shared.warnings[0], /review seat shares/);
  assert.match(shared.line, /rank gpt-5 \(openai\)/);
  const split = describeSeats({ implementModel: 'claude-opus-5', reviewModel: 'gpt-5', rankModel: 'gpt-5' });
  assert.deepEqual(split.warnings, []);
});

test('promotionCandidate: a rotating model whose own edits were approved and kept N times takes the seat; closed or reverted ones do not count', () => {
  const kept = (by) => ({ outcome: 'approved', selfImplemented: true, implementedBy: by });
  const records = [
    kept('gpt-5 (openai)'), kept('gpt-5 (openai)'), { ...kept('gpt-5 (openai)'), reverted: {} },
    kept('gemini-3-pro (google)'), kept('gemini-3-pro (google)'), kept('gemini-3-pro (google)'),
    { ...kept('gemini-3-pro (google)'), pullRequest: { state: 'closed' } },
    { outcome: 'approved', selfImplemented: false, implementedBy: 'claude-opus-5' },
    { outcome: 'abandoned', selfImplemented: true, implementedBy: 'grok-5 (xai)' },
  ];
  assert.deepEqual(promotionCandidate({ records, threshold: 3 }), { model: 'gemini-3-pro', provider: 'google', kept: 3 });
  assert.deepEqual(promotionCandidate({ records, threshold: 2 }), { model: 'gemini-3-pro', provider: 'google', kept: 3 });
  assert.equal(promotionCandidate({ records, threshold: 3, hasKey: (p) => p !== 'google' }), null);
  assert.equal(promotionCandidate({ records, threshold: 4 }), null);
  assert.equal(promotionCandidate({ records, threshold: 0 }), null);
  assert.equal(promotionCandidate({ records: [], threshold: 1 }), null);
});
