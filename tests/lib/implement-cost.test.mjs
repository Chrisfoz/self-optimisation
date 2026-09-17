import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../../harness/providers/index.mjs';
import { getProvider } from '../../harness/lib/llm-provider.mjs';
import { userBlocks } from '../../harness/providers/anthropic.mjs';
import { filesNamedIn, requestedFilesIn, implement, runGeneration } from '../../harness/lib/orchestrator.mjs';
import { compileAllowlist } from '../../harness/lib/edit-format.mjs';
import { createSpendLedger } from '../../harness/lib/spend.mjs';

// Two cost savings from the NetworkinAI install. The implementer was sent
// every editable file (~380k tokens) for changes touching one or two, and a
// retry or refinement reread all of it at full price.

const EDITABLE = ['venue.html', 'index.html', 'shared/venueCollision.js', 'services/aiService.js', 'README.md', 'docs/README.md'];

// --- which files a proposal names ------------------------------------------------

test('filesNamedIn: full paths, and bare names unique among the editable files', () => {
  const text = 'CHANGE: in venue.html, call registerSolid from `venueCollision.js`, and note it in services/aiService.js.';
  assert.deepEqual(filesNamedIn(text, EDITABLE), ['venue.html', 'shared/venueCollision.js', 'services/aiService.js']);
});

test('filesNamedIn: a bare name two editable files share only counts when written in full', () => {
  const shared = ['client/config.js', 'server/config.js'];
  assert.deepEqual(filesNamedIn('update config.js', shared), []);
  assert.deepEqual(filesNamedIn('update server/config.js', shared), ['server/config.js']);
  // A root file's path is its name, so writing it is writing it in full, and
  // does not also pick up the nested file of the same name.
  assert.deepEqual(filesNamedIn('update README.md', EDITABLE), ['README.md']);
  assert.deepEqual(filesNamedIn('update docs/README.md', EDITABLE), ['docs/README.md']);
});

test('filesNamedIn: not fooled by a longer name that contains an editable one', () => {
  assert.deepEqual(filesNamedIn('see myvenue.html and venue.html.bak and venue.htmlx', EDITABLE), []);
  assert.deepEqual(filesNamedIn('ends a sentence: venue.html.', EDITABLE), ['venue.html']);
});

test('requestedFilesIn: reads the NEED FILES line only, and only editable paths', () => {
  const text = 'I cannot see the collision code.\nNEED FILES: shared/venueCollision.js, secrets.env\nThanks, index.html was fine.';
  assert.deepEqual(requestedFilesIn(text, EDITABLE), ['shared/venueCollision.js']);
  assert.deepEqual(requestedFilesIn('no request here, venue.html', EDITABLE), []);
});

// --- the implementer's prompt ------------------------------------------------------

const promptConfig = (over = {}) => ({
  genLabel: 'Generation #009', editableFiles: EDITABLE, implementModel: 'claude-opus-5',
  context: { sources: 'EVERY FILE', testIndex: null }, ...over,
});

test('implement: with no scope, the user prompt is what it was, and the stable prefix is marked for caching', async () => {
  let sent;
  const call = async (opts) => { sent = opts; return { text: 'x', truncated: false }; };
  await implement(promptConfig(), 'CHANGE: venue.html', { attempt: 1, author: 'm (lab)' }, { call });
  const expected = `Generation #009

# The proposed improvement, from m (lab)
CHANGE: venue.html

# Current source
EVERY FILE

Implement the proposal above using the required edit format.`;
  assert.equal(sent.user, expected, 'byte-identical to the prompt before scoping existed');
  assert.ok(sent.user.startsWith(sent.cachePrefix));
  assert.match(sent.cachePrefix, /EVERY FILE\n$/);
});

test('implement: scoped, only the named files are sent, with a way to ask for more', async () => {
  let sent;
  const call = async (opts) => { sent = opts; return { text: 'x', truncated: false }; };
  const sourcesFor = (files) => files.map((f) => `<<${f}>>`).join('');
  await implement(promptConfig({ sourcesFor }), 'CHANGE: venue.html', { attempt: 1, author: 'm', scopeFiles: ['venue.html'] }, { call });
  assert.match(sent.user, /<<venue\.html>>/);
  assert.doesNotMatch(sent.user, /EVERY FILE/);
  assert.match(sent.user, /NEED FILES: <path>, <path>/);
});

