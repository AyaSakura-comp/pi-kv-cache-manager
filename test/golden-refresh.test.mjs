import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import extension from '../dist/index.js';
import { BaseCacheManager, computeHash, extractResourcePaths } from '../dist/base-cache.js';
import { LruManager } from '../dist/lru-manager.js';
import { DEFAULT_CONFIG } from '../dist/config.js';

const HEAD = 'You are an expert coding assistant operating inside pi, a coding agent harness. '.repeat(8);

// Two slots, as on the live server (-np 2). Each slot: [snapshot_filename, t_last_used].
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kv-refresh-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const slots = [['', 0], ['', 0]];
  const calls = [];
  let failRestore = false;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = opts?.body && JSON.parse(opts.body);
    calls.push({ url, body });
    if (url.endsWith('/apply-template')) return Response.json({ prompt: `rendered:${body.messages[0].content}` });
    if (url.endsWith('/slots')) return Response.json(slots.map(([file, used], id) =>
      ({ id, n_ctx: 8192, is_processing: false, snapshot_filename: file, t_last_used: used })));
    const action = url.match(/slots\/(\d+)\?action=(\w+)/);
    if (action?.[2] === 'save') {
      slots[+action[1]][0] = body.filename;
      await fs.writeFile(path.join(root, body.filename), 'kv');
      await fs.writeFile(path.join(root, body.filename + '.ckpt'), 'checkpoint');
      return Response.json({ n_saved: 50, n_written: 2 });
    }
    if (action?.[2] === 'restore') {
      if (failRestore) return Response.json({ error: { message: 'incompatible snapshot' } }, { status: 400 });
      slots[+action[1]][0] = body.filename;
      return Response.json({ n_restored: 50 });
    }
    if (action?.[2] === 'erase') { slots[+action[1]][0] = ''; return Response.json({}); }
    return Response.json({});
  };
  t.after(() => globalThis.fetch = original);

  const agents = path.join(root, 'res', 'AGENTS.md');
  const skill = path.join(root, 'res', 'skills', 'a', 'SKILL.md');
  await fs.mkdir(path.dirname(skill), { recursive: true });
  await fs.writeFile(agents, 'v1');
  await fs.writeFile(skill, '---\nname: a\n---\n');
  await sleep(20); // Pi loads resources before session_start; same-millisecond stamps count as possibly stale
  const prompt = (body, { withSkill = true, head = HEAD } = {}) =>
    `${head}\n<project_instructions path="${agents}">\n${body}\n</project_instructions>\n` +
    (withSkill ? `<available_skills>\n  <skill>\n    <location>${skill}</location>\n  </skill>\n</available_skills>\n` : '');

  const config = { ...DEFAULT_CONFIG, cacheDir: root, runtimeIdentity: 'model-A', snapshotPrefix: 'kv2_s_',
    goldenPrefix: 'golden_modelA_', extensionsFingerprint: 'v1', extensionLoadedAt: Date.now(), goldenCwd: root,
    renderedPrefixHash: 'r1' };
  const manager = (extra = {}) => { const c = { ...config, ...extra }; return new BaseCacheManager(c, new LruManager(root, c.snapshotPrefix)); };
  const completions = () => calls.filter(c => c.url.endsWith('/completion'));
  const slotActions = () => calls.map(c => c.url.match(/slots\/(\d+)\?action=(\w+)/)).filter(Boolean)
    .map((m, i) => `${m[2]}:${m[1]}`);
  return { root, slots, calls, agents, skill, prompt, config, manager, completions, slotActions,
    failRestore: (value = true) => failRestore = value };
}

test('resource paths are read from the context-file and skill blocks Pi renders', () => {
  const p = '<project_instructions path="/a/AGENTS.md">\nx\n</project_instructions>\n<location>/s/b&amp;c/SKILL.md</location>\n<location>relative.md</location>';
  assert.deepEqual(extractResourcePaths(p), ['/a/AGENTS.md', '/s/b&c/SKILL.md']);
});

