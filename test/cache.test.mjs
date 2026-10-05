import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import extension from '../dist/index.js';
import { LruManager } from '../dist/lru-manager.js';
import { BaseCacheManager } from '../dist/base-cache.js';
import { CheckpointEngine } from '../dist/checkpoint-engine.js';
import { SlotManager } from '../dist/slot-manager.js';
import { DEFAULT_CONFIG, loadConfig } from '../dist/config.js';

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'kv-cache-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const n of ['A','B','old']) await fs.mkdir(path.join(root,n));
  const config={...DEFAULT_CONFIG,cacheDir:path.join(root,'A'),snapshotPrefix:'kv2_fixture_',runtimeIdentity:'fixture',minTokensThreshold:1};
  let current={cacheDir:config.cacheDir,serverUrl:'http://127.0.0.1:8001',identity:'a',generation:'pid1'};
  let live=''; const calls=[]; const state={templateDown:false};
  const original=globalThis.fetch;
  globalThis.fetch=async(url,opts)=>{
    calls.push({url,body:opts?.body&&JSON.parse(opts.body)});
    if(url.endsWith('/slots')) return Response.json([{id:0,n_ctx:8192,is_processing:false,snapshot_filename:live}]);
    if(url.endsWith('/apply-template')) {
      // Like a real chat template: renders system + tools; thinking switches only touch the
      // generation prompt, while a template kwarg such as system_banner changes the prefix.
      const b=JSON.parse(opts.body);
      if(state.templateDown) return new Response('no template',{status:501});
      return Response.json({prompt:`formatted:${b.messages[0].content}:${JSON.stringify(b.tools??[])}:${b.chat_template_kwargs?.system_banner??''}`});
    }
    if(url.endsWith('action=save')) {live=JSON.parse(opts.body).filename; await fs.writeFile(path.join(current.cacheDir,live),'bin');await fs.writeFile(path.join(current.cacheDir,live+'.dft'),'draft');return Response.json({n_saved:100,n_written:3});}
    if(url.endsWith('action=restore')) {live=JSON.parse(opts.body).filename;return Response.json({n_restored:100});}
    return Response.json({});
  };
  t.after(()=>globalThis.fetch=original);
  return {root,config,calls,state,setLive:v=>live=v,setRuntime:v=>current=v,getRuntime:()=>current};
}

test('golden filename alone cannot bypass prompt/tool metadata hash; warm is not restore',async t=>{
  const f=await fixture(t); const lru=new LruManager(f.config.cacheDir,f.config.snapshotPrefix);
  const base=new BaseCacheManager(f.config,lru); const engine=new CheckpointEngine(f.config,lru);
  const slots=new SlotManager(f.config,lru,engine,base);
  f.setLive('base_system_prompt.bin');
  const r=await slots.ensureSlotForSession('new','changed prompt',[{name:'newTool'}]);
  assert.equal(r.restored,false);assert.equal(r.warmed,true);
  assert.ok(f.calls.some(c=>c.url.endsWith('/completion')));
  assert.ok(f.calls.some(c=>c.body?.filename?.startsWith('kv2_fixture_')));
});

test('runtime change during activation cannot fall through to an erase on the new server',async t=>{
  const f=await fixture(t);let checks=0;
  f.config.assertCurrent=async()=>{if(++checks>1)throw Error('changed');};
  f.setLive('unrelated.bin');
  const lru=new LruManager(f.config.cacheDir,f.config.snapshotPrefix);
  const slots=new SlotManager(f.config,lru,new CheckpointEngine(f.config,lru),new BaseCacheManager(f.config,lru));
  await assert.rejects(slots.ensureSlotForSession('session','prefix',[]),/changed/);
  assert.equal(f.calls.filter(c=>c.url.endsWith('action=erase')).length,0);
});

test('LRU does not remove legacy or orphan metadata and preserves unrelated sidecars',async t=>{
  const f=await fixture(t);
  const orphan=path.join(f.config.cacheDir,'orphan.meta.json'); await fs.writeFile(orphan,'{}');
  await new LruManager(f.config.cacheDir,f.config.snapshotPrefix).listSnapshots();
  assert.equal(await fs.readFile(orphan,'utf8'),'{}');
});