test('implement: the correction sits after the cached prefix, so a refinement rereads the prefix unchanged', async () => {
  const sent = [];
  const call = async (opts) => { sent.push(opts); return { text: 'x', truncated: false }; };
  const cfg = promptConfig({ sourcesFor: (f) => `<<${f.join(',')}>>` });
  await implement(cfg, 'P', { attempt: 1, author: 'm', scopeFiles: ['venue.html'] }, { call });
  await implement(cfg, 'P', { attempt: 2, author: 'm', scopeFiles: ['venue.html'], reviewFeedback: 'fix the gate' }, { call });
  assert.equal(sent[0].cachePrefix, sent[1].cachePrefix);
  assert.ok(sent[1].user.startsWith(sent[1].cachePrefix));
  assert.match(sent[1].user.slice(sent[1].cachePrefix.length), /REJECTED BY REVIEW/);
});

test('implement: prompt caching can be switched off', async () => {
  let sent;
  const call = async (opts) => { sent = opts; return { text: 'x', truncated: false }; };
  await implement(promptConfig({ implementPromptCache: false }), 'P', { attempt: 1, author: 'm' }, { call });
  assert.equal('cachePrefix' in sent, false);
});

// --- the Anthropic request ---------------------------------------------------------

test('anthropic: a cache prefix becomes a breakpoint after it; no prefix leaves the plain string', () => {
  const body = getProvider('anthropic').body({ model: 'claude-opus-5', system: 's', user: 'STABLE-then-varying', maxTokens: 10, images: [], cachePrefix: 'STABLE-' });
  assert.deepEqual(body.messages[0].content, [
    { type: 'text', text: 'STABLE-', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'then-varying' },
  ]);
  const plain = getProvider('anthropic').body({ model: 'claude-opus-5', system: 's', user: 'u', maxTokens: 10, images: [] });
  assert.equal(plain.messages[0].content, 'u');
});

test('anthropic: a prefix that is not a prefix is ignored, never trusted', () => {
  assert.deepEqual(userBlocks('abc', 'xyz'), [{ type: 'text', text: 'abc' }]);
  assert.deepEqual(userBlocks('abc', 'abc'), [{ type: 'text', text: 'abc', cache_control: { type: 'ephemeral' } }]);
});

test('every other lab ignores the cache prefix entirely', () => {
  for (const name of ['openai', 'google', 'deepseek', 'qwen', 'meta']) {
    const p = getProvider(name);
    const base = { model: 'm', system: 's', user: 'STABLE-rest', maxTokens: 10, images: [] };
    assert.equal(JSON.stringify(p.body({ ...base, cachePrefix: 'STABLE-' })), JSON.stringify(p.body(base)), name);
  }
});

// --- the record shows what caching did ---------------------------------------------

test('spend: cache reads and writes are reported beside the input total they are part of', () => {
  const ledger = createSpendLedger();
  ledger.record({ site: 'implement', model: 'claude-opus-5', usage: { input_tokens: 1000, cache_creation_input_tokens: 50000, output_tokens: 900 } });
  ledger.record({ site: 'implement', model: 'claude-opus-5', usage: { input_tokens: 1200, cache_read_input_tokens: 50000, output_tokens: 800 } });
  const s = ledger.summary();
  assert.equal(s.inputTokens, 102200, 'cache tokens still count toward input');
  assert.equal(s.cacheReadTokens, 50000);
  assert.equal(s.cacheWriteTokens, 50000);
  assert.equal(s.byModel['claude-opus-5'].cacheReadTokens, 50000);

  const none = createSpendLedger();
  none.record({ site: 'review', model: 'm', usage: { input_tokens: 10, output_tokens: 5 } });
  assert.equal('cacheReadTokens' in none.summary(), false, 'a record with no caching is unchanged');
});

// --- the loop: scope seeded, widened on request ------------------------------------