test('an AGENTS.md/skill edit schedules a silent refresh that the next new session performs seeded in its own slot', async t => {
  const f = await fixture(t);
  const old = f.manager();
  await old.ensureGolden(f.prompt('v1'), [], false, { sessionId: 'a' });
  const golden = old.getFilename();
  assert.equal(f.completions().length, 1);

  await sleep(20); await fs.writeFile(f.agents, 'v2 with new persona rules'); await sleep(20);
  const fresh = f.manager({ renderedPrefixHash: 'r2', extensionLoadedAt: Date.now() });
  await fresh.ensureGolden(f.prompt('v2'), [], false, { sessionId: 'b' });
  assert.equal(f.completions().length, 1, 'never warms on the request path; the next new session does it');

  f.calls.length = 0;
  const result = await fresh.checkAndRestore(f.prompt('v2'), 1, []);
  assert.equal(result.status, 'hit');
  assert.equal(result.rebuilt, 'resources');
  assert.deepEqual(f.slotActions().filter(a => !a.startsWith('save')), ['restore:1'], 'seeded from the old golden, no erase');
  assert.equal(f.calls.find(c => c.url.includes('action=restore')).body.filename, golden);
  assert.equal(f.completions().length, 1);
  assert.equal(f.completions()[0].body.id_slot, 1, 'warms in the slot the new session already owns');
  const meta = await fresh.getBaseMetadata();
  assert.equal(meta.promptPrefixHash, computeHash(f.prompt('v2'), []));
  assert.equal(meta.renderedPrefixHash, 'r2');
  assert.ok(meta.resources.some(r => r.path === f.agents));
  assert.equal(fresh.getFilename(), golden, 'still the single canonical golden');
  assert.ok((await fs.readdir(f.root)).every(n => !n.includes('build_') && !n.endsWith('.backup')));
  const log = await fs.readFile(path.join(f.root, 'golden-warnings.jsonl'), 'utf8');
  assert.match(log, /"type":"golden_refreshed"/);
  assert.match(log, /"reason":"resources"/);

  f.calls.length = 0;
  const next = f.manager({ renderedPrefixHash: 'r2', extensionLoadedAt: Date.now() });
  await next.ensureGolden(f.prompt('v2'), [], false, { sessionId: 'c' });
  const hit = await next.checkAndRestore(f.prompt('v2'), 0, []);
  assert.equal(hit.status, 'hit');
  assert.equal(hit.rebuilt, undefined);
  assert.equal(f.completions().length, 0);
});

test('a worker loaded before the edit, a session missing a golden skill, or a foreign system prompt cannot refresh golden', async t => {
  const f = await fixture(t);
  await f.manager().ensureGolden(f.prompt('v1'), [], false, { sessionId: 'a' });
  await sleep(20); await fs.writeFile(f.agents, 'v2'); await sleep(20);
  const cases = [
    [{ renderedPrefixHash: 'r2', extensionLoadedAt: Date.now() - 60_000 }, f.prompt('v2'), 'old'],
    [{ renderedPrefixHash: 'r3', extensionLoadedAt: Date.now() }, f.prompt('v2', { withSkill: false }), 'subset'],
    [{ renderedPrefixHash: 'r4', extensionLoadedAt: Date.now() }, f.prompt('v2', { head: 'You are a reviewer subagent. '.repeat(30) }), 'subagent'],
  ];
  for (const [extra, prompt, session] of cases) {
    const m = f.manager(extra);
    await m.ensureGolden(prompt, [], false, { sessionId: session });
    const result = await m.checkAndRestore(prompt, 1, []);
    assert.equal(result.status, 'partial', session);
    assert.equal(result.rebuilt, undefined, session);
  }
  assert.equal(f.completions().length, 1);
});

