# Silent golden refresh — 2026-10-13

## Symptom

After `~/.pi/agent/AGENTS.md` was edited, every new Qwen session on piweb took ~8 s longer to answer, and `/kv base-update` (run twice from piweb) changed nothing.

## Root causes

1. **Context files and skills were not refresh triggers.** `ensureGolden()` replaced golden only on a loaded-extension fingerprint change or an explicit update. AGENTS.md/skills do not change that fingerprint, so every request logged `golden_mismatch` with `"action":"preserve"` and kept the 11:18 golden. Decoding the golden `.bin` showed the token streams diverging at token 16,782, exactly where the new persona rules were inserted. On the hybrid GDN model llama-server can only roll back to checkpoint 16,384, so each new session re-prefilled ~11.7k tokens (7.5–8.5 s). After the 18:37 server restart, 55 of the 62 s of total prefill came from this.
2. **piweb runs every extension slash command in a fresh one-shot `pi --mode rpc` process** (`piweb/src/commands/extension-runner.ts`, `executePiExtensionCommand`), then SIGTERMs it. `/kv` required in-process state that only a prior provider request creates (`ready`, `lastPrefix`), so `verifyActive()` failed with "Persistent KV unavailable… No files changed", which piweb still reported as `success:true`. Reproduced with the same RPC sequence.
3. **Discovery deadlines discarded finished work under load.** `/props` and `/lora-adapters` are answered from llama-server's main loop. During the first live test, `/lora-adapters` took 2.005 s behind a 1.7 s image encode for another client and exceeded the 2 s deadline. `checkCancelled()` treats `TimeoutError` as cancellation, and the outer `catch {}` in `before_provider_request` silently dropped a completed 28,089-token warm and its publication, plus the request's slot binding. This affects session restores too, not only golden.

## Design

### Refresh policy (`BaseCacheManager.planRefresh`)

Each request is audited inside the golden lock. A refresh is scheduled only in the canonical cwd with the same extension fingerprint, and only when the request's prompt:

- **opens like golden**: `headHash` of the first 512 raw characters (Pi identity + tool list) matches. Subagents with their own system prompt never qualify;
- **keeps every golden resource** that still exists on disk. Reduced variants never qualify.

It then needs one of:

| Reason | Condition |
| --- | --- |
| `resources` | A rendered `<project_instructions path>` or skill `<location>` file was edited, created or deleted after golden was built, and this worker loaded its resources after that change (`extensionLoadedAt > newest mtime/ctime`), so its prompt contains the edit. |
| `quorum` | Two distinct sessions sent the same new prefix (`observed.json`), first seen after golden was built and not in golden's `retired` keys, so old workers cannot vote a replaced golden back. |
| `requested` | `golden_<runtime>_refresh.request` exists for this cwd (`/kv base-update` from a process with no live prefix). |

### Execution: next new session, its own slot, seeded

A scheduled refresh never runs on an existing session's request path. The next session that takes the golden path (no own snapshot) runs it inside `checkAndRestore` on **the slot already chosen for it**, so no other session's slot is evicted:

1. Restore the current golden into that slot. Like erase, restore first flushes any dirty owner state.
2. Send `/completion` (`n_predict: 0`) with the new rendered prefix. llama-server keeps the common token prefix through a context checkpoint and prefills only the changed suffix.
3. Save to a unique staging file, then publish with the existing backup/rollback/metadata-last protocol.

The session then continues from the exact new golden. If the seed restore fails, the slot is erased and warmed cold. If the prompt is already identical to golden, a scheduled `requested` refresh is just consumed. llama-server must re-evaluate the last token, cannot truncate recurrent state in place, and would re-prefill everything (observed: 28,089 tokens).

Golden metadata gains `resources` (path/mtime/size; `-1` when the file changed after the builder loaded it), `headHash`, `retired` (last 8 replaced prefix keys) and `refreshReason`. The log gains the `refresh-next-session:<reason>` action, `golden_refreshed` (reason, seeded, slot, tokens, durationMs) and `golden_refresh_skipped`.

### Other changes

- `/kv base-update` without a live prefix writes the refresh request and answers "scheduled". With a live prefix (TUI after a request) it keeps the immediate path.
- Discovery deadline `DISCOVERY_TIMEOUT_MS = 30_000`. A dead server still fails within that bound.
- Unchanged: loaded-extension updates still rebuild immediately and cold in the first idle slot.

## Validation

**CPU:** `npm test` passes 71/71 (63 existing + 8 new), repeated 3–5 times. `test/golden-refresh.test.mjs` covers resource-path extraction; edit → seeded refresh in the new session's slot; old worker, reduced-variant and foreign-head prompts rejected; quorum refresh and no rollback; seed-failure fallback; piweb one-shot `base-update` scheduling without touching other slots; already-current request consumed without a warm. `test/runtime-cache.test.mjs` adds a `/lora-adapters` response delayed 2.2 s.

**Live** (`qwen-mtp`, `-np 2`, binary `gfx1151-gdnfused-wmmafa-20261007`, 27.9–28.2k-token golden; same prompt hash `5d6ada12…` as piweb sessions):

| Scenario | Result |
| --- | --- |
| Extension update (cold, old path), before the timeout fix | Warm finished, then discarded by the 2 s discovery timeout; nothing published |
| Extension update, after the fix | Published: 28,089 tokens, 16.2–17.0 s |
| Temporary skill added | `resources`, seeded in slot 0: 26,037 tokens reused, **2,131 prefilled**, refresh 2.8 s, whole run 5.2 s |
| Temporary skill deleted | `resources`, seeded: **1,973 prefilled**, 4.3 s; golden back to the piweb prompt |
| `/kv base-update` in a one-shot RPC process | "scheduled"; consumed by the next new session (`requested`) |
| `/kv base-update` while golden is current | `golden_refresh_skipped`; next session 3.2 s, 55 tokens prefilled |
| 5 sequential new piweb-style sessions, `hello` | TTFT **0.92–1.02 s**, done 2.6–3.2 s, **53 tokens** prefilled each |
| 2 simultaneous new sessions | TTFT 1.05 s / 3.21 s (both took slot 1, see below) |

## Known limitations

- **Concurrent slot choice and checkpoint cross-write (pre-existing).** Separate pi processes pick slots independently. Two simultaneous new sessions both picked the least recently used slot 1. The server correctly flushed c1's dirty state before c2 took the slot, but c1's later `agent_end` save ran while slot 1 held c2's context, and c1's snapshot file ended with c2's reply (verified by detokenizing). Token verification keeps outputs correct, but c1's next restore reuses only the golden prefix and re-prefills its whole history. Proposed fixes: a server-side owner check rejecting saves to a non-owner filename (patch 0005 follow-up), and a short-lived cross-process slot claim in the cache dir.
- A new prompt that is a strict prefix of golden (content removed only at the very end) is correct but re-prefilled in full, for the same in-place re-evaluation reason.
- `/kv status/save/restore/prune` from piweb still answer "unavailable": same one-shot-process cause as root cause 2.
- Extension self-updates (including this one) trigger one cold immediate rebuild in the first idle slot.

## Deployment

`~/.pi/agent/extensions/pi-kv-cache-manager` is a symlink to this checkout, and settings load `dist/index.js`. Rebuilding `dist/` deploys it: new pi processes load it, and running workers reload changed extension sources at their next idle prompt. The server and Pi core are unchanged from the 2026-10-05 baseline. piweb was not changed.
