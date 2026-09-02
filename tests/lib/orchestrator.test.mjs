import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { compileAllowlist } from '../../harness/lib/edit-format.mjs';
import {
  extractField, extractDirectEdits, salvageTruncated, forRanking, section,
  buildSuggestSystemPrompt, buildSuggestUserPrompt, DEFAULT_SCOPE_TEXT,
  buildImplementSystemPrompt, rankProposals, writeAttemptRecord, writeProposal,
  recordEscalations, snapshotEditableFiles, restoreSnapshot, runGeneration,
  recordPullRequestUrl, gatherProposals,
} from '../../harness/lib/orchestrator.mjs';
import { ApiError } from '../../harness/lib/api-errors.mjs';

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-test-'));
}

// --- pure text helpers -------------------------------------------------------

test('extractField pulls a labelled block up to the next ALL-CAPS label', () => {
  const text = 'PILLAR: Feedback\nPROBLEM: no pause button exists\nCHANGE: add one';
  assert.equal(extractField(text, 'PROBLEM'), 'no pause button exists');
});

test('extractField returns empty string when the label is absent', () => {
  assert.equal(extractField('nothing here', 'PILLAR'), '');
});

test('extractDirectEdits: null when the response has no edit blocks', () => {
  assert.equal(extractDirectEdits('PILLAR: x\nPROBLEM: y'), null);
});

test('extractDirectEdits: returns parsed edits when present', () => {
  const text = 'PILLAR: x\n\n<<<EDIT>>>\nFILE: index.html\n<<<SEARCH>>>\nold\n<<<REPLACE>>>\nnew\n<<<END>>>';
  const parsed = extractDirectEdits(text);
  assert.ok(parsed);
  assert.equal(parsed.edits.length, 1);
  assert.equal(parsed.edits[0].file, 'index.html');
});

test('salvageTruncated: null when the anchor field never appeared', () => {
  assert.equal(salvageTruncated('PILLAR: x\nPROBLEM: y'), null);
});

test('salvageTruncated: rescues complete prose that hit the cap mid-edit-block', () => {
  const text = 'PILLAR: x\nVERIFICATION: check it\n\n<<<EDIT>>>\nFILE: index.html\n<<<SEARCH>';
  const salvaged = salvageTruncated(text);
  assert.match(salvaged, /PILLAR: x/);
  assert.match(salvaged, /output limit/);
  assert.doesNotMatch(salvaged, /<<<EDIT>>>/);
});

test('salvageTruncated: refuses when a stray edit marker survived the cut', () => {
  const text = 'PILLAR: x\nVERIFICATION: y\n\nSome prose <<<SEARCH>>> stray marker here';
  assert.equal(salvageTruncated(text), null);
});

test('salvageTruncated: accepts a custom anchor field', () => {
  const text = 'SUMMARY: x\nRATIONALE: y';
  assert.equal(salvageTruncated(text, 'RATIONALE'), 'SUMMARY: x\nRATIONALE: y\n\n[NOTE: this response hit its output limit. The analysis above is complete; any edits the model began writing were discarded.]');
});

test('forRanking strips edit blocks and BRIEF FEEDBACK', () => {
  const text = 'PILLAR: x\nBRIEF FEEDBACK: this was unhelpful\n\n<<<EDIT>>>\nstuff\n<<<END>>>';
  const stripped = forRanking(text);
  assert.doesNotMatch(stripped, /BRIEF FEEDBACK/);
  assert.doesNotMatch(stripped, /<<<EDIT>>>/);
  assert.match(stripped, /PILLAR: x/);
});

