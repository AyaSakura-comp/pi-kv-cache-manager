# Snapshot dependencies and validation — 2026-10-05

## Pinned source baseline

The extension, Pi core and server are a coupled integration. An extension-only update is not the tested feature set.

| Component | Repository / publication ref | Pinned code commit | Purpose |
| --- | --- | --- | --- |
| KV extension | `AyaSakura-comp/pi-kv-cache-manager`, `main` | `0eb4ee699059f86776d5f7a54ad8253a9d6ead4d` | Canonical golden, rendered-prefix namespaces, runtime-discovery cache, awaited/deduplicated checkpoints, ownership marker, bounded I/O and ownership-bound cross-namespace LRU. |
| Pi core | `AyaSakura-comp/pi`, `feat/kv-snapshot-deps-20261005` | `25402dcbb3ddd5da46a5ae23b411c4339c731397` | Loaded-extension fingerprints/idle reload and speculative-prefill snapshot ownership. |
| llama-server | `AyaSakura-comp/llama.cpp`, `flashhead-lm-head` | `16f213bba98a83a2e73bd967d565db4f8f696c4f` | Dirty slot-owner save before eviction; includes the two fixes below. |

The extension code commit is the parent of the accompanying documentation/patch-bundle update. Both commits are needed for the complete documented checkout, but that documentation update does not change executable extension code.

Server snapshot commits, in order:

1. `1ac2c26d29392b5b08b0336574801b63c1d6c6c2`: persist context checkpoints in `.bin.ckpt`, including target/MTP draft checkpoint data.
2. `ad5a834f58f3e8701ddd4fe5c126a7a54c0086ae`: always truncate target attention memory after checkpoint rollback; otherwise stale KV cells can survive the recurrent-state rewind.
3. `16f213bba98a83a2e73bd967d565db4f8f696c4f`: carry `slot_snapshot` as slot ownership and flush dirty state before another owner, restore or erase replaces the context.

The existing third commit also contains `ggml/src/ggml-cuda/rms-norm-quantize.cu` and `.cuh`. Publication preserves that existing commit; it does not rewrite history. Uncommitted GPU/LoRA experiments are not part of this snapshot publication. For a server-only follow-up diff without those kernel files, use `patches/0005-save-slot-before-eviction.patch`, applied after `0004-persist-context-checkpoints.patch` on a compatible tree. The pinned server fork already has the fixes: do not apply them twice.

Patch verification applied `0004` then `0005` to temporary copies of the server files from `503855413`. The resulting `server-context.cpp` and `server-task.h` matched the files in `16f213bba` byte-for-byte. This verifies patch composition, not a C++ build or server unit-test run.

Pi is published to the operator's fork topic branch, not the upstream `earendil-works/pi` repository or the fork's older `main`. The topic branch preserves the exact local base on which the dependency tests ran, including its earlier speculative-prefill commits; it is not a cherry-picked feature against an older core.

## Checkpoint lifecycle and concurrency

1. `before_provider_request` sees the complete serialized system prompt/tools, verifies the local server runtime, audits canonical golden, resolves a slot, and assigns `id_slot` plus `slot_snapshot`.
2. An intermediate `turn_end` with tool results skips the client save. A final `turn_end` and `agent_end` may checkpoint according to token thresholds.
3. A successful save records the session/slot/message leaf so the same final state is not saved twice. Failed saves do not record that marker and can retry.
4. Session speculative prefill preserves `slot_snapshot`; a changed/removed owner prevents stale pinning.
5. When a different owner takes a dirty slot, patched llama-server writes its unsaved target/draft/checkpoint state before replacement.

**Disk saves are synchronous on the server main task loop.** Pi awaits serialized extension operations; llama-server synchronizes the context and writes files before returning. Increasing save/restore deadlines to 300 seconds prevents the former 5-second control deadline from aborting legitimate heavy/queued I/O, but does not remove that work from the inference critical path.

A safe future background writer would first capture a consistent independent snapshot and then write that immutable copy. Merely dropping an `await` or serializing a live context in another thread is not implemented or claimed safe.

Restore and the following generation request are separate operations. Independent Pi processes do not share a slot lease, so another request can take the selected slot between them. Golden publication locks protect golden files, not all slot scheduling.

## Canonical golden and retention