test('LRU disk usage includes checkpoint, draft, and media sidecars',async t=>{
  const f=await fixture(t); const lru=new LruManager(f.config.cacheDir,f.config.snapshotPrefix);
  const filename=`${f.config.snapshotPrefix}usage.bin`;
  for (const [suffix,size] of [['',3],['.dft',5],['.ckpt',7],['.media.json',2]]) {
    await fs.writeFile(path.join(f.config.cacheDir,filename+suffix),Buffer.alloc(size));
  }
  await lru.writeMetadata(path.join(f.config.cacheDir,filename.replace(/\.bin$/,'.meta.json')),
    {sessionId:'usage',tokenCount:1,fileSizeBytes:0,createdAt:new Date(0).toISOString(),lastAccessedAt:new Date(0).toISOString(),promptPrefixHash:'x'});
  const [snapshot]=await lru.listSnapshots();
  assert.equal(snapshot.meta.fileSizeBytes,17);
});

test('LRU eviction removes checkpoint sidecar with its snapshot',async t=>{
  const f=await fixture(t); const lru=new LruManager(f.config.cacheDir,f.config.snapshotPrefix);
  const filename=`${f.config.snapshotPrefix}evict.bin`;
  const paths=['','.dft','.ckpt','.media.json'].map(suffix=>path.join(f.config.cacheDir,filename+suffix));
  for (const file of paths) await fs.writeFile(file,'x');
  await lru.writeMetadata(path.join(f.config.cacheDir,filename.replace(/\.bin$/,'.meta.json')),
    {sessionId:'evict',tokenCount:1,fileSizeBytes:0,createdAt:new Date(0).toISOString(),lastAccessedAt:new Date(0).toISOString(),promptPrefixHash:'x'});
  const result=await lru.enforceLRU({...f.config,maxSessions:0});
  assert.equal(result.freedBytes,4);
  for (const file of paths) await assert.rejects(fs.access(file));
});

test('LRU enforces global maxDiskUsageGb cross-namespace evicting oldest first',async t=>{
  const f=await fixture(t);
  const nsA='kv2_nsA_';
  const nsB=f.config.snapshotPrefix;
  const lruB=new LruManager(f.config.cacheDir,nsB);

  // Snapshot in old namespace A (10 bytes, lastAccessedAt: 1000)
  const fileA=path.join(f.config.cacheDir,`${nsA}old.bin`);
  await fs.writeFile(fileA,Buffer.alloc(10));
  await fs.writeFile(path.join(f.config.cacheDir,`${nsA}old.meta.json`),
    JSON.stringify({sessionId:'old',tokenCount:1,fileSizeBytes:10,createdAt:new Date(1000).toISOString(),lastAccessedAt:new Date(1000).toISOString(),namespace:nsA}));

  // Snapshot in current namespace B (10 bytes, lastAccessedAt: 2000)
  const fileB=path.join(f.config.cacheDir,`${nsB}new.bin`);
  await fs.writeFile(fileB,Buffer.alloc(10));
  await lruB.writeMetadata(path.join(f.config.cacheDir,`${nsB}new.meta.json`),
    {sessionId:'new',tokenCount:1,fileSizeBytes:10,createdAt:new Date(2000).toISOString(),lastAccessedAt:new Date(2000).toISOString(),promptPrefixHash:'x'});

  // Total is 20 bytes. Set maxDiskUsageGb so maxBytes is 15 bytes
  const maxDiskUsageGb = 15 / (1024*1024*1024);
  const result=await lruB.enforceLRU({...f.config,maxSessions:10,maxDiskUsageGb});

  assert.equal(result.freedBytes,10);
  assert.deepEqual(result.prunedFiles,[`${nsA}old.bin`]);
  await assert.rejects(fs.access(fileA));
  assert.ok(await fs.access(fileB).then(()=>true,()=>false));
});

test('global LRU preserves legacy and mismatched-namespace binaries even over quota',async t=>{
  const f=await fixture(t);const lru=new LruManager(f.config.cacheDir,f.config.snapshotPrefix);
  const protectedFiles=[
    ['legacy',{}],
    ['kv2_foreign_snapshot',{namespace:'kv2_other_'}],
    ['kv2_fixture_unbound',{namespace:'legacy_'}],
  ];
  for(const [name,meta] of protectedFiles) {
    await fs.writeFile(path.join(f.config.cacheDir,`${name}.meta.json`),JSON.stringify(meta));
    for(const suffix of ['','.dft','.ckpt','.media.json'])
      await fs.writeFile(path.join(f.config.cacheDir,`${name}.bin${suffix}`),'keep');
  }
  assert.deepEqual(await lru.listSnapshots(true),[],'unbound metadata is not extension ownership');
  const result=await lru.enforceLRU({...f.config,maxSessions:0,maxDiskUsageGb:0});
  assert.deepEqual(result.prunedFiles,[]);
  for(const [name] of protectedFiles) {
    assert.ok(await fs.readFile(path.join(f.config.cacheDir,`${name}.meta.json`),'utf8'));
    for(const suffix of ['','.dft','.ckpt','.media.json'])
      assert.equal(await fs.readFile(path.join(f.config.cacheDir,`${name}.bin${suffix}`),'utf8'),'keep');
  }
});

