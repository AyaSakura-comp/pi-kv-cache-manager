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
import { DEFAULT_CONFIG } from '../dist/config.js';

// Two slots, as on the live server (-np 2). Each entry: [snapshot_filename, t_last_used].
async function fixture(t, slots) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kv-switch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { ...DEFAULT_CONFIG, cacheDir: root, snapshotPrefix: 'kv2_fixture_', runtimeIdentity: 'fixture', minTokensThreshold: 1 };
  const runtime = { cacheDir: root, serverUrl: 'http://127.0.0.1:8001', identity: 'a', generation: 'pid1' };
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = opts?.body && JSON.parse(opts.body);
    calls.push({ url, body });
    if (url.endsWith('/slots')) return Response.json(slots.map(([file, used], id) =>
      ({ id, n_ctx: 8192, is_processing: false, snapshot_filename: file, t_last_used: used })));
    if (url.endsWith('/apply-template')) return Response.json({ prompt: `formatted:${body.messages[0].content}` });
    const action = url.match(/slots\/(\d+)\?action=(\w+)/);
    if (action?.[2] === 'save') {
      slots[+action[1]][0] = body.filename;
      await fs.writeFile(path.join(root, body.filename), 'bin');
      return Response.json({ n_saved: 100, n_written: 3 });
    }
    if (action?.[2] === 'restore') { slots[+action[1]][0] = body.filename; return Response.json({ n_restored: 100 }); }
    return Response.json({});
  };
  t.after(() => globalThis.fetch = original);
  return { root, config, runtime, calls, slots };
}

test('a switched-in session takes the least recently used slot, not the first one', async t => {
  const f = await fixture(t, [['kv2_fixture_snap_A.bin', 200], ['kv2_fixture_snap_C.bin', 100]]);
  const lru = new LruManager(f.config.cacheDir, f.config.snapshotPrefix);
  const engine = new CheckpointEngine(f.config, lru);
  await engine.maybeCheckpoint('B', 'b', 100, 0);
  f.slots[0][0] = 'kv2_fixture_snap_A.bin';
  const slots = new SlotManager(f.config, lru, engine, new BaseCacheManager(f.config, lru));
  const r = await slots.ensureSlotForSession('B', 'system', []);
  assert.equal(r.restored, true);
  assert.equal(r.slotId, 1);
  assert.equal(f.slots[0][0], 'kv2_fixture_snap_A.bin', 'the recently used session keeps its slot');
});

function harness(f) {
  const hooks = new Map();
  extension({ on: (name, fn) => hooks.set(name, fn), registerCommand: () => {} },
    { resolve: async () => f.runtime, loadConfig: () => f.config });
  const ctx = { cwd: f.root, model: { provider: 'local-llama', baseUrl: 'http://127.0.0.1:8001/v1' }, hasUI: false,
    sessionManager: { getSessionId: () => 'session', getSessionName: () => 'fixture' }, getSystemPrompt: () => 'system',
    getContextUsage: () => ({ tokens: 100 }), ui: { setStatus: () => {}, notify: () => {} } };
  const request = () => hooks.get('before_provider_request')(
    { payload: { messages: [{ role: 'system', content: 'system' }], tools: [{ name: 'tool' }] } }, ctx);
  return { hooks, ctx, request };
}

test('requests name the session snapshot so llama-server can save the slot before evicting it', async t => {
  const f = await fixture(t, [['', 0], ['', 0]]); const h = harness(f);
  const payload = { messages: [{ role: 'system', content: 'system' }], tools: [{ name: 'tool' }] };
  await h.hooks.get('before_provider_request')({ payload }, h.ctx);
  assert.equal(typeof payload.id_slot, 'number');
  assert.match(payload.slot_snapshot, /^kv2_[0-9a-f]+_snap_session\.bin$/);
});

test('an active session whose slot was taken by an unowned side request restores its snapshot instead of re-prefilling', async t => {
  const f = await fixture(t, [['', 0], ['', 0]]);
  const lru = new LruManager(f.config.cacheDir, f.config.snapshotPrefix);
  const engine = new CheckpointEngine(f.config, lru);
  await engine.maybeCheckpoint('B', 'b', 100, 0);
  const slots = new SlotManager(f.config, lru, engine, new BaseCacheManager(f.config, lru));
  const first = await slots.ensureSlotForSession('B', 'system', []);
  assert.equal(f.slots[first.slotId][0], 'kv2_fixture_snap_B.bin');
  const resident = await slots.ensureSlotForSession('B', 'system', []);
  assert.equal(resident.hit, true, 'still resident: no restore');

  // A browser planner call (no slot_snapshot) took the slot; llama-server saved B and now names no owner.
  f.slots[first.slotId][0] = '';
  f.calls.length = 0;
  const back = await slots.ensureSlotForSession('B', 'system', []);
  assert.equal(back.restored, true);
  assert.ok(f.calls.some(c => /action=restore/.test(c.url) && c.body.filename === 'kv2_fixture_snap_B.bin'));
});