test('runGeneration: the implementer sees only the named file, asks for another, and is shown it', async (t) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'implement-scope-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'index.html'), 'original content');
  fs.writeFileSync(path.join(repoRoot, 'style.css'), 'body {}');
  const files = ['index.html', 'style.css'];

  const suggestion = `PILLAR: Feedback
PROBLEM: no pause button
CHANGE: add a pause button to index.html
WHY THIS ONE: gap
RISK: none
ALSO UPDATE: nothing
VERIFICATION: visible
BRIEF FEEDBACK: fine
ESCALATION: none`;
  const shown = [];
  let implementCalls = 0;
  const call = async ({ model, user }) => {
    if (model === 'suggest-model') return { text: suggestion, truncated: false };
    if (model === 'implement-model') {
      implementCalls += 1;
      shown.push(user);
      if (implementCalls === 1) return { text: 'NEED FILES: style.css', truncated: false };
      return { text: 'SUMMARY: Add a pause button\nRATIONALE: minimal.\n\n<<<EDIT>>>\nFILE: style.css\n<<<SEARCH>>>\nbody {}\n<<<REPLACE>>>\nbody { --pause: 1 }\n<<<END>>>', truncated: false };
    }
    if (model === 'review-model') return { text: 'VERDICT: APPROVED\n\nREASON: fine.\n\nEND OF REVIEW' };
    throw new Error('unexpected ' + model);
  };

  const result = await runGeneration({
    repoRoot, genNumber: '001', agentBrief: 'B', reviewerBrief: 'VERDICT: APPROVED or REJECTED', editableFiles: files,
    allowlist: compileAllowlist({ allowedPaths: files }), suggestModels: [{ id: 'suggest-model', provider: 'anthropic' }],
    implementModel: 'implement-model', reviewModel: 'review-model', rankModel: 'rank-model', maxAttempts: 3,
    scope: { scope: 'focused', reason: 'x' }, projectDescription: 'p',
    context: { manifest: 'M', testIndex: null, sources: 'ALL SOURCES' },
    sourcesFor: (fs_) => fs_.map((f) => `[[${f}]]`).join(''),
  }, { call });

  assert.equal(result.outcome, 'approved');
  assert.match(shown[0], /\[\[index\.html\]\]/);
  assert.doesNotMatch(shown[0], /style\.css\]\]|ALL SOURCES/, 'first attempt: only what the proposal named');
  assert.match(shown[1], /\[\[index\.html\]\]\[\[style\.css\]\]/, 'second attempt: widened');
  assert.match(shown[1], /THE FILES YOU ASKED FOR ARE NOW INCLUDED/);
  assert.doesNotMatch(shown[1], /COULD NOT BE APPLIED/, 'not mistaken for an edit that failed');
  const record = JSON.parse(fs.readFileSync(path.join(repoRoot, result.attemptRecordPath), 'utf8'));
  assert.equal(record.attempts[0].outcome, 'needed-files');
});

test('runGeneration: a proposal naming no editable file falls back to every file', async (t) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'implement-scope-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'index.html'), 'original content');
  let shown = '';
  const call = async ({ model, user }) => {
    if (model === 'suggest-model') return { text: 'PILLAR: x\nPROBLEM: y\nCHANGE: make it nicer\nWHY THIS ONE: z\nRISK: none\nALSO UPDATE: nothing\nVERIFICATION: v\nBRIEF FEEDBACK: f\nESCALATION: none', truncated: false };
    if (model === 'implement-model') { shown = user; return { text: 'SUMMARY: s\nRATIONALE: r\n\n<<<EDIT>>>\nFILE: index.html\n<<<SEARCH>>>\noriginal content\n<<<REPLACE>>>\nnicer content\n<<<END>>>', truncated: false }; }
    if (model === 'review-model') return { text: 'VERDICT: APPROVED\n\nREASON: fine.\n\nEND OF REVIEW' };
    throw new Error('unexpected ' + model);
  };
  const result = await runGeneration({
    repoRoot, genNumber: '001', agentBrief: 'B', reviewerBrief: 'R', editableFiles: ['index.html'],
    allowlist: compileAllowlist({ allowedPaths: ['index.html'] }), suggestModels: [{ id: 'suggest-model', provider: 'anthropic' }],
    implementModel: 'implement-model', reviewModel: 'review-model', rankModel: 'rank-model', maxAttempts: 2,
    scope: { scope: 'focused', reason: 'x' }, projectDescription: 'p',
    context: { manifest: 'M', testIndex: null, sources: 'ALL SOURCES' },
    sourcesFor: () => 'SHOULD NOT BE USED',
  }, { call });
  assert.equal(result.outcome, 'approved');
  assert.match(shown, /ALL SOURCES/);
  assert.doesNotMatch(shown, /NEED FILES/);
});