test('configuration loading has no filesystem side effects and honors cwd',async t=>{
  const f=await fixture(t); await fs.mkdir(path.join(f.root,'.pi'));
  const missing=path.join(f.root,'must-not-create');
  await fs.writeFile(path.join(f.root,'.pi/settings.json'),JSON.stringify({kvCache:{cacheDir:missing,maxSessions:7}}));
  assert.equal(loadConfig(f.root).maxSessions,7);
  await assert.rejects(fs.access(missing));
});

function harness(f) {
  const hooks=new Map(); let command;
  extension({on:(name,fn)=>hooks.set(name,fn),registerCommand:(_n,c)=>command=c},
    {resolve:async(baseUrl)=>{f.resolutions?.push(baseUrl);const r=f.getRuntime();if(!r)throw Error('unverified');return r;},loadConfig:()=>({...f.config,cacheDir:path.join(f.root,'old')})});
  const notices=[];
  const ctx={cwd:f.root,model:{provider:'local-llama',baseUrl:'http://127.0.0.1:8001/v1'},hasUI:true,
    sessionManager:{getSessionId:()=> 'session',getSessionName:()=> 'fixture'},getSystemPrompt:()=> 'system',getContextUsage:()=>({tokens:100}),
    ui:{setStatus:()=>{},notify:m=>notices.push(m)}};
  const request=()=>hooks.get('before_provider_request')({payload:{messages:[{role:'system',content:'system'}],tools:[{name:'tool'}]}},ctx);
  return {hooks,ctx,request,notices,command:()=>command};
}

test('existing worker refreshes A -> B -> A and same-folder LoRA; legacy untouched; restart clears RAM',async t=>{
  const f=await fixture(t);const h=harness(f);
  await fs.writeFile(path.join(f.root,'old','orphan.meta.json'),'{}');
  await h.request();assert.equal(f.calls.filter(c=>c.url.endsWith('/completion')).length,1);
  await h.request();assert.equal(f.calls.filter(c=>c.url.endsWith('/completion')).length,1);
  f.setRuntime({cacheDir:path.join(f.root,'B'),serverUrl:'http://127.0.0.1:8001',identity:'b',generation:'pid2'});
  await h.request();assert.equal(f.calls.filter(c=>c.url.endsWith('/completion')).length,2);
  f.setRuntime({cacheDir:path.join(f.root,'A'),serverUrl:'http://127.0.0.1:8001',identity:'a',generation:'pid3'});
  await h.request();assert.ok(f.calls.some(c=>c.url.endsWith('action=restore')));
  f.setRuntime({...f.getRuntime(),identity:'lora2'}); await h.request();
  assert.equal(f.calls.filter(c=>c.url.endsWith('/completion')).length,3);
  assert.equal(await fs.readFile(path.join(f.root,'old','orphan.meta.json'),'utf8'),'{}');
  assert.ok(!(await fs.readdir(path.join(f.root,'old'))).some(n=>n.endsWith('.bin')));
  assert.ok(h.notices.every(n=>!n.includes('Restored')||!n.includes(': 0 tokens')));
});

test('unavailable discovery and non-llama never issue slot calls, including after previously active runtime',async t=>{
  const f=await fixture(t);const h=harness(f);await h.request();f.setRuntime(null);
  const n=f.calls.length;const payload={id_slot:9,messages:[],tools:[]};
  await h.hooks.get('before_provider_request')({payload},h.ctx);
  assert.equal(payload.id_slot,undefined);assert.equal(f.calls.length,n);
  await h.hooks.get('turn_end')({},h.ctx);assert.equal(f.calls.length,n);
  h.ctx.model={provider:'openai',baseUrl:'http://127.0.0.1:8001/v1'};
  await h.request();assert.equal(f.calls.length,n);
});

