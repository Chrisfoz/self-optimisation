import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildThemesSystemPrompt, buildThemesUserPrompt, parseThemesResponse } from '../../harness/lib/generate-themes.mjs';

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
