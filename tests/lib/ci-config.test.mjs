import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { renderWorkflowTemplate, NODE_VERSION } from '../../harness/lib/scaffold.mjs';

// The three places a supported Node version is stated, which drifted apart
// once already: package.json promised 20.6, CI ran 20, and `npm test`'s
// glob needed 21+. Every CI run failed before a single test executed, for
// weeks, because nothing checked that the three agreed.

const root = path.join(import.meta.dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const ci = loadYaml(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'));

const minimum = pkg.engines.node.match(/^>=(\d+)\.(\d+)\.(\d+)$/);

test('package.json declares an exact minimum Node version', () => {
  assert.ok(minimum, `engines.node should be ">=X.Y.Z", got ${pkg.engines.node}`);
});

test('CI runs the suite on the exact minimum package.json declares', () => {
  const matrix = ci.jobs.test.strategy.matrix.node.map(String);
  assert.equal(matrix[0], pkg.engines.node.slice(2), 'the first matrix entry is the declared minimum, not a floating major');
});

test('the test command passes a glob, so the minimum must be a Node that expands one', () => {
  // node --test accepts glob patterns from Node 21; before that the pattern
  // is looked up as a literal path and nothing runs.
  assert.match(pkg.scripts.test, /node --test ".*\*.*"/);
  assert.ok(Number(minimum[1]) >= 21, `node --test globs need Node 21+, engines says ${pkg.engines.node}`);
});

test('CI runs npm test — the same command a contributor runs', () => {
  const runs = ci.jobs.test.steps.map((s) => s.run).filter(Boolean);
  assert.ok(runs.includes('npm test'));
});

test('the generated workflow runs the harness on a Node that satisfies engines', () => {
  assert.ok(Number(NODE_VERSION) >= Number(minimum[1]), `scaffold.mjs NODE_VERSION ${NODE_VERSION} is below engines ${pkg.engines.node}`);
  const template = fs.readFileSync(path.join(root, 'harness/templates/workflow.yml.tmpl'), 'utf8');
  const out = renderWorkflowTemplate(template, {
    projectId: 'p', providers: [{ name: 'anthropic', envKey: 'ANTHROPIC_API_KEY' }], allowedPaths: ['a'], testCommands: ['npm test'],
  });
  const setup = loadYaml(out).jobs['self-improve'].steps.find((s) => String(s.uses).startsWith('actions/setup-node@'));
  assert.equal(String(setup.with['node-version']), NODE_VERSION);
});

test('a CRLF template (a Windows checkout with core.autocrlf) renders to LF only', () => {
  const template = fs.readFileSync(path.join(root, 'harness/templates/workflow.yml.tmpl'), 'utf8').replace(/\r?\n/g, '\r\n');
  const out = renderWorkflowTemplate(template, {
    projectId: 'p', providers: [{ name: 'anthropic', envKey: 'ANTHROPIC_API_KEY' }], allowedPaths: ['a'], testCommands: ['npm test'],
  });
  assert.ok(!out.includes('\r'), 'no carriage return survives rendering');
  assert.doesNotThrow(() => loadYaml(out));
});