test('section drops the heading entirely when the body is empty', () => {
  assert.equal(section('Heading', null), '');
  assert.equal(section('Heading', ''), '');
  assert.match(section('Heading', 'body text'), /# Heading\nbody text/);
});

// --- prompt builders ---------------------------------------------------------

test('buildSuggestSystemPrompt: the agent brief is included verbatim, plus scope and edit format', () => {
  const prompt = buildSuggestSystemPrompt({
    agentBrief: 'THIS IS THE PROJECT BRIEF VERBATIM',
    scopeText: DEFAULT_SCOPE_TEXT.focused,
    editableFiles: ['index.html', 'styles.css'],
    suggestMaxTokens: 32000,
  });
  assert.match(prompt, /THIS IS THE PROJECT BRIEF VERBATIM/);
  assert.match(prompt, /ONE focused improvement/);
  assert.match(prompt, /<<<EDIT>>>/); // edit format spec included
  assert.match(prompt, /- index\.html/);
  assert.match(prompt, /- styles\.css/);
  assert.match(prompt, /32,000 tokens/);
});

test('buildSuggestUserPrompt: drops empty context sections, includes screenshots note only when images exist', () => {
  const withoutImages = buildSuggestUserPrompt({ genLabel: 'Generation #1', context: { manifest: 'MANIFEST HERE' } });
  assert.match(withoutImages, /MANIFEST HERE/);
  assert.doesNotMatch(withoutImages, /Screenshots/);

  const withImages = buildSuggestUserPrompt({
    genLabel: 'Generation #1',
    context: { manifest: 'M' },
    screenshots: { images: [{ label: 'intro' }], source: 'docs/x' },
  });
  assert.match(withImages, /# Screenshots/);
});

// --- the additive-by-construction guarantee ----------------------------------
// Every context block added since the harness was ported (quality metrics, a
// work order, the escalation-review field) must be INVISIBLE when its input
// is absent. Not "roughly the same" — byte-identical, because a stray
// newline is invisible in review, costs nothing measurable, and silently
// changes the prompt every model in the rotation has been answering.

test('buildSuggestUserPrompt: a cold-start prompt is byte-identical whether the optional blocks are absent or null', () => {
  const base = { genLabel: 'Generation #1', context: { manifest: 'M', sources: 'S' } };
  const withNulls = buildSuggestUserPrompt({
    genLabel: 'Generation #1',
    context: {
      manifest: 'M', sources: 'S',
      qualityMetrics: null, runtime: null, workOrder: null, escalationReview: null,
      themes: null, escalations: null, platform: null, feedback: null, openQuestions: null,
    },
  });
  assert.equal(withNulls, buildSuggestUserPrompt(base));
});

test('buildSuggestUserPrompt: a work order replaces "pick the ONE improvement" rather than sitting beside it', () => {
  const prompt = buildSuggestUserPrompt({
    genLabel: 'Generation #12',
    context: { manifest: 'M', workOrder: 'esc-001 — do the decided thing' },
  });
  assert.match(prompt, /THIS GENERATION HAS BEEN ASSIGNED A DECIDED CHANGE/);
  assert.match(prompt, /It is not yours to choose; it is yours to specify well/);
  assert.doesNotMatch(prompt, /Pick the ONE improvement you would make/);
});

test('buildSuggestUserPrompt: the ESCALATION REVIEW field appears only when a run has something due', () => {
  const without = buildSuggestUserPrompt({ genLabel: 'G', context: { manifest: 'M' } });
  assert.doesNotMatch(without, /ESCALATION REVIEW/);

  const with_ = buildSuggestUserPrompt({
    genLabel: 'G',
    context: { manifest: 'M', escalationReview: 'ESCALATION REVIEW: <answer esc-004>' },
  });
  assert.match(with_, /ESCALATION REVIEW: <answer esc-004>/);
  // and it lands after the response format, not inside it
  assert.ok(with_.indexOf('ESCALATION REVIEW') > with_.indexOf('ESCALATION DISSENT'));
});

test('buildImplementSystemPrompt: lists only the editable files, includes optional implementation notes', () => {
  const prompt = buildImplementSystemPrompt({ editableFiles: ['a.html'], implementationNotes: 'Watch out for canvas overlap.' });
  assert.match(prompt, /- a\.html/);
  assert.match(prompt, /Watch out for canvas overlap\./);
  assert.match(prompt, /<<<EDIT>>>/);
});

// --- rankProposals ------------------------------------------------------------

test('rankProposals: a single proposal short-circuits without calling a model', async () => {
  const result = await rankProposals(
    { projectDescription: 'x', proposals: [{ id: 'a', text: 'PILLAR: x' }] },
    { call: async () => { throw new Error('should not be called'); } }
  );
  assert.equal(result.index, 0);
  assert.equal(result.reason, 'only one proposal');
});

test('rankProposals: parses CHOICE/REASON and withholds authorship from the ranking prompt', async () => {
  let seenUser = '';
  const call = async ({ user }) => { seenUser = user; return { text: 'CHOICE: 2\nREASON: it fixes something real' }; };
  const proposals = [{ id: 'model-a', text: 'PILLAR: x\nPROBLEM: y' }, { id: 'model-b', text: 'PILLAR: z\nPROBLEM: w' }];
  const result = await rankProposals({ projectDescription: 'a test project', proposals }, { call });
  assert.equal(result.index, 1);
  assert.doesNotMatch(seenUser, /model-a/);
  assert.doesNotMatch(seenUser, /model-b/);
});

test('rankProposals: falls back to the first proposal on an unparseable ranking', async () => {
  const call = async () => ({ text: 'not the right format at all' });
  const proposals = [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }];
  const result = await rankProposals({ projectDescription: 'x', proposals }, { call });
  assert.equal(result.index, 0);
  assert.match(result.reason, /fell back/);
});

// --- record writers -----------------------------------------------------------

test('writeAttemptRecord: writes valid JSON with selfImplemented computed correctly', (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const relative = writeAttemptRecord({
    repoRoot, genNumber: '001', outcome: 'approved',
    suggestResult: { model: 'model-x', provider: 'anthropic' },
    proposal: 'CHANGE: add a pause button\n',
    attempts: [{ attempt: 1, by: 'model-x', outcome: 'approved', detail: 'x' }],
    implementedBy: 'model-x', implementModel: 'claude-opus-5',
    scope: { scope: 'focused', reason: 'default' },
  });

  const record = JSON.parse(fs.readFileSync(path.join(repoRoot, relative), 'utf8'));
  assert.equal(record.generation, '001');
  assert.equal(record.proposalSummary, 'add a pause button');
  // implementedBy differs from implementModel -> the model shipped its own code
  assert.equal(record.selfImplemented, true);
});

test('writeAttemptRecord: selfImplemented is false when the fallback implementer shipped it', (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const relative = writeAttemptRecord({
    repoRoot, genNumber: '001', outcome: 'approved',
    suggestResult: { model: 'model-x', provider: 'anthropic' }, proposal: 'x',
    attempts: [], implementedBy: 'claude-opus-5', implementModel: 'claude-opus-5',
    scope: { scope: 'focused', reason: 'x' },
  });
  const record = JSON.parse(fs.readFileSync(path.join(repoRoot, relative), 'utf8'));
  assert.equal(record.selfImplemented, false);
});

test('writeAttemptRecord: apiIssues and pullRequestUrl default to empty/null and round-trip when given', (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const relative = writeAttemptRecord({
    repoRoot, genNumber: '001', outcome: 'no-proposal',
    suggestResult: null, proposal: null, attempts: [],
    implementedBy: null, implementModel: 'claude-opus-5',
    scope: { scope: 'focused', reason: 'default' },
  });
  const withoutIssues = JSON.parse(fs.readFileSync(path.join(repoRoot, relative), 'utf8'));
  assert.deepEqual(withoutIssues.apiIssues, []);
  assert.equal(withoutIssues.pullRequestUrl, null);

  writeAttemptRecord({
    repoRoot, genNumber: '002', outcome: 'no-proposal',
    suggestResult: null, proposal: null, attempts: [],
    implementedBy: null, implementModel: 'claude-opus-5',
    scope: { scope: 'focused', reason: 'default' },
    apiIssues: [{ provider: 'openai', kind: 'invalid_key', statusCode: 401, ids: ['gpt-5.6-luna'] }],
  });
  const withIssues = JSON.parse(fs.readFileSync(path.join(repoRoot, `docs/generations/gen-002/attempts.json`), 'utf8'));
  assert.equal(withIssues.apiIssues.length, 1);
  assert.equal(withIssues.apiIssues[0].kind, 'invalid_key');
});

test('recordPullRequestUrl: fills in the field writeAttemptRecord left null, without touching anything else', (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  writeAttemptRecord({
    repoRoot, genNumber: '003', outcome: 'approved',
    suggestResult: { model: 'model-x', provider: 'anthropic' }, proposal: 'CHANGE: x\n',
    attempts: [{ attempt: 1, by: 'model-x', outcome: 'approved', detail: 'x' }],
    implementedBy: 'model-x', implementModel: 'claude-opus-5',
    scope: { scope: 'focused', reason: 'default' },
  });

  const relative = recordPullRequestUrl({
    repoRoot, genNumber: '003',
    pullRequestUrl: 'https://github.com/example/example/pull/42',
  });

  const record = JSON.parse(fs.readFileSync(path.join(repoRoot, relative), 'utf8'));
  assert.equal(record.pullRequestUrl, 'https://github.com/example/example/pull/42');
  // Untouched by the second write.
  assert.equal(record.proposalSummary, 'x');
  assert.equal(record.selfImplemented, true);
});

test('recordPullRequestUrl: fails loudly when the generation was never written', (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  assert.throws(
    () => recordPullRequestUrl({ repoRoot, genNumber: '999', pullRequestUrl: 'https://example.com/pr/1' }),
    /doesn't exist or isn't valid JSON/
  );
});

test('gatherProposals: an ApiError failure carries kind and statusCode through to the failure record', async () => {
  const promptConfig = { agentBrief: 'be helpful', editableFiles: [], createOnlyDescription: '', context: {} };
  const models = [
    { id: 'gpt-5.6-luna', provider: 'openai' },
    { id: 'claude-opus-5', provider: 'anthropic' },
  ];

  const call = async ({ model }) => {
    if (model === 'gpt-5.6-luna') {
      throw new ApiError('openai API error 401: {"error":"invalid api key"}', {
        kind: 'invalid_key', provider: 'openai', statusCode: 401,
      });
    }
    return { text: 'CHANGE: do a thing\n', truncated: false, provider: 'anthropic', model, sentImages: 0 };
  };

  const { proposals, failures } = await gatherProposals(promptConfig, models, { call });

  assert.equal(proposals.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].id, 'gpt-5.6-luna');
  assert.equal(failures[0].kind, 'invalid_key');
  assert.equal(failures[0].statusCode, 401);
});

