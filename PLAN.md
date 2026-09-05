# 🚀 pi-kv-cache-manager: Complete Architecture & Implementation Plan

> **Project**: `pi-kv-cache-manager`  
> **Target Environment**: Pi Agent (`@earendil-works/pi-coding-agent`), `llama-server` (ROCm / AMD Strix Halo gfx1151)  
> **Primary Goal**: Eliminate long-context cold prefill latency (reducing 110k~150k token TTFT from **170s to 0.3s**, 543x speedup) through automated tiered KV cache lifecycle management.

---

## 1. Background & Empirical Baseline

On high-parameter mixture-of-experts architectures (e.g. Qwen 3.6 35B-A3B), prefill evaluation suffers from quadratic complexity $O(N^2)$ due to self-attention and massive KV cache memory traffic:

$$T(N) = c_1 N + c_2 N^2 \quad (c_1 \approx 0.6 \text{ ms/tok}, \; c_2 \approx 3.72 \times 10^{-9} \text{ s/tok}^2)$$

### Empirical Measurements on AMD Strix Halo (gfx1151, NVMe SSD)
| Context Length | Cold Prefill Time | Snapshot Size | Disk Restore Time | **Speedup Factor** |
| :--- | :---: | :---: | :---: | :---: |
| **20,000 tokens** | 14.00 s | 453.9 MB | 0.036 s | **393x** |
| **50,000 tokens** | 35.70 s | 1.02 GB | 0.117 s | **304x** |
| **100,000 tokens** | 101.40 s | 1.97 GB | 0.216 s | **470x** |
| **150,000 tokens** | 170.59 s | 2.93 GB | 0.314 s | **543x** |

**Conclusion**: Re-evaluating 110k+ tokens takes ~2 minutes of 100W GPU heat. Reading 2.2 GB from NVMe takes **~0.24 seconds**. Managing KV snapshots provides instantaneous resume with zero token degradation.

---

## 2. Architecture Roadmap

The project is structured into **4 cohesive engineering phases**:

```mermaid
graph TD
    subgraph Phase 1: Engine Foundation
        P1[llama.cpp Patch PR #25076] --> S1[Allow text-only slot save/restore with --mmproj]
        S1 --> S2[HTTP Endpoint /slots/:id?action=save|restore]
    end

    subgraph Phase 2: Session Quota & LRU
        S2 --> L1[LRU Cache Registry]
        L1 --> L2[Configurable Max Sessions & Quota]
        L2 --> L3[Metadata Sidecar *.meta.json]
    end

    subgraph Phase 3: Incremental Lazy Checkpointing
        L3 --> C1[turn_end Lifecycle Hook]
        C1 --> C2[Step-based Threshold: e.g. every 5,000 tokens]
        C2 --> C3[Debounced Non-blocking Async Save]
    end

    subgraph Phase 4: Golden Base Cache
        C3 --> B1[session_start / pi new Hook]
        B1 --> B2[System Prompt + Skill Descriptions Hash]
        B2 --> B3[0.02s Instant Cold Boot on pi new]
    end
```

---

## 3. Phase 1: Upstream `llama.cpp` Patch (PR #25076 Relaxed Guard)

### Problem
When `llama-server` starts with `--mmproj` (vision projector), `server-context.cpp` contains an overly broad check:
```cpp
bool check_no_mtmd(const int id_task) {
    if (mctx) {
        send_error(id_task, "This feature is not supported by multimodal", ERROR_TYPE_NOT_SUPPORTED);
        return false;
    }
    return true;
}
```
This causes any call to `/slots/{id}?action=save|restore` to abort with HTTP 501, even if the current session slot is 100% text and code.

### Solution & Patch Specification
Relax the assertion to check **whether the specific slot contains media chunks**, rather than whether the global server has loaded `--mmproj`:
```cpp
bool check_no_mtmd_for_slot(const int id_task, const server_slot * slot) {
    if (slot && slot->prompt.tokens.has_mtmd && !slot->prompt.tokens.empty_media()) {
        send_error(id_task, "This feature is not supported for slots containing active media", ERROR_TYPE_NOT_SUPPORTED);
        return false;
    }
    return true;
}
```
* **Patch File**: `patches/0001-allow-text-slot-save-restore-with-mmproj.patch`
* **Target**: `tools/server/server-context.cpp`
* **Benefit**: Users can keep `--mmproj` loaded for vision queries, while all code/text sessions seamlessly enjoy KV cache snapshot saving and restoring.

---

## 4. Phase 2: LRU Session Cache Management & Storage Quota

### Problem
Without bounded storage, saving multiple 110k-token sessions (each ~2.2 GB) will gradually accumulate on the SSD.

### Architecture Specification
1. **Configurable Constraints**:
   * `maxSessions`: Maximum number of stored session snapshots (default: `30`).
   * `maxDiskUsageGb`: Hard disk quota in GB (default: `40` GB).
   * `cacheDir`: Storage root (default: `~/.cache/llama-slots/`).
