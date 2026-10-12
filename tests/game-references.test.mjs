import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadGameReferences} from '../harness/lib/game-references.mjs';
test('disabled project adds no reference context',()=>assert.equal(loadGameReferences({enabled:false}), ''));
test('explicit game project loads only bounded local evidence',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'game-research-'));
 try {
  fs.mkdirSync(path.join(root,'docs'));fs.writeFileSync(path.join(root,'docs/ref.md'),'A'.repeat(200));
  const context=loadGameReferences({repoRoot:root,enabled:true,relativePath:'docs/ref.md',maxCharacters:30});
  assert.ok(context.includes('A'.repeat(30)));assert.ok(!context.includes('A'.repeat(31)));
  assert.match(context,/Untrusted reference-game research/);
  assert.throws(()=>loadGameReferences({repoRoot:root,enabled:true,relativePath:'../secret'}));
  assert.equal(loadGameReferences({repoRoot:root,enabled:true,relativePath:'docs/missing.md'}),'');
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