test('gatherProposals: an ordinary Error (not an ApiError) leaves kind/statusCode null rather than throwing', async () => {
  const promptConfig = { agentBrief: 'be helpful', editableFiles: [], createOnlyDescription: '', context: {} };
  const models = [{ id: 'flaky-model', provider: 'anthropic' }];
  const call = async () => { throw new Error('socket hang up'); };

  const { failures } = await gatherProposals(promptConfig, models, { call });

  assert.equal(failures.length, 1);
  assert.equal(failures[0].kind, null);
  assert.equal(failures[0].statusCode, null);
});

test('writeProposal: writes a real markdown file with the expected sections', (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const relative = writeProposal({
    repoRoot, genNumber: '001',
    proposal: 'PILLAR: Feedback\nCHANGE: add a button',
    parsed: { summary: 'Add a button', rationale: 'Because reasons.', pillar: 'Feedback' },
    suggestResult: { model: 'model-x', provider: 'anthropic' },
    applied: [{ file: 'index.html', removedLines: 1, addedLines: 2 }],
    review: { raw: 'VERDICT: APPROVED' },
    attempts: 1, implementedBy: 'model-x', implementModel: 'claude-opus-5', reviewModel: 'claude-opus-5',
    scope: { scope: 'focused', reason: 'x' }, briefFeedback: 'was helpful',
  });
  const content = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
  assert.match(content, /the suggesting model wrote its own edits/);
  assert.match(content, /Because reasons\./);
  assert.match(content, /was helpful/);
});