test('old delayed checkpoint cannot commit metadata after runtime switches',async t=>{
  const f=await fixture(t);const h=harness(f);await h.request();
  const fetch=globalThis.fetch; let release; let started;
  const reached=new Promise(r=>started=r);
  globalThis.fetch=async(url,opts)=>{if(url.endsWith('action=save')) {started();await new Promise(r=>release=r);}return fetch(url,opts);};
  const save=h.hooks.get('turn_end')({},h.ctx);await reached;
  f.setRuntime({cacheDir:path.join(f.root,'B'),serverUrl:'http://127.0.0.1:8001',identity:'b',generation:'pid2'});
  const next=h.request();
  await Promise.resolve();
  assert.equal(f.calls.filter(c=>c.url.endsWith('/completion')).length,1,'next activation waits for old checkpoint');
  release();await save;
  const metas=(await fs.readdir(path.join(f.root,'A'))).filter(n=>n.includes('snap_session.meta'));
  for (const name of metas) assert.equal(JSON.parse(await fs.readFile(path.join(f.root,'A',name),'utf8')).pending,true);
  assert.ok(!(await fs.readdir(path.join(f.root,'B'))).some(n=>n.endsWith('.meta.json')));
  globalThis.fetch=fetch; await next;
});

test('selected endpoint, not stale configured 8001, controls every API request',async t=>{
  const f=await fixture(t); f.resolutions=[];
  f.setRuntime({...f.getRuntime(),serverUrl:'http://127.0.0.1:8002'});
  const h=harness(f);h.ctx.model={provider:'another-local',baseUrl:'http://127.0.0.1:8002/v1'};
  await h.request();
  assert.ok(f.resolutions.length>0);assert.ok(f.resolutions.every(u=>u==='http://127.0.0.1:8002/v1'));
  assert.ok(f.calls.every(c=>c.url.startsWith('http://127.0.0.1:8002/')));
});

test('per-request LoRA overrides fail safe rather than warming with server default scales',async t=>{
  const f=await fixture(t);const h=harness(f);
  const payload={messages:[{role:'system',content:'prefix'}],tools:[],lora:[{id:0,scale:0.5}]};
  await h.hooks.get('before_provider_request')({payload},h.ctx);
  assert.equal(payload.id_slot,undefined);assert.equal(f.calls.length,0);
});

test('same runtime restart and full serialized tool/prompt changes do not keep RAM shortcut',async t=>{
  const f=await fixture(t);const h=harness(f);await h.request();
  const restores=f.calls.filter(c=>c.url.endsWith('action=restore')).length;
  f.setRuntime({...f.getRuntime(),generation:'restarted'});
  await h.request();assert.equal(f.calls.filter(c=>c.url.endsWith('action=restore')).length,restores+1);
  await h.hooks.get('before_provider_request')({payload:{messages:[{role:'system',content:'changed'}],tools:[{name:'tool2'}]}},h.ctx);
  assert.equal(f.calls.filter(c=>c.url.endsWith('/completion')).length,1,'ordinary differences must not create another golden');
  assert.match(await fs.readFile(path.join(f.config.cacheDir,'golden-warnings.jsonl'),'utf8'),/golden_mismatch/);
  const warm=f.calls.filter(c=>c.url.endsWith('/apply-template')).at(-1);
  assert.equal(warm.body.messages[0].content,'changed');assert.equal(warm.body.tools[0].name,'tool2');
  assert.equal(warm.body.chat_template_kwargs.preserve_thinking,true);
});

test('golden restores only matching metadata hash and leaves .dft sidecar paired',async t=>{
  const f=await fixture(t);const lru=new LruManager(f.config.cacheDir,f.config.snapshotPrefix);
  const base=new BaseCacheManager(f.config,lru);
  const miss=await base.checkAndRestore('prefix',0,[{name:'a'}]);assert.equal(miss.status,'miss');
  await base.warmAndSave('prefix',miss.hash,0,[{name:'a'}]);
  assert.equal((await base.checkAndRestore('prefix',0,[{name:'b'}])).status,'miss');
  assert.equal((await base.checkAndRestore('other prefix',0,[{name:'a'}])).status,'miss');
  assert.equal((await base.checkAndRestore('prefix',0,[{name:'a'}])).status,'hit');
  assert.equal(await fs.readFile(base.getBinPath()+'.dft','utf8'),'draft');
});

