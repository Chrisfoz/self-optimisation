/**
 * A small, real project for the harness to improve — the target of the
 * mock-labs end-to-end run (tests/e2e/mock-labs.test.mjs), and of the manual
 * rehearsal docs/Harness-E2E-Test-Plan-2026-09.md describes.
 *
 * Real in every way the scripts care about: a git repository on a branch,
 * one editable file with the marker the mock's edits anchor on, a test
 * suite that actually runs (`node --test`), both briefs with no placeholders
 * left, and an adapter that watches every lab this harness ships, pins the
 * implement and review seats to different labs, configures the shipped
 * evaluator plugin, a committed goal, and a themes-review cadence short
 * enough for a test to reach.
 *
 * harness/ and node_modules/ are symlinked in, the way tests/scripts/
 * rehearse.test.mjs does it, so the scripts under test are the ones in this
 * checkout.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { MARKER } from './mock-labs.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Scratch</title></head>
<body>
<h1>Scratch project</h1>
<p>A page the harness is allowed to improve.</p>
${MARKER}
</body>
</html>
`;

/**
 * The project's own tests: the page is intact, the marker survived, and no
 * generation left an empty paragraph behind. A model whose edits remove the
 * marker fails this — which is how the in-loop repair path gets exercised.
 */
export const TEST_FILE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('the page still has its marker', () => {
  assert.ok(html.includes(${JSON.stringify(MARKER)}), 'marker missing');
});

test('every generation paragraph names its author', () => {
  for (const m of html.matchAll(/<p data-generation="([^"]*)">/g)) {
    assert.ok(m[1].trim(), 'an unattributed generation paragraph');
  }
});

test('the document is still one html element', () => {
  assert.equal((html.match(/<html/g) || []).length, 1);
});
`;

export const AGENT_BRIEF = `---
name: scratch-improvement-agent
description: "Suggests one small improvement to the scratch page."
---

You improve a single static HTML page, index.html. Keep every change small,
additive and attributed. Never remove the marker comment; every generation
appends beneath it. The audience is a first-time visitor who wants to see
what changed most recently.
`;

export const REVIEWER_BRIEF = `---
name: scratch-review-engineer
description: "Reviews one change to the scratch page."
---

You review a change to a single static HTML page. Approve only a change that
is additive, attributed, and leaves the marker comment intact. Reject
anything that alters existing content or leaves the page malformed.
`;

/**
 * @param {object} [opts]
 * @param {string[]} [opts.watched]  Labs to watch; default every registered lab.
 * @param {number} [opts.cadence]  Themes-review cadence in generations.
 * @param {number} [opts.resurfaceAfter]  Escalation resurface window.
 * @param {string} [opts.root]  Where to create it; default a temp dir.
 */
export function adapterYaml({
  watched = ['anthropic', 'openai', 'google', 'moonshot', 'deepseek', 'qwen', 'xai', 'meta', 'zai'],
  cadence = 2,
  resurfaceAfter = 1,
  implementModel = 'claude-opus-5',
  reviewModel = 'gpt-5.5',
} = {}) {
  return `project:
  id: scratch-page
  description: a one-page static site the harness is allowed to improve one paragraph at a time
  repository: https://github.com/example/scratch-page
  default_branch: main
  goal:
    statement: >
      Become a page where a first-time visitor can see, at a glance, what the
      last change was and who made it.
    holds:
      - The marker comment is never removed.
    away_from:
      - Anything that hides earlier generations' lines.

providers:
  watched:
${watched.map((w) => `    - ${w}`).join('\n')}
  snapshot_path: .agent/model-snapshot.json
  max_fanout: 8

constitution:
  allowed_paths:
    - index.html
  create_only_paths: []
  frozen_paths:
    - ".github/**"
    - ".claude/**"
    - project-adapter.yml
    - "tests/**"
  append_only_paths: []
  frozen_fields: {}
  churn_ceiling:
    max_files: 5
    max_lines: 200
  approval_class: human-approval-required

roles:
  agent_brief_path: .claude/agents/improve.md
  reviewer_brief_path: .claude/agents/review.md
  suggest:
    max_output_tokens: 8000
  implement:
    model: ${implementModel}
  review:
    model: ${reviewModel}
  rank:
    model: null
  refine:
    max_attempts: 3

memory:
  escalation_ledger: docs/escalations/ledger.json
  escalation_consensus:
    models: 3
    labs: 2
    resurface_after: ${resurfaceAfter}
  themes_review:
    dir: docs/themes
    cadence_generations: ${cadence}

context:
  generations_dir: docs/generations
  runtime_evidence_dir: docs/runtime
  test_files:
    - tests/page.test.mjs
  purposes:
    index.html: the one page
  history_limit: 3
  scope_required: 2
  ambition: earned

budget:
  max_generation_tokens: 200000

evaluation:
  test_commands:
    - node --test tests/page.test.mjs
  test_in_loop: true
  test_timeout_seconds: 120
  evaluators:
    - module: harness/plugins/evaluators/source-weight/index.mjs
      config:
        paths: ['index.html']

cadence:
  trigger: model-release
  schedule_cron: '0 0 1 * *'

deployment:
  verify_strategy: none
  ci:
    runner: ubuntu-latest
`;
}

export function createScratchProject({ root = null, ...adapterOpts } = {}) {
  const dir = root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-page-'));
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  fs.symlinkSync(path.join(REPO_ROOT, 'harness'), path.join(dir, 'harness'));
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(dir, 'node_modules'));

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'scratch@example.com');
  git('config', 'user.name', 'Scratch');
  git('config', 'commit.gpgsign', 'false');

  fs.writeFileSync(path.join(dir, 'index.html'), INDEX_HTML);
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests/page.test.mjs'), TEST_FILE);
  fs.mkdirSync(path.join(dir, '.claude/agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude/agents/improve.md'), AGENT_BRIEF);
  fs.writeFileSync(path.join(dir, '.claude/agents/review.md'), REVIEWER_BRIEF);
  fs.writeFileSync(path.join(dir, 'project-adapter.yml'), adapterYaml(adapterOpts));
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\nharness\n.env\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'scratch-page', private: true, type: 'module' }, null, 2) + '\n');

  git('add', '-A');
  git('commit', '-q', '-m', 'Scratch page baseline');
  return { dir, git };
}
