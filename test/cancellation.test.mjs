import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchSlots, saveSlot, restoreSlot, eraseSlot} from '../dist/checkpoint-engine.js';
import extension from '../dist/index.js';
import {DEFAULT_CONFIG} from '../dist/config.js';
import os from 'node:os';
import path from 'node:path';

function stall(signal) {
  assert.ok(signal, 'request must carry AbortSignal');
  return new Promise((_,reject)=>{
    if(signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  });
}
for(const body of [false,true]) test(`control deadlines cover stalled ${body?'bodies':'headers'}`,async t=>{
  const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);
  let aborted=0;
  globalThis.fetch=async (_url,opts)=>{
    assert.ok(opts?.signal);
    opts.signal.addEventListener('abort',()=>aborted++);
    if(!body) return stall(opts.signal);
    return {ok:true,json:()=>stall(opts.signal),text:()=>stall(opts.signal)};
  };
  for(const run of [o=>fetchSlots('http://127.0.0.1',o),o=>saveSlot('http://127.0.0.1',0,'x',o),o=>restoreSlot('http://127.0.0.1',0,'x',o),o=>eraseSlot('http://127.0.0.1',0,o)]) {
    await assert.rejects(run({controlTimeoutMs:20}));
  }
  assert.equal(aborted,4);
});
for(const lifecycle of ['model_select','session_start','session_switch','session_shutdown']) for(const body of [false,true]) test(`${lifecycle} aborts active ${body?'body':'headers'}, skips queued stale requests and cold fallback`,async t=>{
  const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);
  const hooks=new Map();let started;const entered=new Promise(r=>started=r);const calls=[];const statuses=[];
  globalThis.fetch=async(url,options)=>{calls.push(url);started();return body ? {ok:true,text:()=>stall(options?.signal)} : stall(options?.signal);};
  extension({on:(n,f)=>hooks.set(n,f),registerCommand:()=>{}},{
    resolve:async()=>({serverUrl:'http://127.0.0.1:8001',cacheDir:path.join(os.homedir(),'cache'),identity:'fixture',generation:'1'}),
    loadConfig:()=>({...DEFAULT_CONFIG,controlTimeoutMs:60000})
  });
  const ctx={cwd:os.homedir(),model:{provider:'local-llama',baseUrl:'http://localhost:8001/v1'},sessionManager:{getSessionId:()=> 's'},hasUI:true,ui:{setStatus:(_k,v)=>statuses.push(v),notify:()=>{}}};
  const event=()=>({payload:{messages:[{role:'system',content:'prefix'}],tools:[]}});
  const first=event(),second=event();
  const active=hooks.get('before_provider_request')(first,ctx);
  await entered;
  const queued=hooks.get('before_provider_request')(second,ctx);
  assert.ok(hooks.has(lifecycle));
  await Promise.race([Promise.all([hooks.get(lifecycle)({},ctx),active,queued]),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('lifecycle did not promptly cancel')),500);timer.unref();})]);
  assert.equal(calls.length,1);
  assert.equal(first.payload.id_slot,undefined);assert.equal(second.payload.id_slot,undefined);
  assert.ok(!statuses.some(s=>s?.includes('warmed')));
});

import {BaseCacheManager} from '../dist/base-cache.js';
import {CheckpointEngine} from '../dist/checkpoint-engine.js';
import {LruManager} from '../dist/lru-manager.js';
import * as fs from 'node:fs/promises';

for(const endpoint of ['/apply-template','/completion','action=save']) for(const body of [false,true]) test(`cancel ${endpoint} ${body?'body':'headers'} prevents metadata and callbacks`,async t=>{
  const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);
  const cacheDir=await fs.mkdtemp(path.join(os.homedir(),'cancel-'));
  const controller=new AbortController();let started;const entered=new Promise(r=>started=r);const calls=[];
  globalThis.fetch=async(url,opts)=>{
    calls.push(url);
    if(url.endsWith(endpoint)) {
      started();
      if(!body) return stall(opts.signal);
      return {ok:true,text:()=>stall(opts.signal)};
    }
    if(url.endsWith('/slots')) return Response.json([{id:0,is_processing:false}]);
    return Response.json({prompt:'formatted'});
  };
  const config={...DEFAULT_CONFIG,cacheDir,signal:controller.signal,controlTimeoutMs:60000,assertCurrent:async()=>controller.signal.throwIfAborted()};
  const lru=new LruManager(cacheDir,'',controller.signal);
  let callback=0;
  const work=endpoint==='action=save' ? new CheckpointEngine(config,lru).maybeCheckpoint('s','s',100000,0,()=>callback++,()=>callback++) :
    new BaseCacheManager(config,lru).warmAndSave('system','hash',0,[]);
  const settled=work.catch(e=>e);
  await entered;controller.abort(new DOMException('switch','AbortError'));
  await settled;
  assert.equal(callback,0);
  assert.equal(calls.filter(u=>u.endsWith('action=save')).length,endpoint==='action=save'?1:0);
  for(const name of await fs.readdir(cacheDir)) if(name.endsWith('.meta.json')) assert.equal(JSON.parse(await fs.readFile(path.join(cacheDir,name),'utf8')).pending,true);
});

test('pre-aborted base tools write never starts filesystem mutation',async()=>{
  const cacheDir=await fs.mkdtemp(path.join(os.homedir(),'aborted-'));
  const controller=new AbortController();controller.abort();
  const config={...DEFAULT_CONFIG,cacheDir,signal:controller.signal};
  await assert.rejects(new BaseCacheManager(config,new LruManager(cacheDir)).saveCachedTools([{name:'unsafe'}]));
  assert.deepEqual(await fs.readdir(cacheDir),[]);
});

for (const endpoint of ['/apply-template','/completion']) for (const body of [false,true]) test(`${endpoint} deadline aborts ${body?'body':'headers'} before any save`,async t=>{
  const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);
  const controller=new AbortController();const calls=[];
  globalThis.fetch=async(url,opts)=>{
    calls.push(url);
    if(url.endsWith(endpoint)) return body ? {ok:true,text:()=>stall(opts.signal)} : stall(opts.signal);
    return Response.json({prompt:'formatted'});
  };
  const config={...DEFAULT_CONFIG,cacheDir:os.homedir(),signal:controller.signal,controlTimeoutMs:20,prefillTimeoutMs:40,abortRuntime:r=>controller.abort(r)};
  await assert.rejects(new BaseCacheManager(config,new LruManager(os.homedir())).warmAndSave('system','hash',0,[]),/deadline/);
  assert.equal(controller.signal.aborted,true);
  assert.equal(calls.some(u=>u.endsWith('action=save')),false);
});