// --- recordEscalations ----------------------------------------------------------

test('recordEscalations: folds proposals into a fresh ledger and reports what changed', (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const proposals = [{
    id: 'model-x', provider: 'anthropic',
    escalation: { opened: { title: 'Widen the budget', target: 'pipeline', case: 'reasons here' }, supports: [], dissents: [] },
  }];
  const result = recordEscalations(proposals, { repoRoot, genNumber: '001', threshold: { models: 3, labs: 2 } });
  assert.equal(result.opened.length, 1);
  assert.ok(fs.existsSync(path.join(repoRoot, 'docs/escalations/ledger.json')));
});

// --- snapshot / restore -----------------------------------------------------------

test('snapshotEditableFiles + restoreSnapshot: round-trips content and removes files created since', (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'index.html'), 'original');

  const snapshot = snapshotEditableFiles(repoRoot, ['index.html']);
  fs.writeFileSync(path.join(repoRoot, 'index.html'), 'modified');
  fs.writeFileSync(path.join(repoRoot, 'new-file.test.js'), 'created by an attempt');

  restoreSnapshot(repoRoot, snapshot, ['new-file.test.js']);

  assert.equal(fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8'), 'original');
  assert.equal(fs.existsSync(path.join(repoRoot, 'new-file.test.js')), false);
});

// --- runGeneration: validation ------------------------------------------------

