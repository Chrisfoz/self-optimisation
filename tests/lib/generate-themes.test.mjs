import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildThemesSystemPrompt, buildThemesUserPrompt, parseThemesResponse,
  isThemesReviewDue, padGeneration, themesReviewFilename, buildThemesReview,
} from '../../harness/lib/generate-themes.mjs';

test('buildThemesSystemPrompt weaves in the supplied project description, not a hardcoded one', () => {
  const prompt = buildThemesSystemPrompt('a CLI tool for parsing log files, gated by unit tests.');
  assert.match(prompt, /a CLI tool for parsing log files/);
  assert.doesNotMatch(prompt, /children's browser games/); // the reference implementation's literal text must not leak through
});

test('buildThemesUserPrompt embeds the history text and generation number', () => {
  const prompt = buildThemesUserPrompt('gen 001: did X\ngen 002: did Y', 20);
  assert.match(prompt, /through 20/);
  assert.match(prompt, /gen 001: did X/);
});

test('parseThemesResponse: a well-formed response parses into themes', () => {
  const text = `THEME 1
NOTICED: Three generations in a row hit the same output-budget wall (gen 3, 7, 9).
MEANS: A fixed budget cannot be sized against a model that does not exist yet.

THEME 2
NOTICED: Two labs independently flagged the same brief constraint as unhelpful.
MEANS: A hint that never gets revisited calcifies into a cage.`;
  const result = parseThemesResponse(text);
  assert.equal(result.themes.length, 2);
  assert.match(result.themes[0].noticed, /output-budget wall/);
  assert.match(result.themes[1].means, /calcifies into a cage/);
});

test('parseThemesResponse rejects an empty response', () => {
  assert.throws(() => parseThemesResponse(''), /Empty response/);
  assert.throws(() => parseThemesResponse('   '), /Empty response/);
});

test('parseThemesResponse rejects plain prose with no THEME structure at all', () => {
  // No "THEME n" marker means the whole text is treated as one block, which
  // then fails the NOTICED/MEANS check — a different message than the
  // "no blocks" case below, but still a loud rejection either way.
  assert.throws(() => parseThemesResponse('Just some prose, no structure.'), /missing a NOTICED field/);
});

test('parseThemesResponse rejects text that is only empty THEME markers', () => {
  // THEME markers with nothing but whitespace between them — every block
  // is empty after trim and gets filtered out, hitting the actual
  // "no blocks survived" path.
  assert.throws(() => parseThemesResponse('THEME 1\n\nTHEME 2\n'), /No "THEME n" blocks/);
});

test('parseThemesResponse rejects more than 4 themes', () => {
  const five = Array.from({ length: 5 }, (_, i) =>
    `THEME ${i + 1}\nNOTICED: something long enough to pass the length check here.\nMEANS: a principle also long enough to pass the check here.`
  ).join('\n\n');
  assert.throws(() => parseThemesResponse(five), /the cap is 4/);
});

test('parseThemesResponse rejects fewer than 2 themes', () => {
  const one = 'THEME 1\nNOTICED: something long enough to pass the length check here.\nMEANS: a principle also long enough to pass the check.';
  assert.throws(() => parseThemesResponse(one), /at least 2 are required/);
});

test('parseThemesResponse rejects a theme missing NOTICED or MEANS', () => {
  const missingMeans = 'THEME 1\nNOTICED: something long enough to pass the length check here.\n\nTHEME 2\nNOTICED: another long enough observation here.\nMEANS: a principle long enough here.';
  assert.throws(() => parseThemesResponse(missingMeans), /missing a MEANS field/);
});

test('parseThemesResponse rejects a suspiciously short NOTICED or MEANS (a thesaurus-pass smell)', () => {
  const tooShort = 'THEME 1\nNOTICED: short.\nMEANS: a principle long enough to pass the check here.\n\nTHEME 2\nNOTICED: another long enough observation here.\nMEANS: also long enough here.';
  assert.throws(() => parseThemesResponse(tooShort), /too short to be a real observation/);
});


// --- the cadence decision -----------------------------------------------------
// Pure on purpose: the CLI does the directory read and passes what it found,
// so every branch of "is a review due" is testable without a filesystem.

test('isThemesReviewDue: due on a cadence boundary, not due between them', () => {
  for (const gen of ['010', '020', '030']) {
    assert.equal(isThemesReviewDue({ genNumber: gen, cadence: 10 }).due, true, `${gen} should be due`);
  }
  for (const gen of ['011', '019', '001']) {
    assert.equal(isThemesReviewDue({ genNumber: gen, cadence: 10 }).due, false, `${gen} should not be due`);
  }
});

test('isThemesReviewDue: says when the next review is, rather than only that this is not it', () => {
  const { due, reason } = isThemesReviewDue({ genNumber: '011', cadence: 10 });
  assert.equal(due, false);
  assert.match(reason, /Next review at generation 020/);
});

test('isThemesReviewDue: FORCE_REVIEW overrides the boundary', () => {
  assert.equal(isThemesReviewDue({ genNumber: '007', cadence: 10 }).due, false);
  assert.equal(isThemesReviewDue({ genNumber: '007', cadence: 10, force: true }).due, true);
});

test('isThemesReviewDue: not due when a review already covers that generation, force or not', () => {
  // Overwriting a real review with a second opinion, or writing two files
  // claiming the same window, are both worse than doing nothing. Deleting the
  // file is the visible act that means "redo this one".
  const reviewed = ['010', '020'];
  assert.equal(isThemesReviewDue({ genNumber: '020', cadence: 10, reviewed }).due, false);
  assert.equal(isThemesReviewDue({ genNumber: '020', cadence: 10, reviewed, force: true }).due, false);
  assert.equal(isThemesReviewDue({ genNumber: '030', cadence: 10, reviewed }).due, true);
});

test('isThemesReviewDue: compares generations by value, not by the padding they happen to carry', () => {
  assert.equal(isThemesReviewDue({ genNumber: '020', cadence: 10, reviewed: ['20'] }).due, false);
  assert.equal(isThemesReviewDue({ genNumber: 20, cadence: 10, reviewed: ['0020'] }).due, false);
});

test('isThemesReviewDue: a missing or nonsense cadence is not due, and says what to set', () => {
  assert.match(isThemesReviewDue({ genNumber: '010', cadence: null }).reason, /cadence_generations/);
  assert.equal(isThemesReviewDue({ genNumber: '010', cadence: 0 }).due, false);
  assert.equal(isThemesReviewDue({ genNumber: '010', cadence: null, force: true }).due, true);
});

test('isThemesReviewDue: an unusable GEN_NUMBER is not due rather than a crash', () => {
  const { due, reason } = isThemesReviewDue({ genNumber: '', cadence: 10 });
  assert.equal(due, false);
  assert.match(reason, /not a generation number/);
});

// --- filename padding ---------------------------------------------------------
// loadLatestThemesReview() picks the newest review by sorting filenames
// lexicographically, so review-9.json would sort after review-10.json and a
// project would silently keep reading a stale review forever. Prove the
// writer cannot produce the unpadded form in the first place.

test('themesReviewFilename always pads to at least three digits', () => {
  assert.equal(themesReviewFilename(9), 'review-009.json');
  assert.equal(themesReviewFilename('9'), 'review-009.json');
  assert.equal(themesReviewFilename('010'), 'review-010.json');
  assert.equal(themesReviewFilename(1234), 'review-1234.json');
});

test('themesReviewFilename output sorts correctly across a 9 -> 10 boundary', () => {
  const names = [themesReviewFilename(10), themesReviewFilename(9)].sort();
  assert.deepEqual(names, ['review-009.json', 'review-010.json']);
});

test('padGeneration accepts a gen-NNN directory name and rejects anything that is not a number', () => {
  assert.equal(padGeneration('gen-007'), '007');
  assert.throws(() => padGeneration('latest'), /Not a generation number/);
  assert.throws(() => padGeneration(''), /Not a generation number/);
});

// --- the written record -------------------------------------------------------

test('buildThemesReview records the window and the model that read it, not only the themes', () => {
  // windowSize/model/provider exist so a later comparison of two reviews can
  // tell that they read DIFFERENT windows — a theme that survives that is
  // evidence a theme restated from the same window is not.
  const review = buildThemesReview({
    throughGeneration: 20,
    windowSize: 10,
    model: 'claude-opus-5',
    provider: 'anthropic',
    themes: [{ noticed: 'a', means: 'b' }],
    date: new Date('2026-09-02T11:22:33Z'),
  });
  assert.equal(review.version, 1);
  assert.equal(review.throughGeneration, '020');
  assert.equal(review.date, '2026-09-02');
  assert.equal(review.windowSize, 10);
  assert.equal(review.model, 'claude-opus-5');
  assert.equal(review.provider, 'anthropic');
  assert.deepEqual(review.themes, [{ noticed: 'a', means: 'b' }]);
});

test('buildThemesSystemPrompt tells the model how many generations it is actually reading', () => {
  // A model asked to compare ten things when it has three will pad to reach
  // the count, and padding is what the rest of this prompt exists to prevent.
  assert.match(buildThemesSystemPrompt('a project.', 3), /reviewing 3 generations/);
  assert.match(buildThemesSystemPrompt('a project.', 1), /reviewing 1 generation of/);
  assert.match(buildThemesSystemPrompt('a project.'), /reviewing 10 generations/);
});

// --- UNKNOWN: the third field (docs/curiosity/C2, phase A) -------------------

const WITH_UNKNOWN = `THEME 1
NOTICED: generations 3, 7 and 9 each rejected a timing change on the first attempt
MEANS: the reviewer cannot see elapsed time from a diff, so any change to timing reads as risk
UNKNOWN: would attaching a recorded play session to the review change the verdict on timing changes?

THEME 2
NOTICED: every model proposed touching the landing page before either game
MEANS: the landing page is the only file whose purpose is stated in the manifest`;

test('parseThemesResponse: UNKNOWN is captured when present and absent when omitted, and MEANS stops before it', () => {
  const { themes } = parseThemesResponse(WITH_UNKNOWN);
  assert.equal(themes.length, 2);
  assert.match(themes[0].unknown, /^would attaching a recorded play session/);
  assert.doesNotMatch(themes[0].means, /UNKNOWN/);
  assert.equal(themes[1].unknown, undefined);
});

test('parseThemesResponse: a present-but-empty or too-short UNKNOWN fails the review rather than being dropped', () => {
  assert.throws(() => parseThemesResponse(WITH_UNKNOWN.replace(/UNKNOWN: .*$/m, 'UNKNOWN: why?')), /UNKNOWN is present but too short/);
  assert.throws(() => parseThemesResponse(WITH_UNKNOWN.replace(/UNKNOWN: .*$/m, 'UNKNOWN:')), /UNKNOWN is present but too short/);
});

test('buildThemesSystemPrompt asks for UNKNOWN as optional, and says to omit rather than invent', () => {
  const prompt = buildThemesSystemPrompt('a project');
  assert.match(prompt, /UNKNOWN: optional/);
  assert.match(prompt, /omit the line rather than invent one/);
});
