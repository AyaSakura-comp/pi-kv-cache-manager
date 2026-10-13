import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BaseCacheManager, computeHash } from '../dist/base-cache.js';
import { DEFAULT_CONFIG } from '../dist/config.js';
import { LruManager } from '../dist/lru-manager.js';
import extension from '../dist/index.js';
async function fixture(t) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'kv-golden-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const calls=[]; let live=''; let fail=false;
 const original=globalThis.fetch;
 globalThis.fetch=async(url,opts)=>{
  const body=opts?.body&&JSON.parse(opts.body); calls.push({url,body});
  if(url.endsWith('/apply-template'))return Response.json({prompt:`rendered:${body.messages[0].content}:${JSON.stringify(body.tools??[])}`});
  if(url.endsWith('/slots'))return Response.json([{id:0,is_processing:false,snapshot_filename:live,n_ctx:131072}]);
  if(url.endsWith('/completion')&&fail)return new Response('warm failed',{status:500});
  if(url.endsWith('action=save')) {live=body.filename;await fs.writeFile(path.join(root,live),'kv');await fs.writeFile(path.join(root,live+'.ckpt'),'checkpoint'); return Response.json({n_saved:50,n_written:2});}
  if(url.endsWith('action=restore')){live=body.filename;return Response.json({n_restored:50});}
  return Response.json({});
 };
 t.after(()=>globalThis.fetch=original);
 const config={...DEFAULT_CONFIG,cacheDir:root,runtimeIdentity:'model-A',snapshotPrefix:'kv2_sessionA_',goldenPrefix:'golden_modelA_',extensionsFingerprint:'v1',extensionLoadedAt:1,goldenCwd:root,renderedPrefixHash:'rendered-A'};
 const manager=(extra={})=>{const c={...config,...extra};return new BaseCacheManager(c,new LruManager(root,c.snapshotPrefix));};
 return {root,config,calls,manager,failWarm:(value=true)=>fail=value};
}
test('one golden filename across session namespaces; ordinary mismatches log and never overwrite',async t=>{
 const f=await fixture(t);const a=f.manager();const b=f.manager({snapshotPrefix:'kv2_sessionB_',renderedPrefixHash:'rendered-B'});
 assert.equal(a.getFilename(),b.getFilename());
 await a.ensureGolden('prefix',[{name:'tool'}]);
 const meta=await fs.readFile(a.getMetaPath(),'utf8');
 await b.ensureGolden('changed prefix',[{name:'tool2'}]);
 assert.equal(await fs.readFile(a.getMetaPath(),'utf8'),meta);
 assert.equal(f.calls.filter(c=>c.url.endsWith('/completion')).length,1);
 const warnings=(await fs.readFile(path.join(f.root,'golden-warnings.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(warnings.at(-1).type,'golden_mismatch');assert.ok(warnings.at(-1).actualHash);
 assert.ok(!JSON.stringify(warnings).includes('changed prefix'));
});
test('base-cache disabled stays disabled unless the user explicitly forces base-update',async t=>{
 const f=await fixture(t);const base=f.manager({enableBaseCache:false});
 await base.ensureGolden('prefix',[]);assert.equal(f.calls.length,0);
 await base.ensureGolden('prefix',[],true);assert.ok(await base.getBaseMetadata());
});
test('extension update refreshes once, same fingerprint does not, old loaded worker cannot roll it back',async t=>{
 const f=await fixture(t);await f.manager().ensureGolden('prefix',[]);
 const updated=f.manager({extensionsFingerprint:'v2',extensionLoadedAt:2,renderedPrefixHash:'new'});
 await updated.ensureGolden('new prefix',[]);
 assert.equal(f.calls.filter(c=>c.url.endsWith('/completion')).length,1,'audit only plans the refresh');
 const restored=await updated.checkAndRestore('new prefix',1,[]);
 assert.equal(restored.rebuilt,'extensions');
 await updated.ensureGolden('new prefix',[]);await updated.checkAndRestore('new prefix',1,[]);
 const old=f.manager();await old.ensureGolden('prefix',[]);await old.checkAndRestore('prefix',0,[]);
 assert.equal(f.calls.filter(c=>c.url.endsWith('/completion')).length,2);
 assert.equal((await updated.getBaseMetadata()).extensionsFingerprint,'v2');
});
test('extension refresh is seeded from the old golden in the new session slot',async t=>{
 const f=await fixture(t);const first=f.manager();await first.ensureGolden('prefix',[]);const oldGolden=first.getFilename();
 const updated=f.manager({extensionsFingerprint:'v2',extensionLoadedAt:2,renderedPrefixHash:'new'});
 const mark=f.calls.length;await updated.ensureGolden('new prefix',[{name:'tool2'}]);await updated.checkAndRestore('new prefix',1,[{name:'tool2'}]);
 const calls=f.calls.slice(mark);
 const restore=calls.findIndex(c=>c.url.includes('/slots/1?action=restore')&&c.body.filename===oldGolden);
 const warm=calls.findIndex(c=>c.url.endsWith('/completion'));
 assert.ok(restore>=0&&warm>restore,'old golden restored into slot 1 before the warm');
 assert.equal(warm>=0&&calls[warm].body.id_slot,1);
 const log=(await fs.readFile(path.join(f.root,'golden-warnings.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.ok(log.some(r=>r.type==='golden_refreshed'&&r.reason==='extensions'&&r.seeded===true&&r.slot===1));
});
test('extension change with an unchanged prefix adopts the new set without a warm',async t=>{
 const f=await fixture(t);await f.manager().ensureGolden('prefix',[]);
 const updated=f.manager({extensionsFingerprint:'v2',extensionLoadedAt:2});
 await updated.ensureGolden('prefix',[]);await updated.checkAndRestore('prefix',0,[]);
 assert.equal(f.calls.filter(c=>c.url.endsWith('/completion')).length,1);
 const meta=await updated.getBaseMetadata();assert.equal(meta.extensionsFingerprint,'v2');assert.equal(meta.extensionLoadedAt,2);
 await f.manager().ensureGolden('prefix',[]);
 assert.equal((await updated.getBaseMetadata()).extensionsFingerprint,'v2','older worker cannot roll the set back');
});
test('foreign cwd cannot replace the canonical golden on an extension-set change',async t=>{
 const f=await fixture(t);await f.manager().ensureGolden('prefix',[]);
 await f.manager({goldenCwd:'/some/project',extensionsFingerprint:'project-tools',extensionLoadedAt:2}).ensureGolden('project prefix',[]);
 assert.equal(f.calls.filter(c=>c.url.endsWith('/completion')).length,1);
});
test('failed extension refresh preserves the previous binary and metadata and can retry',async t=>{
 const f=await fixture(t);const old=f.manager();await old.ensureGolden('prefix',[]);const meta=await fs.readFile(old.getMetaPath(),'utf8');
 f.failWarm();const failing=f.manager({extensionsFingerprint:'v2',extensionLoadedAt:2});await failing.ensureGolden('new',[]);
 assert.notEqual((await failing.checkAndRestore('new',0,[])).rebuilt,'extensions');
 const {lastAccessedAt:_a,...before}=JSON.parse(meta);const {lastAccessedAt:_b,...after}=JSON.parse(await fs.readFile(old.getMetaPath(),'utf8'));
 assert.deepEqual(after,before,'fallback restore only touches lastAccessedAt');assert.equal(await fs.readFile(old.getBinPath()+'.ckpt','utf8'),'checkpoint');
 f.failWarm(false);const retry=f.manager({extensionsFingerprint:'v2',extensionLoadedAt:2});await retry.ensureGolden('new',[]);
 assert.equal((await retry.checkAndRestore('new',0,[])).rebuilt,'extensions');
 assert.equal((await retry.getBaseMetadata()).extensionsFingerprint,'v2');
});
test('concurrent cold managers warm only once',async t=>{
 const f=await fixture(t);await Promise.all([f.manager().ensureGolden('prefix',[]),f.manager().ensureGolden('prefix',[])]);
 assert.equal(f.calls.filter(c=>c.url.endsWith('/completion')).length,1);
});
test('separate OS processes serialize cold golden publication',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'kv-golden-process-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const worker=fileURLToPath(new URL('./fixtures/golden-worker.mjs',import.meta.url));
 const run=()=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[worker,root],{stdio:['ignore','pipe','pipe']});let stderr='';
  child.stderr.on('data',data=>stderr+=data);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(stderr)));
 });
 await Promise.all([run(),run()]);
 assert.equal((await fs.readFile(path.join(root,'warms.log'),'utf8')).trim().split('\n').length,1);
 assert.ok((await fs.readdir(root)).every(name=>!name.includes('build_')&&!name.endsWith('.lock')&&!name.endsWith('.backup')));
});
test('every outgoing request audits golden, including an already-resident session; loaded update refreshes it',async t=>{
 const f=await fixture(t);const hooks=new Map();
 extension({on:(name,fn)=>hooks.set(name,fn),registerCommand:()=>{}},{loadConfig:()=>f.config,resolve:async()=>({cacheDir:f.root,serverUrl:'http://127.0.0.1:8001',identity:'model-A',generation:'1'})});
 const ctx={cwd:f.root,model:{provider:'local-llama',baseUrl:'http://127.0.0.1:8001/v1'},sessionManager:{getSessionId:()=> 's'},getSystemPrompt:()=> 'prefix',ui:{setStatus:()=>{},notify:()=>{}}};
 const request=prompt=>hooks.get('before_provider_request')({payload:{messages:[{role:'system',content:prompt}],tools:[]}},ctx);
 await hooks.get('session_start')({extensionsFingerprint:'v1'},ctx);await request('prefix');await request('different prefix');
 assert.equal(f.calls.filter(c=>c.url.endsWith('/completion')).length,1);
 assert.match(await fs.readFile(path.join(f.root,'golden-warnings.jsonl'),'utf8'),/golden_mismatch/);
 await hooks.get('session_start')({extensionsFingerprint:'v2'},ctx);await request('updated prefix');
 assert.equal(f.calls.filter(c=>c.url.endsWith('/completion')).length,2);
});