test('runGeneration validates required config before doing any work', async () => {
  const base = { repoRoot: '/tmp', genNumber: '001', editableFiles: [], context: {}, projectDescription: 'x' };
  await assert.rejects(() => runGeneration({ ...base, reviewerBrief: 'x', suggestModels: [{ id: 'm' }], scope: { scope: 'focused' } }), /non-empty agentBrief/);
  await assert.rejects(() => runGeneration({ ...base, agentBrief: 'x', suggestModels: [{ id: 'm' }], scope: { scope: 'focused' } }), /non-empty reviewerBrief/);
  await assert.rejects(() => runGeneration({ ...base, agentBrief: 'x', reviewerBrief: 'x', suggestModels: [], scope: { scope: 'focused' } }), /at least one entry in suggestModels/);
  await assert.rejects(() => runGeneration({ ...base, agentBrief: 'x', reviewerBrief: 'x', suggestModels: [{ id: 'm' }] }), /requires a scope decision/);
});

// --- runGeneration: full scenarios ---------------------------------------------

function baseConfig(repoRoot, overrides = {}) {
  return {
    repoRoot,
    genNumber: '001',
    agentBrief: 'THE PROJECT BRIEF',
    reviewerBrief: 'THE REVIEWER BRIEF. Respond with VERDICT: APPROVED or VERDICT: REJECTED.',
    editableFiles: ['index.html'],
    allowlist: compileAllowlist({ allowedPaths: ['index.html'] }),
    suggestModels: [{ id: 'suggest-model', provider: 'anthropic' }],
    implementModel: 'implement-model',
    reviewModel: 'review-model',
    rankModel: 'rank-model',
    maxAttempts: 3,
    scope: { scope: 'focused', reason: 'default' },
    projectDescription: 'a test project',
    context: { manifest: 'MANIFEST', testIndex: null, sources: 'SOURCE BUNDLE' },
    ...overrides,
  };
}

const VALID_SUGGESTION = `PILLAR: Feedback Loops
PROBLEM: no pause button exists
CHANGE: add a pause button to index.html
WHY THIS ONE: it is the highest-value gap
RISK: none, purely additive
ALSO UPDATE: nothing
VERIFICATION: the button should be visible
BRIEF FEEDBACK: the brief was clear
ESCALATION: none
ESCALATION TARGET: none
ESCALATION CASE: none
ESCALATION SUPPORT: none
ESCALATION DISSENT: none`;

function suggestionWithDirectEdits() {
  return `${VALID_SUGGESTION}

<<<EDIT>>>
FILE: index.html
<<<SEARCH>>>
original content
<<<REPLACE>>>
original content with a pause button
<<<END>>>`;
}

const VALID_IMPLEMENTATION = `SUMMARY: Add a pause button
RATIONALE: Players had no way to pause; this adds a button, focused and minimal.

<<<EDIT>>>
FILE: index.html
<<<SEARCH>>>
original content
<<<REPLACE>>>
original content with a pause button
<<<END>>>`;

test('runGeneration: no proposals -> outcome "no-proposal", a real record is written, does not throw', async (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'index.html'), 'original content');

  const call = async ({ model }) => {
    if (model === 'suggest-model') throw new Error('404 model not found');
    throw new Error('unexpected call: ' + model);
  };

  const result = await runGeneration(baseConfig(repoRoot), { call });
  assert.equal(result.outcome, 'no-proposal');
  assert.equal(result.hasChanges, false);
  assert.match(fs.readFileSync(path.join(repoRoot, result.attemptRecordPath), 'utf8'), /suggestion-failed/);
});

test('runGeneration: approved via the suggesting model\'s own direct edits (no implement call needed)', async (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'index.html'), 'original content');

  const call = async ({ model }) => {
    if (model === 'suggest-model') return { text: suggestionWithDirectEdits(), truncated: false, stopReason: null, provider: 'anthropic', sentImages: 0 };
    if (model === 'implement-model') throw new Error('should not need the fallback implementer');
    if (model === 'review-model') return { text: 'VERDICT: APPROVED\n\nREASON: clean, minimal, matches the proposal.' };
    throw new Error('unexpected call: ' + model);
  };

  const result = await runGeneration(baseConfig(repoRoot), { call });
  assert.equal(result.outcome, 'approved');
  assert.equal(result.hasChanges, true);
  assert.equal(result.implementedBy, 'suggest-model (anthropic)');
  assert.equal(result.selfImplemented, true);
  assert.equal(result.attempts, 1);
  assert.match(fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8'), /pause button/);
});

