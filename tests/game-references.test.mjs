import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadGameReferences,discoverGameReferences,formatDiscoveredReferences} from '../harness/lib/game-references.mjs';
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

test('live discovery is game-only opt-in and capped at three',async()=>{
 const no=await discoverGameReferences({enabled:false,query:'vehicle simulation',fetchImpl:()=>{throw Error('must not call')}});
 assert.equal(no.status,'disabled');
 let called='';
 const found=await discoverGameReferences({enabled:true,query:'road safety',limit:20,fetchImpl:async url=>{
  called=url;return {ok:true,json:async()=>({items:Array.from({length:4},(_,i)=>({
   full_name:'org/game'+i,html_url:'https://github.com/org/game'+i,
   description:'A mock simulation',license:{spdx_id:'MIT'},updated_at:'2026-10-01T00:00:00Z'
  }))})};
 }});
 assert.equal(found.status,'ok');assert.equal(found.candidates.length,3);
 assert.match(called,/per_page=3/);assert.match(formatDiscoveredReferences(found),/metadata only/);
});
test('network failure is non-fatal and injects no unverified candidates',async()=>{
 const result=await discoverGameReferences({enabled:true,query:'games',fetchImpl:async()=>{throw Error('offline')}});
 assert.equal(result.status,'unavailable');
 assert.equal(formatDiscoveredReferences(result),'');
});