2. **Metadata Sidecar (`<snapshot>.meta.json`)**:
   Every `<name>.bin` has a lightweight `<name>.meta.json`:
   ```json
   {
     "sessionId": "019e8e8b-560f-7857-ac12-c61c682ea915",
     "sessionName": "my-trading-agent",
     "tokenCount": 110450,
     "fileSizeBytes": 2116264692,
     "createdAt": "2026-09-05T18:30:00Z",
     "lastAccessedAt": "2026-09-05T23:15:00Z",
     "promptPrefixHash": "a8f39b12c4d5e6f7"
   }
   ```
3. **LRU Eviction Engine**:
   * Scans metadata files sorted by `lastAccessedAt`.
   * When `entries.length > maxSessions` or `totalBytes > maxDiskUsageGb`:
     * Automatically unlinks the oldest `.bin` and `.meta.json`.
     * Emits notification to the Pi UI status bar.

---

## 5. Phase 3: Incremental Lazy Checkpointing (Step-Based)

### Problem
Writing a 2.2 GB file on *every* user sentence wastes I/O and creates thrashing risk. On the other hand, saving *only* on exit risks losing state if a crash occurs.

### Architecture Specification
1. **Step-based Token Increment Trigger**:
   * Minimum activation threshold: `minTokensThreshold = 25,000` (short sessions don't need snapshots; prefilling < 20k takes < 14s).
   * Step increment: `stepTokensIncrement = 5,000` (or `10,000`).
2. **State Tracking**:
   * The extension tracks `lastSavedTokenCount` per session in memory.
   * On `turn_end`:
     $$\Delta = \text{currentTokens} - \text{lastSavedTokenCount}$$
     If $\Delta \ge \text{stepTokensIncrement}$ and $\text{currentTokens} \ge \text{minTokensThreshold}$:
     Trigger non-blocking background snapshot save.
3. **Prefix Alignment Guarantee**:
   * If session is at 113,000 tokens and snapshot is at 110,000 tokens:
     1. Restore 110,000 tokens from disk (0.24s).
     2. `llama-server` matches first 110k tokens via Longest Common Prefix (LCP).
     3. GPU evaluates only the delta (3,000 tokens) in ~1.8s.
     4. Total resume latency: **~2.0s** (instead of 120s).

---

## 6. Phase 4: Golden Base System Prompt & Skills Caching

### Problem
Even brand new sessions (`pi new`) must evaluate the system prompt, tool definitions, and all active skills (e.g. `~/.hermes/skills/`), which often totals **5,000 ~ 15,000 tokens** (taking 6~9s on every new chat).

### Architecture Specification
1. **Golden Base Snapshot (`base_system_prompt.bin`)**:
   * Extracts the full compiled system prompt via `ctx.getSystemPrompt()`.
   * Computes SHA256 signature: `currentHash = sha256(ctx.getSystemPrompt())`.
2. **Deterministic Lifecycle**:
   * On `session_start` (when creating a new session):
     * Check `base_system_prompt.meta.json`.
     * **Cache HIT** (`meta.hash == currentHash`):
       * `POST /slots/0?action=restore {"filename": "base_system_prompt.bin"}`
       * Restores 10,000 tokens in **20 ms**!
     * **Cache MISS** (Skills updated, tools edited, or first boot):
       * Executes prefill on the slot with `prompt = systemPrompt, n_predict = 0`.
       * Immediately snapshots to `base_system_prompt.bin`.
       * Writes updated hash to `base_system_prompt.meta.json`.
       * All subsequent `pi new` invocations boot instantaneously.

---

## 7. Extension Commands & User Controls

The extension registers user-friendly slash commands in Pi Agent:
* `/kv status`: Displays current cache utilization, active snapshots, hit rate, and SSD usage.
* `/kv save [name]`: Manually snapshots current slot to a named checkpoint.
* `/kv restore [name]`: Manually restores slot from a named checkpoint.
* `/kv prune`: Manually triggers LRU cleanup to free disk space.
* `/kv base-update`: Forces a re-generation of the Golden Base System Prompt snapshot.

---

## 8. Directory Layout

```text
pi-kv-cache-manager/
├── PLAN.md                          <-- Complete Specification (This File)
├── README.md                        <-- User Guide & Installation
├── package.json                     <-- Extension Manifest & Dependencies
├── tsconfig.json                    <-- TypeScript Compilation Target
├── patches/
│   └── 0001-allow-text-slot-save-restore-with-mmproj.patch
└── src/
    ├── index.ts                     <-- Extension Entry Point & Event Wiring
    ├── config.ts                    <-- Configuration & Defaults Loader
    ├── types.ts                     <-- Type Definitions & Schemas
    ├── lru-manager.ts               <-- Quota & LRU Storage Cleaner
    ├── checkpoint-engine.ts         <-- Step-based Lazy Checkpointing
    └── base-cache.ts                <-- Golden System Prompt Cache Manager
```