test('runGeneration: approved via the fallback implementer when the suggester offers no edits', async (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'index.html'), 'original content');

  const call = async ({ model }) => {
    if (model === 'suggest-model') return { text: VALID_SUGGESTION, truncated: false, provider: 'anthropic', sentImages: 0 };
    if (model === 'implement-model') return { text: VALID_IMPLEMENTATION, truncated: false };
    if (model === 'review-model') return { text: 'VERDICT: APPROVED\n\nREASON: good.' };
    throw new Error('unexpected call: ' + model);
  };

  const result = await runGeneration(baseConfig(repoRoot), { call });
  assert.equal(result.outcome, 'approved');
  assert.equal(result.implementedBy, 'implement-model');
  assert.equal(result.selfImplemented, false);
});

test('runGeneration: a rejected review triggers refine, and the tree is reset to pristine before the retry', async (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'index.html'), 'original content');

  let implementCalls = 0;
  const call = async ({ model, user }) => {
    if (model === 'suggest-model') return { text: VALID_SUGGESTION, truncated: false, provider: 'anthropic', sentImages: 0 };
    if (model === 'implement-model') {
      implementCalls += 1;
      // The tree on disk must be back to pristine before EVERY attempt,
      // including the second — restoreSnapshot() runs at the top of each
      // loop iteration, before the model is even asked, specifically so a
      // retry's SEARCH blocks match the original source rather than
      // whatever the previous (rejected) attempt left behind.
      assert.equal(fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8'), 'original content');
      if (implementCalls === 2) {
        // Second attempt (refine) must see the rejection feedback.
        assert.match(user, /REJECTED BY REVIEW/);
      }
      return { text: VALID_IMPLEMENTATION, truncated: false };
    }
    if (model === 'review-model') {
      // Reject the first attempt, approve the second.
      return implementCalls === 1
        ? { text: 'VERDICT: REJECTED\n\nREASON: needs a fix.\n\nREQUIRED FIXES:\n- fix it' }
        : { text: 'VERDICT: APPROVED\n\nREASON: fixed.' };
    }
    throw new Error('unexpected call: ' + model);
  };

  const result = await runGeneration(baseConfig(repoRoot), { call });
  assert.equal(result.outcome, 'approved');
  assert.equal(result.attempts, 2);
  assert.equal(implementCalls, 2);
});

test('runGeneration: every attempt exhausted -> outcome "abandoned", tree restored to pristine', async (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'index.html'), 'original content');

  const call = async ({ model }) => {
    if (model === 'suggest-model') return { text: VALID_SUGGESTION, truncated: false, provider: 'anthropic', sentImages: 0 };
    if (model === 'implement-model') return { text: VALID_IMPLEMENTATION, truncated: false };
    if (model === 'review-model') return { text: 'VERDICT: REJECTED\n\nREASON: never good enough.' };
    throw new Error('unexpected call: ' + model);
  };

  const result = await runGeneration(baseConfig(repoRoot, { maxAttempts: 2 }), { call });
  assert.equal(result.outcome, 'abandoned');
  assert.equal(result.hasChanges, false);
  assert.equal(result.attempts, 2);
  assert.equal(fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8'), 'original content');
  const record = JSON.parse(fs.readFileSync(path.join(repoRoot, result.attemptRecordPath), 'utf8'));
  assert.equal(record.outcome, 'abandoned');
  assert.equal(record.attempts.length, 2);
});

test('runGeneration: a crash after proposals exist still writes a record, then re-throws', async (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'index.html'), 'original content');

  const call = async ({ model }) => {
    if (model === 'suggest-model') return { text: VALID_SUGGESTION, truncated: false, provider: 'anthropic', sentImages: 0 };
    // Single proposal, so rankProposals short-circuits without a call —
    // the crash has to come from later. Implement throws instead.
    if (model === 'implement-model') throw new Error('simulated network death mid-implementation');
    throw new Error('unexpected call: ' + model);
  };

  await assert.rejects(
    () => runGeneration(baseConfig(repoRoot), { call }),
    /simulated network death/
  );

  // The crash record must exist even though the promise rejected.
  const recordPath = path.join(repoRoot, 'docs/generations/gen-001/attempts.json');
  assert.ok(fs.existsSync(recordPath));
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  assert.equal(record.outcome, 'crashed');
  assert.match(record.attempts.at(-1).detail, /simulated network death/);
});