test('a reduced variant loading a different extension set (strict mode, subagent) cannot replace golden', async t => {
  const f = await fixture(t);
  await f.manager().ensureGolden(f.prompt('v1'), [], false, { sessionId: 'a' });
  const cases = [
    [f.prompt('v1', { head: 'LINE strict mode. Call click with action and id ONLY. '.repeat(20) }), 'strict'],
    [f.prompt('v1', { withSkill: false }), 'subset'],
  ];
  for (const [prompt, session] of cases) {
    const m = f.manager({ extensionsFingerprint: `v2-${session}`, renderedPrefixHash: `r-${session}`, extensionLoadedAt: Date.now() + 1 });
    await m.ensureGolden(prompt, [], false, { sessionId: session });
    const result = await m.checkAndRestore(prompt, 1, []);
    assert.equal(result.rebuilt, undefined, session);
  }
  assert.equal(f.completions().length, 1);
  assert.equal((await f.manager().getBaseMetadata()).promptPrefixHash, computeHash(f.prompt('v1'), []));

  const full = f.manager({ extensionsFingerprint: 'v3', renderedPrefixHash: 'r-full', extensionLoadedAt: Date.now() + 2 });
  await full.ensureGolden(f.prompt('v1 plus a new tool'), [], false, { sessionId: 'full' });
  assert.equal((await full.checkAndRestore(f.prompt('v1 plus a new tool'), 1, [])).rebuilt, 'extensions');
});

test('the same new prompt from two sessions refreshes without file evidence; old workers cannot roll it back', async t => {
  const f = await fixture(t);
  await f.manager().ensureGolden(f.prompt('v1'), [], false, { sessionId: 'a' });
  const variant = f.prompt('v1') + '\nTools changed by settings, no resource file touched.\n';
  const m = f.manager({ renderedPrefixHash: 'rq', extensionLoadedAt: Date.now() });
  for (const session of ['s1', 's1']) {
    await m.ensureGolden(variant, [], false, { sessionId: session });
    assert.equal((await m.checkAndRestore(variant, 1, [])).status, 'partial');
  }
  await m.ensureGolden(variant, [], false, { sessionId: 's2' });
  const result = await m.checkAndRestore(variant, 1, []);
  assert.equal(result.rebuilt, 'quorum');
  assert.equal((await m.getBaseMetadata()).promptPrefixHash, computeHash(variant, []));

  const stale = f.manager({ renderedPrefixHash: 'r1', extensionLoadedAt: Date.now() });
  for (const session of ['x', 'y', 'z']) {
    await stale.ensureGolden(f.prompt('v1'), [], false, { sessionId: session });
    assert.equal((await stale.checkAndRestore(f.prompt('v1'), 0, [])).rebuilt, undefined);
  }
  assert.equal((await m.getBaseMetadata()).promptPrefixHash, computeHash(variant, []));
  assert.equal(f.completions().length, 2);
});

test('an incompatible seed falls back to a clean warm in the same slot', async t => {
  const f = await fixture(t);
  await f.manager().ensureGolden(f.prompt('v1'), [], false, { sessionId: 'a' });
  await sleep(20); await fs.writeFile(f.agents, 'v2'); await sleep(20);
  const m = f.manager({ renderedPrefixHash: 'r2', extensionLoadedAt: Date.now() });
  await m.ensureGolden(f.prompt('v2'), [], false, { sessionId: 'b' });
  f.calls.length = 0; f.failRestore();
  const result = await m.checkAndRestore(f.prompt('v2'), 1, []);
  assert.equal(result.rebuilt, 'resources');
  assert.deepEqual(f.slotActions().filter(a => !a.startsWith('save')), ['restore:1', 'erase:1']);
  assert.equal((await m.getBaseMetadata()).renderedPrefixHash, 'r2');
});

