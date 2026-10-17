import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSymbols, extractImports, resolveImport, buildImportGraph, renderCodeMap, dependentsOf } from '../../harness/lib/code-map.mjs';

test('extractSymbols reads top-level names across languages, in file order, once each', () => {
  assert.deepEqual(extractSymbols('export async function load() {}\nfunction helper(x) {}\nexport class Store {}\nexport const LIMIT = 3;\nif (x) {}'), ['load', 'helper', 'Store', 'LIMIT']);
  assert.deepEqual(extractSymbols('def parse(row):\n    pass\nclass Mapper:\n    def run(self):\n        pass'), ['parse', 'Mapper', 'run']);
  assert.deepEqual(extractSymbols('func (s *Server) Serve() error {\n}\ntype Config struct {}'), ['Serve', 'Config']);
  assert.deepEqual(extractSymbols('pub fn main() {}\nstruct Point {}'), ['main', 'Point']);
  assert.deepEqual(extractSymbols('<canvas id="board"></canvas><div id="score">'), ['board', 'score']);
});

test('extractImports keeps relative specifiers and drops packages', () => {
  assert.deepEqual(extractImports(`import fs from 'node:fs';\nimport { a } from './a.js';\nconst b = require('../b');\nimport('./lazy.mjs');\nimport 'react';`).sort(), ['../b', './a.js', './lazy.mjs']);
  assert.deepEqual(extractImports('from .utils import x\nfrom ..pkg.mod import y\nimport os'), ['.utils', '..pkg.mod']);
  assert.deepEqual(extractImports('<script src="./game.js"></script><link rel="stylesheet" href="style.css">'), ['./game.js']);
});

test('resolveImport finds the file a specifier names, with the usual extension rules', () => {
  const files = ['src/a.js', 'src/lib/index.ts', 'src/c.ts', 'pkg/__init__.py', 'pkg/utils.py', 'pkg/sub/mod.py'];
  assert.equal(resolveImport('src/b.js', './a', files), 'src/a.js');
  assert.equal(resolveImport('src/b.js', './lib', files), 'src/lib/index.ts');
  assert.equal(resolveImport('src/b.ts', './c.js', files), 'src/c.ts');
  assert.equal(resolveImport('pkg/sub/mod.py', '..utils', files), 'pkg/utils.py');
  assert.equal(resolveImport('pkg/utils.py', '.', files), 'pkg/__init__.py');
  assert.equal(resolveImport('src/b.js', './missing', files), null);
});

test('buildImportGraph records imports and the reverse edge; dependentsOf excludes the changed files', () => {
  const src = { 'a.js': 'export function a() {}', 'b.js': "import { a } from './a.js';", 'c.js': "import { a } from './a.js';\nimport './b.js';" };
  const graph = buildImportGraph(Object.keys(src), { read: (f) => src[f] });
  assert.deepEqual(graph.importers.get('a.js').sort(), ['b.js', 'c.js']);
  assert.deepEqual(dependentsOf(['a.js'], graph.importers).sort(), ['b.js', 'c.js']);
  assert.deepEqual(dependentsOf(['a.js', 'b.js'], graph.importers), ['c.js']);
});

test('renderCodeMap lists every file it can, and says how many it could not', () => {
  const src = { 'a.js': 'export function alpha() {}', 'b.js': "import { alpha } from './a.js';\nexport const beta = 1;" };
  const graph = buildImportGraph(Object.keys(src), { read: (f) => src[f] });
  const map = renderCodeMap(graph);
  assert.match(map, /^a\.js \(26 chars\) — used by b\.js\n  alpha/m);
  assert.match(map, /b\.js \(\d+ chars\) — imports a\.js\n  beta/);
  const capped = renderCodeMap(graph, { maxChars: 60 });
  assert.match(capped, /1 more editable file\(s\) not listed/);
  assert.equal(renderCodeMap({ entries: [], importers: new Map() }), null);
});