test('runGeneration: applyEdits failure retries without consuming the implementer\'s attempt on a self-implemented set, but does on the fallback path', async (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'index.html'), 'original content');

  let implementCalls = 0;
  const call = async ({ model }) => {
    if (model === 'suggest-model') return { text: VALID_SUGGESTION, truncated: false, provider: 'anthropic', sentImages: 0 };
    if (model === 'implement-model') {
      implementCalls += 1;
      // First attempt: a SEARCH block that will not match anything -> apply failure.
      if (implementCalls === 1) {
        return { text: 'SUMMARY: x\nRATIONALE: y, long enough to pass the rationale bar here.\n\n<<<EDIT>>>\nFILE: index.html\n<<<SEARCH>>>\nthis text does not exist\n<<<REPLACE>>>\nz\n<<<END>>>', truncated: false };
      }
      return { text: VALID_IMPLEMENTATION, truncated: false };
    }
    if (model === 'review-model') return { text: 'VERDICT: APPROVED\n\nREASON: good.' };
    throw new Error('unexpected call: ' + model);
  };

  const result = await runGeneration(baseConfig(repoRoot), { call });
  assert.equal(result.outcome, 'approved');
  assert.equal(implementCalls, 2);
  // Both attempts count against maxAttempts since neither was a direct edit.
  assert.equal(result.attempts, 2);
});

test('writeAttemptRecord: stamps the harness version that wrote it', (t) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ver-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const rel = writeAttemptRecord({ repoRoot, genNumber: '001', outcome: 'no-proposal', suggestResult: null, proposal: null, attempts: [], fanOut: null, implementedBy: null, implementModel: 'm', scope: { scope: 'focused', reason: 'r' } });
  const record = JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
  assert.match(record.harnessVersion, /^\d+\.\d+\.\d+$/);
});

// --- Cost accounting and the budget cap (harness/lib/spend.mjs) --------------

test('runGeneration: every stage\'s usage lands in attempts.json as spend, by model and by site', async (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'index.html'), 'original content');

  const call = async ({ model }) => {
    if (model === 'suggest-model') return { text: VALID_SUGGESTION, truncated: false, provider: 'anthropic', model, sentImages: 0, usage: { input_tokens: 1000, output_tokens: 300 } };
    if (model === 'implement-model') return { text: VALID_IMPLEMENTATION, truncated: false, model, usage: { prompt_tokens: 500, completion_tokens: 100 } };
    if (model === 'review-model') return { text: 'VERDICT: APPROVED\n\nREASON: fine.', model, usage: null };
    throw new Error('unexpected call: ' + model);
  };

  const result = await runGeneration(baseConfig(repoRoot), { call });
  assert.equal(result.outcome, 'approved');
  const record = JSON.parse(fs.readFileSync(path.join(repoRoot, result.attemptRecordPath), 'utf8'));
  assert.equal(record.spend.calls, 3);
  assert.equal(record.spend.estimatedCalls, 1, 'the review call reported no usage, so it is an estimate');
  assert.deepEqual(record.spend.byModel['suggest-model'], { calls: 1, inputTokens: 1000, outputTokens: 300 });
  assert.deepEqual(record.spend.bySite.implement, { calls: 1, inputTokens: 500, outputTokens: 100 });
  assert.ok(record.spend.totalTokens > 1900);
  assert.equal(result.spend.totalTokens, record.spend.totalTokens);
});

test('runGeneration: a fan-out projected over the cap is refused before any model is called', async (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'index.html'), 'original content');

  let calls = 0;
  const call = async () => { calls += 1; throw new Error('must not be called'); };

  const result = await runGeneration(baseConfig(repoRoot, { budget: { maxGenerationTokens: 10 } }), { call });
  assert.equal(result.outcome, 'over-budget');
  assert.equal(result.hasChanges, false);
  assert.equal(calls, 0);
  const record = JSON.parse(fs.readFileSync(path.join(repoRoot, result.attemptRecordPath), 'utf8'));
  assert.equal(record.outcome, 'over-budget');
  assert.equal(record.attempts[0].outcome, 'over-budget');
  assert.match(record.attempts[0].detail, /max_generation_tokens/);
  assert.equal(record.spend.calls, 0);
});

test('runGeneration: the running cap stops the refine loop with a budget-exhausted attempt, and the run is abandoned', async (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'index.html'), 'original content');

  let implementCalls = 0;
  const call = async ({ model }) => {
    if (model === 'suggest-model') return { text: VALID_SUGGESTION, truncated: false, provider: 'anthropic', model, sentImages: 0, usage: { input_tokens: 1000, output_tokens: 500 } };
    if (model === 'implement-model') { implementCalls += 1; return { text: VALID_IMPLEMENTATION, truncated: false, model, usage: { input_tokens: 100, output_tokens: 100 } }; }
    if (model === 'review-model') return { text: 'VERDICT: REJECTED\n\nREASON: no.\n\nREQUIRED FIXES:\n- x', model, usage: { input_tokens: 50, output_tokens: 10 } };
    throw new Error('unexpected call: ' + model);
  };

  // 1500 after suggest, 1760 after the first implement+review: the second
  // attempt must not start.
  const result = await runGeneration(baseConfig(repoRoot, { budget: { maxGenerationTokens: 1600 } }), { call });
  assert.equal(result.outcome, 'abandoned');
  assert.equal(implementCalls, 1);
  const record = JSON.parse(fs.readFileSync(path.join(repoRoot, result.attemptRecordPath), 'utf8'));
  assert.deepEqual(record.attempts.map((a) => a.outcome), ['rejected-by-review', 'budget-exhausted']);
  assert.equal(fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8'), 'original content', 'tree restored');
});

