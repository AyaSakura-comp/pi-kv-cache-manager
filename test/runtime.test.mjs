import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveRuntime } from '../dist/runtime.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kv-runtime-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  for (const p of ['proc/42/fd','proc/42/ns','proc/self/ns','A','B']) await fs.mkdir(path.join(root,p), {recursive:true});
  for (const n of ['net','mnt']) for (const p of ['42','self']) await fs.symlink(`${n}:[1]`,path.join(root,'proc',p,'ns',n));
  await fs.writeFile(path.join(root,'llama-server'),'exe');
  await fs.symlink(path.join(root,'llama-server'),path.join(root,'proc/42/exe'));
  await fs.symlink(root,path.join(root,'proc/42/cwd'));
  for (const pid of ['42','self']) await fs.symlink(root,path.join(root,'proc',pid,'root'));
  await fs.symlink('socket:[123]',path.join(root,'proc/42/fd/6'));
  await fs.writeFile(path.join(root,'model.gguf'),'weights');
  await fs.writeFile(path.join(root,'adapter.gguf'),'adapter');
  await fs.writeFile(path.join(root,'proc/42/stat'), '42 (llama-server) S ' + Array(18).fill('0').join(' ') + ' 100 0');
  await fs.writeFile(path.join(root,'proc/42/environ'),'');
  let ss = 'LISTEN 0 4096 127.0.0.1:8001 0.0.0.0:* users:(("llama-server",pid=42,fd=6)) ino:123';
  let adapters = [];
  const cmd = async (folder='A', extra=[]) => fs.writeFile(path.join(root,'proc/42/cmdline'),['llama-server','-m','model.gguf',`--slot-save-path=${folder}`,...extra].join('\0')+'\0');
  await cmd();
  const deps = {procRoot:path.join(root,'proc'), lookup:async () => [{address:'127.0.0.1',family:4}], transport:(...args)=>globalThis.fetch(...args), listener:async () => ss, json:async url => url.endsWith('/props') ? {model_path:'model.gguf',build_info:'fixture',default_generation_settings:{n_ctx:8192}} : adapters};
  return {root,deps,cmd,setSS:s=>ss=s,setAdapters:a=>adapters=a};
}

test('verified listener resolves relative server path and A -> B -> A namespace', async t => {
  const f = await fixture(t);
  const a = await resolveRuntime('http://127.0.0.1:8001/v1', f.deps);
  assert.equal(a.cacheDir,path.join(f.root,'A'));
  assert.equal(a.serverUrl,'http://127.0.0.1:8001');
  await f.cmd('B'); const b = await resolveRuntime('http://127.0.0.1:8001/v1',f.deps);
  assert.notEqual(a.identity,b.identity);
  await f.cmd('A'); assert.equal((await resolveRuntime('http://127.0.0.1:8001/v1',f.deps)).identity,a.identity);
});

test('same folder LoRA scale, file replacement, model and runtime changes invalidate identity', async t => {
  const f = await fixture(t);
  f.setAdapters([{id:0,path:'adapter.gguf',scale:1}]);
  const resolve = () => resolveRuntime('http://127.0.0.1:8001/v1',f.deps);
  const a = await resolve();
  f.setAdapters([{id:0,path:'adapter.gguf',scale:0.5}]); const b = await resolve();
  assert.notEqual(a.identity,b.identity);
  await fs.writeFile(path.join(f.root,'adapter.gguf'),'different adapter'); const c = await resolve(); assert.notEqual(b.identity,c.identity);
  await fs.writeFile(path.join(f.root,'model.gguf'),'different weights'); const d = await resolve(); assert.notEqual(c.identity,d.identity);
  await f.cmd('A',['--cache-type-k','q8_0']); assert.notEqual(d.identity,(await resolve()).identity);
});

test('remote, inaccessible, wrong port, ambiguous ownership, fd mismatch fail closed before API', async t => {
  const f = await fixture(t); let requests=0;
  f.deps.json=async()=>{requests++;throw Error('must not call');};
  await assert.rejects(resolveRuntime('http://remote.example:8001/v1',f.deps));
  for (const ss of ['', 'LISTEN 0 1 127.0.0.1:8002 0.0.0.0:* users:(("llama-server",pid=42,fd=6)) ino:123',
    'LISTEN 0 1 127.0.0.1:8001 0.0.0.0:* users:(("llama-server",pid=42,fd=6),("llama-server",pid=43,fd=7)) ino:123',
    'LISTEN 0 1 127.0.0.1:8001 0.0.0.0:* users:(("llama-server",pid=42,fd=6)) ino:999']) {
    f.setSS(ss); await assert.rejects(resolveRuntime('http://127.0.0.1:8001/v1',f.deps));
  }
  assert.equal(requests,0);
});

test('missing slot path or adapter API never falls back; split syntax supported', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root,'proc/42/cmdline'),'llama-server\0-m\0model.gguf\0--slot-save-path\0A\0');
  assert.equal((await resolveRuntime('http://127.0.0.1:8001',f.deps)).cacheDir,path.join(f.root,'A'));
  f.deps.json=async()=>{throw Error('unavailable');};
  await assert.rejects(resolveRuntime('http://127.0.0.1:8001',f.deps));
  await fs.writeFile(path.join(f.root,'proc/42/cmdline'),'llama-server\0-m\0model.gguf\0');
  await assert.rejects(resolveRuntime('http://127.0.0.1:8001',f.deps));
});