test('/kv base-update from a one-shot command process (piweb) schedules the refresh; the next new session rebuilds it without touching other slots', async t => {
  const f = await fixture(t);
  const runtime = { cacheDir: f.root, serverUrl: 'http://127.0.0.1:8001', identity: 'model-A', generation: '1' };
  const notes = [];
  const worker = () => {
    const hooks = new Map(); const commands = new Map();
    extension({ on: (name, fn) => hooks.set(name, fn), registerCommand: (name, spec) => commands.set(name, spec) },
      { loadConfig: () => ({ ...DEFAULT_CONFIG, cacheDir: f.root }), resolve: async () => runtime });
    return { hooks, commands };
  };
  const ctx = session => ({ cwd: f.root, model: { provider: 'local-llama', baseUrl: 'http://127.0.0.1:8001/v1' }, hasUI: true,
    sessionManager: { getSessionId: () => session, getSessionName: () => session }, getSystemPrompt: () => 'prefix',
    getContextUsage: () => ({ tokens: 10 }), ui: { setStatus: () => {}, notify: message => notes.push(message) } });
  const request = (w, session, prompt = 'prefix') => w.hooks.get('before_provider_request')(
    { payload: { messages: [{ role: 'system', content: prompt }], tools: [] } }, ctx(session));

  const chat = worker();
  await chat.hooks.get('session_start')({ extensionsFingerprint: 'v1' }, ctx('s1'));
  await request(chat, 's1');
  assert.equal(f.completions().length, 1);

  const command = worker();
  await command.hooks.get('session_start')({ extensionsFingerprint: 'v1' }, ctx('s1'));
  await command.commands.get('kv').handler('base-update', ctx('s1'));
  assert.match(notes.at(-1), /scheduled/i);
  assert.equal(f.completions().length, 1, 'scheduling does not touch any slot');
  assert.ok((await fs.readdir(f.root)).some(n => n.endsWith('refresh.request')));

  f.slots[0] = ['kv2_other_snap_X.bin', 999];
  f.slots[1] = ['kv2_x_snap_s1.bin', 1];
  f.calls.length = 0;
  const fresh = worker();
  await fresh.hooks.get('session_start')({ extensionsFingerprint: 'v1' }, ctx('s3'));
  await request(fresh, 's3', 'prefix edited without any detectable resource file');
  assert.equal(f.completions().length, 1);
  assert.equal(f.completions()[0].body.id_slot, 1);
  assert.ok(!f.calls.some(c => c.url.includes('/slots/0?')), 'the other session keeps its slot');
  assert.ok(!(await fs.readdir(f.root)).some(n => n.endsWith('refresh.request')), 'request consumed');
  assert.match(await fs.readFile(path.join(f.root, 'golden-warnings.jsonl'), 'utf8'), /"reason":"requested"/);
});

test('a scheduled base-update is consumed without a warm when golden already matches (identical prompts cannot be re-evaluated in place)', async t => {
  const f = await fixture(t);
  const runtime = { cacheDir: f.root, serverUrl: 'http://127.0.0.1:8001', identity: 'model-A', generation: '1' };
  const worker = () => {
    const hooks = new Map(); const commands = new Map();
    extension({ on: (name, fn) => hooks.set(name, fn), registerCommand: (name, spec) => commands.set(name, spec) },
      { loadConfig: () => ({ ...DEFAULT_CONFIG, cacheDir: f.root }), resolve: async () => runtime });
    return { hooks, commands };
  };
  const ctx = session => ({ cwd: f.root, model: { provider: 'local-llama', baseUrl: 'http://127.0.0.1:8001/v1' }, hasUI: false,
    sessionManager: { getSessionId: () => session, getSessionName: () => session }, getSystemPrompt: () => 'prefix',
    getContextUsage: () => ({ tokens: 10 }), ui: { setStatus: () => {}, notify: () => {} } });
  const request = (w, session) => w.hooks.get('before_provider_request')(
    { payload: { messages: [{ role: 'system', content: 'prefix' }], tools: [] } }, ctx(session));
  const chat = worker();
  await chat.hooks.get('session_start')({ extensionsFingerprint: 'v1' }, ctx('s1'));
  await request(chat, 's1');
  const command = worker();
  await command.commands.get('kv').handler('base-update', ctx('s1'));
  f.calls.length = 0;
  const fresh = worker();
  await fresh.hooks.get('session_start')({ extensionsFingerprint: 'v1' }, ctx('s2'));
  await request(fresh, 's2');
  assert.equal(f.completions().length, 0, 'no pointless full re-evaluation');
  assert.ok(f.calls.some(c => c.url.includes('action=restore')), 'the session restores the matching golden');
  assert.ok(!(await fs.readdir(f.root)).some(n => n.endsWith('refresh.request')), 'request consumed');
});