test('runGeneration: with no budget configured, nothing is refused and spend is still recorded', async (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'index.html'), 'original content');
  const call = async ({ model }) => {
    if (model === 'suggest-model') return { text: suggestionWithDirectEdits(), truncated: false, provider: 'anthropic', model, sentImages: 0 };
    if (model === 'review-model') return { text: 'VERDICT: APPROVED\n\nREASON: fine.', model };
    throw new Error('unexpected call: ' + model);
  };
  const result = await runGeneration(baseConfig(repoRoot, { budget: { maxGenerationTokens: null } }), { call });
  assert.equal(result.outcome, 'approved');
  assert.equal(result.spend.estimatedCalls, 2);
});

// --- Scope-aware ranking (docs/Review-SWOT-2026-09.md F1) --------------------

test('rankProposals: the focused rubric is the original, and the ambitious one stops preferring the smallest proposal', async () => {
  const seen = [];
  const call = async ({ system }) => { seen.push(system); return { text: 'CHOICE: 2\nREASON: bigger.' }; };
  const proposals = [{ id: 'a', text: 'CHANGE: small' }, { id: 'b', text: 'CHANGE: structural' }];
  await rankProposals({ projectDescription: 'p', proposals, rankModel: 'r' }, { call });
  await rankProposals({ projectDescription: 'p', proposals, rankModel: 'r', scope: 'focused' }, { call });
  await rankProposals({ projectDescription: 'p', proposals, rankModel: 'r', scope: 'ambitious' }, { call });
  assert.equal(seen[0], seen[1], 'no scope and focused are byte-identical');
  assert.match(seen[0], /implementable as a few localised edits/);
  assert.notEqual(seen[2], seen[0]);
  assert.match(seen[2], /the smallest proposal is not the default winner/);
  assert.doesNotMatch(seen[2], /a few localised edits/);
  assert.match(seen[2], /reversed in one revert/);
});

// --- Every proposal is kept, not only the winner's (5.12) ---------------------

test('runGeneration: every fan-out proposal is written under gen-NNN/proposals/, and the index does not grow', async (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'index.html'), 'original content');
  const call = async ({ model }) => {
    if (model === 'suggest-a' || model === 'suggest-b') return { text: `${VALID_SUGGESTION}\nMARKER: from ${model}`, truncated: false, provider: 'anthropic', model, sentImages: 0 };
    if (model === 'rank-model') return { text: 'CHOICE: 1\nREASON: first.' };
    if (model === 'implement-model') return { text: VALID_IMPLEMENTATION, truncated: false };
    if (model === 'review-model') return { text: 'VERDICT: APPROVED\n\nREASON: fine.' };
    throw new Error('unexpected call: ' + model);
  };
  const result = await runGeneration(baseConfig(repoRoot, { suggestModels: [{ id: 'suggest-a', provider: 'anthropic' }, { id: 'suggest-b', provider: 'anthropic' }] }), { call });
  assert.equal(result.outcome, 'approved');
  const dir = path.join(repoRoot, 'docs/generations/gen-001/proposals');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['suggest-a.md', 'suggest-b.md']);
  assert.match(fs.readFileSync(path.join(dir, 'suggest-b.md'), 'utf8'), /from suggest-b/);
  const record = JSON.parse(fs.readFileSync(path.join(repoRoot, result.attemptRecordPath), 'utf8'));
  assert.deepEqual(record.fanOut.proposalFiles, ['docs/generations/gen-001/proposals/suggest-a.md', 'docs/generations/gen-001/proposals/suggest-b.md']);
  const { buildGenerationIndex } = await import('../../harness/lib/context-pack.mjs');
  assert.equal(buildGenerationIndex({ repoRoot }).split('\n').length, 3, 'header, rule, one row');
});