test('API/listener model mismatch and foreign mount namespace fail closed',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.root,'other.gguf'),'other');
  f.deps.json=async url=>url.endsWith('/props')?{model_path:'other.gguf'}:[];
  await assert.rejects(resolveRuntime('http://127.0.0.1:8001',f.deps),/does not match/);
  await fs.unlink(path.join(f.root,'proc/42/ns/mnt'));
  await fs.symlink('mnt:[2]',path.join(f.root,'proc/42/ns/mnt'));
  await assert.rejects(resolveRuntime('http://127.0.0.1:8001',f.deps),/another namespace/);
});

test('same mount namespace but different process root cannot authorize local disk paths',async t=>{
  const f=await fixture(t);
  await fs.unlink(path.join(f.root,'proc/42/root'));
  await fs.symlink(path.join(f.root,'A'),path.join(f.root,'proc/42/root'));
  await assert.rejects(resolveRuntime('http://127.0.0.1:8001',f.deps),/root/);
});

test('PID restart changes RAM generation without throwing away compatible disk identity',async t=>{
  const f=await fixture(t);const a=await resolveRuntime('http://127.0.0.1:8001',f.deps);
  await fs.writeFile(path.join(f.root,'proc/42/stat'),'42 (llama-server) S '+Array(18).fill('0').join(' ')+' 200 0');
  const b=await resolveRuntime('http://127.0.0.1:8001',f.deps);
  assert.equal(a.identity,b.identity);assert.notEqual(a.generation,b.generation);
});

for (const hostname of ['127.0.0.1','localhost']) test(`${hostname}: listener/proc + API discovery drives real extension managers into server directory, not settings`,async t=>{
  const f=await fixture(t);
  const {default:extension}=await import('../dist/index.js');
  const {DEFAULT_CONFIG}=await import('../dist/config.js');
  const hooks=new Map();const saved=[];let folder='A';
  const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);
  globalThis.fetch=async(url,options)=>{
    if(url.endsWith('/slots'))return Response.json([{id:0,is_processing:false}]);
    if(url.endsWith('/apply-template'))return Response.json({prompt:'formatted full prefix'});
    if(url.endsWith('action=save')){
      const {filename}=JSON.parse(options.body);saved.push(filename);
      await fs.writeFile(path.join(f.root,folder,filename),'bin');
      await fs.writeFile(path.join(f.root,folder,filename+'.dft'),'draft');
      return Response.json({n_saved:42,n_written:3});
    }
    return Response.json({n_restored:42});
  };
  extension({on:(name,fn)=>hooks.set(name,fn),registerCommand:()=>{}},{resolve:url=>resolveRuntime(url,f.deps),loadConfig:()=>({...DEFAULT_CONFIG,cacheDir:path.join(f.root,'wrong')})});
  const ctx={cwd:f.root,model:{provider:'local-llama',baseUrl:`http://${hostname}:8001/v1`},sessionManager:{getSessionId:()=> 's'},hasUI:false,ui:{setStatus:()=>{}}};
  const request=()=>hooks.get('before_provider_request')({payload:{messages:[{role:'system',content:'full system'}],tools:[{type:'function',function:{name:'fixture',parameters:{type:'object'}}}]}},ctx);
  await request();
  assert.ok(saved.length>0);assert.ok((await fs.readdir(path.join(f.root,'A'))).some(n=>n.endsWith('.meta.json')));
  await assert.rejects(fs.access(path.join(f.root,'wrong')));
  folder='B';await f.cmd('B');await request();
  assert.ok((await fs.readdir(path.join(f.root,'B'))).some(n=>n.endsWith('.meta.json')));
  assert.notEqual(saved[0],saved[1]);
});

 test('localhost preserves selected origin; unsafe and ambiguous DNS fail before discovery',async t=>{
  const f=await fixture(t);
  const r=await resolveRuntime('http://localhost:8001/v1',f.deps);
  assert.equal(r.serverUrl,'http://localhost:8001');
  for(const addresses of [[],[{address:'10.0.0.1',family:4}],[{address:'127.0.0.1',family:4},{address:'10.0.0.1',family:4}]]){
    let called=false;
    await assert.rejects(resolveRuntime('http://localhost:8001/v1',{...f.deps,lookup:async()=>addresses,listener:async()=>{called=true;return '';}}));
    assert.equal(called,false);
  }
  f.setSS('LISTEN 0 1 127.0.0.1:8001 *:* users:(("llama-server",pid=42,fd=6)) ino:123\nLISTEN 0 1 [::1]:8001 *:* users:(("llama-server",pid=42,fd=6)) ino:123');
  await assert.rejects(resolveRuntime('http://localhost:8001/v1',f.deps),/ambiguous/);
 });
 test('DNS lookup is bounded and cancellable without discovery',async t=>{
  const f=await fixture(t); let called=false;
  await assert.rejects(resolveRuntime('http://localhost:8001/v1',{...f.deps,dnsTimeoutMs:20,lookup:()=>new Promise(()=>{}),listener:async()=>{called=true;return '';}}), /DNS deadline/);
  assert.equal(called,false);
 });