- One runtime-bound `golden_<runtime-hash>_base_system_prompt.bin` is shared across session-prefix namespaces. Ordinary prompt/tool differences warn rather than create another golden.
- A newer loaded-extension fingerprint can refresh golden from the canonical cwd. An older already-loaded worker cannot roll that update back. `/kv base-update` is the explicit replacement path.
- Golden updates use a per-runtime directory lock, staged files, rollback backups and metadata-last publication. A crash may leave locks/backups requiring operator recovery; there is no automatic stale-lock deletion.
- Metadata-bound `kv2_` / `golden_` files contribute binary/sidecar bytes to disk accounting. `maxSessions` applies to the active session namespace; global disk eviction can remove owned sessions from other namespaces. Golden/base files are not evicted. Pending/unbound/legacy files are neither counted nor automatically removed, so the budget is not a hard cap on all files in the directory.
- Runtime discovery is cached for up to 60 seconds while the PID/start identity and adapter response remain unchanged. Full listener/process/model/file verification happens on cache expiry or failed cached checks, not on every cached lookup. Model/template/adapter files must remain immutable while loaded; restart after changing them.

## Validation gates

### CPU/static verification of the committed sources

KV extension, from its repository root:

```sh
npm test
```

This rebuilds tracked `dist/` from TypeScript and runs the isolated Node CPU fixtures. **63/63 passed**. The release review added a failing-then-passing regression that proves cross-namespace LRU preserves legacy and mismatched-namespace binaries/sidecars even over quota. Existing golden publication, cross-process cold creation, cancellation, runtime refresh, prefix identity, leaf deduplication and slot-owner tests also pass.

Pi core, from `packages/coding-agent`:

```sh
node ../../node_modules/vitest/dist/cli.js --run test/extensions-fingerprint.test.ts test/prefill.test.ts
```

**29/29 passed**. From the Pi repository root, **`npm run check` passed**, including formatting/lint, dependency and entry-graph checks, install/shrinkwrap consistency, TypeScript and browser smoke. No real provider credentials are used by these targeted tests. Full Pi tests, a server rebuild and a clean-checkout live rerun were not performed for this publication. Added-line static security checks and direct diff review were performed; no independent reviewer agent was used.

### Earlier deployed four-session live test

The live test on 2026-10-05 used four fresh persistent Pi RPC processes and approximately 40k-token conversations against the already running two-slot server. It used installed extensions and deployed Pi core, not a freshly built clean checkout. Four priming turns were excluded; ten continuation rounds selected sessions with `random.Random(4242)` and no consecutive repeated session. `read`/`bash` results were changed between rounds and unique session recall was checked.

| Metric | Result |
| --- | --- |
| Correct rounds / long-prefix-hit rounds | 10/10 / 10/10 |
| Long-prefix-hit model requests | 20/20 |
| Disk restore / RAM-resident rounds | 6 / 4 |
| Minimum prompt-prefix reuse | 99.417% |
| Maximum new prefill | 237 tokens |
| Tool-result continuation prefill | 93–102 tokens |
| TTFT median / maximum | 0.763 s / 0.937 s |
| Whole-round median / maximum | 2.666 s / 3.031 s |

Cache reuse was established from server `n_past`/prompt-evaluation evidence and provider cache-read reporting, not snapshot filenames, restore token counts or UI labels alone.

Local raw evidence: `four-session-20261005-2035-ten-rounds/{manifest.json,cache-evidence.json,analysis.json,results.json,server.raw.log,server.jsonl}` under the operator's `qwen-date-audit` directory. Raw conversations and KV binaries are not included in the repository. A sanitized metric summary is in [validation/snapshot-20261005.json](validation/snapshot-20261005.json).

## Binary and test provenance limits

The deployed executable inspected during the investigation is:

```text
llama-mtp-deploy/gfx1151-gdnfused-503855413-20260926/bin/llama-server
SHA-256: bd849d58ac8ec4b4b7b3fd2c86f45717d0e33bdbe02002063024cf6f82ad2eaf
```

Its binary/logs confirm checkpoint-sidecar and eviction-before-save support despite the old-looking deployment directory. The SHA-256 was recorded during release review, after the live run, and is not a contemporaneous build manifest. A complete clean-source commit/build mapping for that binary was not established. The live test also preceded the additional LRU ownership guard, which was verified by CPU regression tests only.

Publishing the source dependencies removes the uncommitted Pi/extension dependency gap. It does **not** retroactively turn the earlier live run into a clean-rebuild benchmark. Sequential switching/tool loops do not prove simultaneous-request correctness, live web-search behavior, or asynchronous disk writes. No service was restarted or redeployed for this commit/push operation.
