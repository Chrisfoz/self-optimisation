import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildNoGenerationEmail, NO_GENERATION_REASONS } from '../../harness/lib/notify.mjs';
import { renderWorkflowTemplate } from '../../harness/lib/scaffold.mjs';

/* A cycle with no generation must still say WHICH kind of nothing happened.
 *
 * In the reference implementation these outcomes were collapsed three
 * separate times, each collapse shipped, and each was found only after a
 * month's email failed to arrive. The worst of the three sent "checked every
 * lab, nothing new" for a cycle in which the release check had crashed — an
 * all-clear that is strictly worse than silence, because silence prompts a
 * question.
 */

const reasons = Object.values(NO_GENERATION_REASONS);

test('every reason produces a distinct subject line', () => {
  const subjects = reasons.map((reason) => buildNoGenerationEmail({ reason }).subject);
  assert.equal(new Set(subjects).size, reasons.length, `subjects collided: ${subjects.join(' | ')}`);
});

test('every reason produces a non-empty body', () => {
  for (const reason of reasons) {
    const { body } = buildNoGenerationEmail({ reason });
    assert.ok(body.length > 80, `${reason} body is too short to be a real email`);
  }
});

test('only the genuinely quiet cycle claims the labs were checked', () => {
  const quiet = buildNoGenerationEmail({ reason: NO_GENERATION_REASONS.QUIET, labs: ['anthropic', 'qwen'] });
  assert.match(quiet.body, /Checked every watched lab/i);
  assert.match(quiet.body, /anthropic, qwen/);

  for (const reason of reasons.filter((r) => r !== NO_GENERATION_REASONS.QUIET)) {
    const { body } = buildNoGenerationEmail({ reason, labs: ['anthropic', 'qwen'] });
    assert.doesNotMatch(body, /Checked every watched lab/i, `${reason} must not claim the labs were checked`);
  }
});

test('a crashed release check says outright that the cycle is unknown, not quiet', () => {
  const { subject, body } = buildNoGenerationEmail({
    reason: NO_GENERATION_REASONS.CHECK_FAILED,
    detail: 'job result: failure',
  });
  assert.match(subject, /unknown, not quiet/i);
  assert.match(body, /NOT the same as a quiet cycle/i);
  assert.match(body, /job result: failure/);
});

test('an unreachable-candidate cycle is not reported as nothing shipping', () => {
  const { subject, body } = buildNoGenerationEmail({
    reason: NO_GENERATION_REASONS.ALL_UNREACHABLE,
    detail: 'kimi/kimi-k3: product is not activated',
  });
  assert.match(subject, /shipped, but nothing could reach it/i);
  assert.match(body, /not a quiet cycle/i);
  assert.match(body, /product is not activated/);
});

test('the run URL is included when given, and simply absent when not', () => {
  const withUrl = buildNoGenerationEmail({ reason: NO_GENERATION_REASONS.QUIET, runUrl: 'https://example/run/1' });
  assert.match(withUrl.body, /https:\/\/example\/run\/1/);
  const without = buildNoGenerationEmail({ reason: NO_GENERATION_REASONS.QUIET });
  assert.doesNotMatch(without.body, /Run:/);
});

test('an unrecognised reason falls back to the quiet email rather than throwing', () => {
  // A caller passing something unexpected should still get an email out.
  const { subject } = buildNoGenerationEmail({ reason: 'something-new' });
  assert.equal(subject, buildNoGenerationEmail({ reason: NO_GENERATION_REASONS.QUIET }).subject);
});

/* The library being right is not enough — the generated workflow has to
 * actually reach it. This is the wiring half, and it is the half that
 * silently failed in the reference implementation: the digest step was gated
 * on a generation number existing, so none of the above could ever be sent.
 */

const ANSWERS = {
  providers: [{ name: 'anthropic', envKey: 'ANTHROPIC_API_KEY' }],
  reviewer: { provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
  testCommands: ['npm test'],
  allowedPaths: ['src/'],
  notify: { envKey: 'SENDGRID_API_KEY' },
};

test('the scaffolded digest step is NOT gated on a generation number', () => {
  const wf = renderWorkflowTemplate(readFileSync('harness/templates/workflow.yml.tmpl', 'utf8'), ANSWERS);
  const step = wf.slice(wf.indexOf('- name: Send the generation digest'));

  assert.doesNotMatch(
    step.slice(0, 200),
    /if: always\(\) && steps\.gen\.outputs\.number/,
    'gating on a generation number makes every no-generation email unreachable'
  );
  assert.match(step.slice(0, 200), /if: always\(\)/);
});

test('the scaffolded digest step receives the signals it needs to tell the cases apart', () => {
  const wf = renderWorkflowTemplate(readFileSync('harness/templates/workflow.yml.tmpl', 'utf8'), ANSWERS);
  const step = wf.slice(wf.indexOf('- name: Send the generation digest'), wf.indexOf('- name: Send an escalation notice'));

  for (const key of ['CHECK_RESULT', 'PREFLIGHT_RESULT', 'RELEASE_DETECTED', 'LABS_WATCHED', 'RUN_URL']) {
    assert.ok(step.includes(`${key}:`), `digest step is missing ${key}`);
  }
  assert.match(step, /CHECK_RESULT: \$\{\{ steps\.check\.outcome \}\}/);
});

test('the release check cannot kill the job before the digest reports it', () => {
  const wf = renderWorkflowTemplate(readFileSync('harness/templates/workflow.yml.tmpl', 'utf8'), ANSWERS);
  const checkStep = wf.slice(wf.indexOf('- name: Check for new model releases'), wf.indexOf('- name: Commit the updated model snapshot'));
  assert.match(checkStep, /continue-on-error: true/);
  assert.match(checkStep, /release-detected=/, 'the check must emit releaseDetected for the digest to read');
});

test('the probe step does not overwrite releaseDetected', () => {
  const wf = renderWorkflowTemplate(readFileSync('harness/templates/workflow.yml.tmpl', 'utf8'), ANSWERS);
  const probeStep = wf.slice(wf.indexOf('- name: Probe reachability'), wf.indexOf('- name: Run this project'));
  assert.doesNotMatch(probeStep, /release-detected=/, 'releaseDetected must survive the probe unchanged');
  assert.match(probeStep, /dropped=/, 'the probe should report what it dropped, for the unreachable email');
});