test('unbound legacy session binary and matching legacy golden metadata are never restored',async t=>{
  const f=await fixture(t);const h=harness(f);
  await fs.writeFile(path.join(f.config.cacheDir,'snap_session.bin'),'legacy');
  await fs.writeFile(path.join(f.config.cacheDir,'snap_session.meta.json'),'{}');
  await fs.writeFile(path.join(f.config.cacheDir,'base_system_prompt.bin'),'legacy');
  await h.request();
  assert.ok(f.calls.filter(c=>c.url.endsWith('action=restore')).every(c=>c.body.filename.startsWith('golden_')));
  assert.equal(await fs.readFile(path.join(f.config.cacheDir,'snap_session.bin'),'utf8'),'legacy');
});


test('namespace follows the rendered system prefix: thinking on/off and budgets share it, prefix-changing template kwargs split it',async t=>{
  const namespace=async(extra,setup)=>{
    const f=await fixture(t);setup?.(f);const h=harness(f);
    await h.hooks.get('before_provider_request')({payload:{messages:[{role:'system',content:'system'}],tools:[{name:'tool'}],...extra}},h.ctx);
    await h.hooks.get('turn_end')({},h.ctx);
    const saved=f.calls.find(c=>c.url.endsWith('action=save') && c.body?.filename?.includes('_snap_'))?.body?.filename;
    assert.ok(saved,'a snapshot was saved');
    return saved.match(/^(kv2_[0-9a-f]+)_/)[1];
  };
  const on=await namespace({thinking_budget_tokens:2048,max_completion_tokens:16384,chat_template_kwargs:{enable_thinking:true}});
  const off=await namespace({max_completion_tokens:16384,temperature:0.6,chat_template_kwargs:{enable_thinking:false}});
  assert.equal(off,on,'thinking on/off, budget, length and sampling leave the rendered prefix unchanged');
  const banner=await namespace({chat_template_kwargs:{enable_thinking:true,system_banner:'x'}});
  assert.notEqual(banner,on,'a template kwarg that changes the rendered prefix gets its own namespace');
  const downOn=await namespace({seed:1,chat_template_kwargs:{enable_thinking:true}},f=>f.state.templateDown=true);
  const downOff=await namespace({seed:1,chat_template_kwargs:{enable_thinking:false}},f=>f.state.templateDown=true);
  assert.notEqual(downOff,downOn,'without a rendered prefix, template kwargs still split the namespace');
});

test('final turn and agent end save an unchanged leaf only once even with zero token increment',async t=>{
  const f=await fixture(t);f.config.stepTokensIncrement=0;const h=harness(f);
  let leaf='answer-1';h.ctx.sessionManager.getLeafId=()=>leaf;
  await h.request();
  const saves=()=>f.calls.filter(c=>c.url.endsWith('action=save') && c.body?.filename?.includes('_snap_')).length;
  await h.hooks.get('turn_end')({},h.ctx);
  await h.hooks.get('agent_end')({},h.ctx);
  assert.equal(saves(),1,'agent_end must not rewrite the final turn snapshot');
  leaf='answer-2';
  await h.hooks.get('turn_end')({},h.ctx);
  await h.hooks.get('agent_end')({},h.ctx);
  assert.equal(saves(),2,'a new leaf with the same token estimate still needs its own save');
  await h.hooks.get('session_switch')({},h.ctx);
  await h.request();
  await h.hooks.get('agent_end')({},h.ctx);
  assert.equal(saves(),3,'lifecycle invalidation must clear the deduplication marker');
});

test('agent end retries a failed final-turn save for the same leaf',async t=>{
  const f=await fixture(t);f.config.stepTokensIncrement=0;const h=harness(f);
  h.ctx.sessionManager.getLeafId=()=> 'answer';await h.request();
  const fetch=globalThis.fetch;let attempts=0;
  globalThis.fetch=async(url,opts)=>{
    if(url.endsWith('action=save') && JSON.parse(opts.body).filename.includes('_snap_')) {
      if(++attempts===1) return Response.json({error:{message:'test disk failure'}},{status:500});
    }
    return fetch(url,opts);
  };
  await h.hooks.get('turn_end')({},h.ctx);
  await h.hooks.get('agent_end')({},h.ctx);
  assert.equal(attempts,2,'failed saves cannot mark a leaf as checkpointed');
});

test('a turn ending in tool calls does not save (the next request follows at once); the run end does',async t=>{
  const f=await fixture(t);const h=harness(f);await h.request();
  const saves=()=>f.calls.filter(c=>c.url.endsWith('action=save') && c.body?.filename?.includes('_snap_')).length;
  await h.hooks.get('turn_end')({toolResults:[{toolCallId:'x'}]},h.ctx);
  assert.equal(saves(),0);
  await h.hooks.get('agent_end')({},h.ctx);
  assert.equal(saves(),1);
});
