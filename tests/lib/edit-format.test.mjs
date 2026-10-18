import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  compileAllowlist, isEditable, isCreatable,
  buildEditFormatSpec, parseResponse, applyEdits, renderForReview,
} from '../../harness/lib/edit-format.mjs';

// Mirrors a real installation's constitution (the reference game project's),
// so this suite checks the schema against a shape that was actually used,
// not an invented one.
const allowlist = compileAllowlist({
  allowedPaths: ['carrot_maze_game.html', 'index.html', 'SELF-IMPROVEMENT.md'],
  createOnlyPaths: ['tests/game-logic/*.test.js'],
});

test('isEditable: accepts an allowed path, rejects everything else', () => {
  assert.equal(isEditable('carrot_maze_game.html', allowlist), true);
  assert.equal(isEditable('feedback.js', allowlist), false);
  assert.equal(isEditable('../../etc/passwd', allowlist), false);
  assert.equal(isEditable('/etc/passwd', allowlist), false);
});

test('isCreatable: glob matches the create-only surface, nothing else', () => {
  assert.equal(isCreatable('tests/game-logic/new-maze.test.js', allowlist), true);
  assert.equal(isCreatable('tests/pipeline/new.test.js', allowlist), false);
  assert.equal(isCreatable('tests/game-logic/../../evil.js', allowlist), false);
});

test('buildEditFormatSpec: extra field and CREATE section are opt-in', () => {
  const withExtras = buildEditFormatSpec({
    extraField: { name: 'PILLAR', description: 'which game design pillar this strengthens' },
    safetyFraming: 'and why it is safe for ages 3-8',
    createSection: { pathDescription: 'new tests/game-logic/*.test.js files', examplePath: 'tests/game-logic/<name>.test.js' },
  });
  assert.match(withExtras, /PILLAR: <which game design pillar/);
  assert.match(withExtras, /safe for ages 3-8/);
  assert.match(withExtras, /<<<CREATE>>>/);

  const bare = buildEditFormatSpec();
  assert.doesNotMatch(bare, /PILLAR/);
  assert.doesNotMatch(bare, /<<<CREATE>>>/);
});

test('buildEditFormatSpec: blocksOnly drops the response header and keeps the block contract', () => {
  const full = buildEditFormatSpec();
  const blocks = buildEditFormatSpec({ blocksOnly: true });
  assert.match(full, /^Respond in EXACTLY this format/);
  assert.match(full, /^SUMMARY:/m);
  assert.doesNotMatch(blocks, /Respond in EXACTLY|No other structure|^SUMMARY:|^RATIONALE:/m);
  // Everything from the first edit block on is identical: the parser's contract did not move.
  const from = (s) => s.slice(s.indexOf('<<<EDIT>>>'));
  assert.equal(from(blocks), from(full));
});

const SAMPLE_RESPONSE = `SUMMARY: Add pause button to maze
PILLAR: Feedback Loops
RATIONALE: Players had no way to pause. This adds a button and keyboard shortcut, safe for ages 3-8.

<<<EDIT>>>
FILE: carrot_maze_game.html
<<<SEARCH>>>
function gameLoop() {
  update();
<<<REPLACE>>>
function gameLoop() {
  if (paused) return;
  update();
<<<END>>>

<<<CREATE>>>
FILE: tests/game-logic/pause.test.js
<<<CONTENT>>>
test('pauses', () => { expect(true).toBe(true); });
<<<END>>>
`;

test('parseResponse extracts metadata, edits and creates', () => {
  const parsed = parseResponse(SAMPLE_RESPONSE, ['PILLAR']);
  assert.equal(parsed.summary, 'Add pause button to maze');
  assert.equal(parsed.pillar, 'Feedback Loops');
  assert.match(parsed.rationale, /^Players had no way/);
  assert.equal(parsed.edits.length, 1);
  assert.equal(parsed.edits[0].file, 'carrot_maze_game.html');
  assert.equal(parsed.creates.length, 1);
  assert.equal(parsed.creates[0].file, 'tests/game-logic/pause.test.js');
});

test('applyEdits: end-to-end against a real temp filesystem', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-format-test-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  fs.writeFileSync(path.join(tmp, 'carrot_maze_game.html'), 'function gameLoop() {\n  update();\n}\n');
  fs.mkdirSync(path.join(tmp, 'tests', 'game-logic'), { recursive: true });

  const parsed = parseResponse(SAMPLE_RESPONSE, ['PILLAR']);
  const result = applyEdits(parsed.edits, {
    repoRoot: tmp,
    allowlist,
    creates: parsed.creates,
    createDescription: 'new tests/game-logic/*.test.js files',
  });

  assert.deepEqual(result.errors, []);
  assert.equal(result.filesChanged.length, 2);
  const written = fs.readFileSync(path.join(tmp, 'carrot_maze_game.html'), 'utf8');
  assert.match(written, /if \(paused\) return;/);
  assert.ok(fs.existsSync(path.join(tmp, 'tests/game-logic/pause.test.js')));
});

test('applyEdits: all-or-nothing — one bad edit blocks the whole set, including a good one', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-format-test-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  fs.writeFileSync(path.join(tmp, 'carrot_maze_game.html'), 'anything\n');
  fs.writeFileSync(path.join(tmp, 'index.html'), 'irrelevant content here\n');

  const result = applyEdits(
    [
      { file: 'carrot_maze_game.html', search: 'this text does not exist anywhere', replace: 'x' },
      { file: 'index.html', search: 'irrelevant', replace: 'irrelevant' },
    ],
    { repoRoot: tmp, allowlist }
  );

  assert.ok(result.errors.length > 0);
  assert.equal(result.filesChanged.length, 0);
  assert.equal(fs.readFileSync(path.join(tmp, 'index.html'), 'utf8'), 'irrelevant content here\n');
});

test('applyEdits: non-unique SEARCH text is rejected', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-format-test-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  fs.writeFileSync(path.join(tmp, 'index.html'), 'dup\ndup\n');
  const result = applyEdits([{ file: 'index.html', search: 'dup', replace: 'x' }], { repoRoot: tmp, allowlist });
  assert.ok(result.errors.some((e) => e.includes('appears 2 times')));
});

test('applyEdits: a disallowed file is rejected even if it exists on disk', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-format-test-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  fs.writeFileSync(path.join(tmp, 'feedback.js'), 'secret();\n');
  const result = applyEdits([{ file: 'feedback.js', search: 'secret();', replace: 'x();' }], { repoRoot: tmp, allowlist });
  assert.ok(result.errors.some((e) => e.includes('not in the editable allowlist')));
});

test('applyEdits: CREATE at an already-existing path is rejected', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-format-test-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  fs.mkdirSync(path.join(tmp, 'tests', 'game-logic'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'tests', 'game-logic', 'pause.test.js'), 'x');

  const result = applyEdits([], { repoRoot: tmp, allowlist, creates: [{ file: 'tests/game-logic/pause.test.js', content: 'x' }] });
  assert.ok(result.errors.some((e) => e.includes('already exists')));
});

test('renderForReview includes the metadata and the diff markers', () => {
  const parsed = parseResponse(SAMPLE_RESPONSE, ['PILLAR']);
  const rendered = renderForReview(parsed);
  assert.match(rendered, /SUMMARY: Add pause button to maze/);
  assert.match(rendered, /PILLAR: Feedback Loops/);
  assert.match(rendered, /^- /m);
  assert.match(rendered, /^\+ /m);
});
