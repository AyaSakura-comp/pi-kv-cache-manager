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
  let live=''; const calls=[];
  const original=globalThis.fetch;
  globalThis.fetch=async(url,opts)=>{
    calls.push({url,body:opts?.body&&JSON.parse(opts.body)});
    if(url.endsWith('/slots')) return Response.json([{id:0,n_ctx:8192,is_processing:false,snapshot_filename:live}]);
    if(url.endsWith('/apply-template')) return Response.json({prompt:'formatted'});
    if(url.endsWith('action=save')) {live=JSON.parse(opts.body).filename; await fs.writeFile(path.join(current.cacheDir,live),'bin');await fs.writeFile(path.join(current.cacheDir,live+'.dft'),'draft');return Response.json({n_saved:100,n_written:3});}
    if(url.endsWith('action=restore')) {live=JSON.parse(opts.body).filename;return Response.json({n_restored:100});}
    return Response.json({});
  };
  t.after(()=>globalThis.fetch=original);
  return {root,config,calls,setLive:v=>live=v,setRuntime:v=>current=v,getRuntime:()=>current};
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
  f.setRuntime({...f.getRuntime(),generation:'restarted'});
  await h.request();assert.equal(f.calls.filter(c=>c.url.endsWith('action=restore')).length,1);
  await h.hooks.get('before_provider_request')({payload:{messages:[{role:'system',content:'changed'}],tools:[{name:'tool2'}]}},h.ctx);
  assert.equal(f.calls.filter(c=>c.url.endsWith('/completion')).length,2);
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
  assert.equal(f.calls.filter(c=>c.url.endsWith('action=restore')).length,0);
  assert.equal(await fs.readFile(path.join(f.config.cacheDir,'snap_session.bin'),'utf8'),'legacy');
});

