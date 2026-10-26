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

async function strataFixture(t) {
  const f = await fixture(t);
  const {root} = f;
  for (const p of ['serve','pack/tokenizer','A']) await fs.mkdir(path.join(root,p), {recursive:true});
  for (const n of ['server.py','frontend.py','chat_template.jinja']) await fs.writeFile(path.join(root,'serve',n),n);
  await fs.writeFile(path.join(root,'strata'),'engine');
  await fs.writeFile(path.join(root,'pack/experts.bin'),'experts');
  await fs.writeFile(path.join(root,'pack/tokenizer/tokenizer.json'),'{}');
  await fs.writeFile(path.join(root,'cvec.gguf'),'cvec');
  await fs.writeFile(path.join(root,'python3.13'),'python');
  await fs.unlink(path.join(root,'proc/42/exe'));
  await fs.symlink(path.join(root,'python3.13'),path.join(root,'proc/42/exe'));
  const config = {exe:'strata', cwd:root, slot_save_path:'A', tokenizer:'pack/tokenizer',
    args:['--pack','pack','--native','model.gguf','--kv','int8','--control-vector-scaled','cvec.gguf:1.0']};
  const write = async (c=config) => fs.writeFile(path.join(root,'run.json'),JSON.stringify(c));
  await write();
  const cmd = async (extra=[], engine='strata') => fs.writeFile(path.join(root,'proc/42/cmdline'),
    ['.venv/bin/python',path.join(root,'serve/server.py'),'--engine',engine,'--config','run.json','--port','8090',...extra].join('\0')+'\0');
  await cmd();
  f.setSS('LISTEN 0 5 127.0.0.1:8090 0.0.0.0:* users:(("python",pid=42,fd=6)) ino:123');
  f.deps.json = async url => url.endsWith('/props') ? {model_path:'model.gguf',model_alias:'qwen3.8-flash',build_info:'Strata 0.1.40',
    total_slots:1,default_generation_settings:{n_ctx:262144,params:{temperature:Math.random()}}} : [];
  return {...f,config,write,cmd};
}

test('Strata listener: run config names the slot path, model files and engine identity', async t => {
  const f = await strataFixture(t);
  const resolve = () => resolveRuntime('http://127.0.0.1:8090/v1', f.deps);
  const a = await resolve();
  assert.equal(a.cacheDir, path.join(f.root,'A'));
  assert.equal((await resolve()).identity, a.identity);       // shared sampling settings are not identity
  await fs.writeFile(path.join(f.root,'pack/experts.bin'),'other experts');
  const b = await resolve(); assert.notEqual(b.identity, a.identity);
  await fs.writeFile(path.join(f.root,'cvec.gguf'),'other cvec');
  const c = await resolve(); assert.notEqual(c.identity, b.identity);
  await f.write({...f.config, args:[...f.config.args,'--kv-resident','32768']});
  const d = await resolve(); assert.notEqual(d.identity, c.identity);
  await fs.writeFile(path.join(f.root,'serve/chat_template.jinja'),'another template');
  assert.notEqual((await resolve()).identity, d.identity);
  await f.cmd(['--slot-save-path','B']);
  assert.equal((await resolve()).cacheDir, path.join(f.root,'B'));
});

test('Strata listener without a slot path, with the mock engine, adapters or another model fails closed', async t => {
  const f = await strataFixture(t);
  const resolve = () => resolveRuntime('http://127.0.0.1:8090/v1', f.deps);
  const {slot_save_path, ...noSlots} = f.config;
  await f.write(noSlots); await assert.rejects(resolve(), /slot-save-path/);
  await f.write();
  await f.cmd([], 'mock'); await assert.rejects(resolve(), /Strata engine/);
  await f.cmd();
  const props = f.deps.json;
  f.deps.json = async url => url.endsWith('/props') ? props(url) : [{id:0,path:'adapter.gguf',scale:1}];
  await assert.rejects(resolve(), /does not match/);
  f.deps.json = async url => url.endsWith('/props') ? {...await props(url), model_path:'other.gguf'} : [];
  await assert.rejects(resolve(), /does not match/);
  f.deps.json = props;
  await fs.writeFile(path.join(f.root,'proc/42/cmdline'),['python3','other.py','--engine','strata','--config','run.json'].join('\0')+'\0');
  await assert.rejects(resolve(), /not llama-server or Strata/);
});
