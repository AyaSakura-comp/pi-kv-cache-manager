import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cachedRuntimeResolver } from '../dist/runtime.js';

test('cached runtime: reused while the listener process and adapters are unchanged, re-verified otherwise', async t => {
  const proc = await fs.mkdtemp(path.join(os.tmpdir(), 'kv-proc-'));
  t.after(() => fs.rm(proc, { recursive: true, force: true }));
  await fs.mkdir(path.join(proc, '42'));
  const stat = start => fs.writeFile(path.join(proc, '42', 'stat'), `42 (llama-server) S ${'0 '.repeat(18)}${start} 0`);
  await stat('1000');
  let adapters = '[]', resolves = 0, clock = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async url => { assert.ok(String(url).endsWith('/lora-adapters')); return new Response(adapters); };
  t.after(() => { globalThis.fetch = original; });
  const resolve = async () => { resolves++; return { serverUrl: 'http://127.0.0.1:8001', generation: '42:1000:7', identity: `id${resolves}` }; };
  const cached = cachedRuntimeResolver(resolve, 60_000, proc, () => clock);
  assert.equal((await cached('http://127.0.0.1:8001/v1')).identity, 'id1');
  assert.equal((await cached('http://127.0.0.1:8001/v1')).identity, 'id1', 'same process and adapters: no full resolve');
  assert.equal(resolves, 1);
  adapters = '[{"id":0,"scale":0.5}]';
  assert.equal((await cached('http://127.0.0.1:8001/v1')).identity, 'id2', 'LoRA change forces a full resolve');
  await stat('2000');
  assert.equal((await cached('http://127.0.0.1:8001/v1')).identity, 'id3', 'restarted process forces a full resolve');
  clock = 61_000;
  await cached('http://127.0.0.1:8001/v1');
  assert.equal(resolves, 4, 'TTL expiry forces a full resolve');
});

test('a verified runtime survives /lora-adapters queued behind a busy main loop (e.g. 2 s image encode)', async t => {
  const proc = await fs.mkdtemp(path.join(os.tmpdir(), 'kv-proc-'));
  t.after(() => fs.rm(proc, { recursive: true, force: true }));
  await fs.mkdir(path.join(proc, '42'));
  await fs.writeFile(path.join(proc, '42', 'stat'), `42 (llama-server) S ${'0 '.repeat(18)}1000 0`);
  let delayMs = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason); });
    });
    return new Response('[]');
  };
  t.after(() => { globalThis.fetch = original; });
  const cached = cachedRuntimeResolver(async () => ({ serverUrl: 'http://127.0.0.1:8001', generation: '42:1000:7', identity: 'id' }), 60_000, proc);
  await cached('http://127.0.0.1:8001/v1');
  delayMs = 2200;
  assert.equal((await cached('http://127.0.0.1:8001/v1')).identity, 'id');
});
