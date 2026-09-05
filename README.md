# ⚡ pi-kv-cache-manager

> **High-Performance KV Cache Lifecycle & Snapshot Manager for Pi Agent (`@earendil-works/pi-coding-agent`) & `llama-server`**  
> Cuts long-context cold prefill latency from **~170s to 0.3s (543x speedup)** on local hardware (tested on AMD Strix Halo gfx1151 + NVMe SSD).

---

## 🎯 Motivation & Empirical Proof

On large Mixture-of-Experts and dense models (such as Qwen 3.6 35B-A3B), context evaluation exhibits quadratic scaling:

$$T(N) = c_1 N + c_2 N^2 \quad (c_1 \approx 0.6 \text{ ms/tok}, \; c_2 \approx 3.72 \times 10^{-9} \text{ s/tok}^2)$$

When working with long coding agent sessions (100k ~ 260k tokens), restarting a session or loading a new context forces the GPU to chew through gigabytes of attention matrices for **2 to 3 minutes** before generating a single token (TTFT).

### Empirical Benchmarks on AMD Strix Halo (NVMe SSD)

| Context Length | Cold GPU Prefill | Snapshot Size | NVMe Restore Time | **Speedup Factor** |
| :--- | :---: | :---: | :---: | :---: |
| **20,000 tokens** | 14.00 s | 453.9 MB | 0.036 s | **393x** |
| **50,000 tokens** | 35.70 s | 1.02 GB | 0.117 s | **304x** |
| **100,000 tokens** | 101.40 s | 1.97 GB | 0.216 s | **470x** |
| **150,000 tokens** | 170.59 s | 2.93 GB | 0.314 s | **543x** |

Instead of re-evaluating 150k tokens (consuming ~2.8 minutes of 100W APU heat), reading 2.9 GB from NVMe takes **~0.3 seconds**.

---

## 🏛️ Software Architecture

`pi-kv-cache-manager` operates as an extension for Pi Agent. It sits between the agent lifecycle hooks and the underlying `llama-server` slot management REST API, coordinating disk snapshots, LRU quotas, and prompt cache hashes.

```mermaid
graph TB
    subgraph HostClient ["Pi Agent Harness (CLI / Web / Discord)"]
        PiSession["AgentSession (@earendil-works/pi-coding-agent)<br/>• Lifecycle Events (session_start, turn_end, session_shutdown)<br/>• Extension API Context (ctx.getSystemPrompt, ctx.ui)"]
        SlashCmd["Slash Command Dispatcher (/kv status, save, restore, prune, base-update)"]
        PiSession --> SlashCmd
    end

    subgraph ExtensionCore ["pi-kv-cache-manager (Extension Core)"]
        ExtEntry["Extension Entry (src/index.ts)<br/>Registers hooks, commands, and UI status"]
        ConfigMgr["Configuration Loader (src/config.ts)<br/>Merges settings.json with environment defaults"]
        
        ExtEntry --> ConfigMgr

        subgraph Modules ["Core Functional Modules"]
            BaseCache["BaseCacheManager (src/base-cache.ts)<br/>• SHA-256 System Prompt Hashing<br/>• Golden Base Pre-warm & Slot Snapshot<br/>• Instant Slot 0 Restore (~50ms)"]
            
            Checkpointer["CheckpointEngine (src/checkpoint-engine.ts)<br/>• Lazy Incremental Checkpoints on turn_end<br/>• Token Increment Threshold Gating<br/>• REST Client for llama.cpp Slot API"]
            
            LruEngine["LruManager (src/lru-manager.ts)<br/>• Metadata Sidecar Tracking (*.meta.json)<br/>• 30 Session Snapshot Limit<br/>• 40 GB Hard Storage Quota Eviction"]
        end

        ExtEntry --> BaseCache
        ExtEntry --> Checkpointer
        ExtEntry --> LruEngine
    end

    subgraph LlamaServer ["llama-server (AMD ROCm 7.x / GFX1151)"]
        SlotEndpoint["Slot Action REST API<br/>POST /slots/:id?action=save|restore|erase"]
        MultimodalPatch["Upstream Multimodal Patch (PR #25076)<br/>Permits text slot operations when --mmproj is loaded"]
        GpuKvCache["APU Unified Memory KV Cache (520k Context Window)"]

        SlotEndpoint --> MultimodalPatch
        MultimodalPatch --> GpuKvCache
    end

    subgraph StorageLayer ["NVMe Snapshot Storage (~/.cache/llama-slots/)"]
        BaseFiles[("Golden Base Snapshot<br/>• base_system_prompt.bin<br/>• base_system_prompt.meta.json")]
        SessionFiles[("Session Checkpoints<br/>• session_<id>.bin<br/>• session_<id>.meta.json<br/>• session_<id>.bin.media.json")]
    end

    SlashCmd --> ExtEntry
    BaseCache -->|Slot Actions| SlotEndpoint
    Checkpointer -->|Slot Actions| SlotEndpoint
    LruEngine -->|Quota Tracking & Unlink| StorageLayer
    SlotEndpoint -->|Direct Binary I/O| StorageLayer
```

---

## 🔄 Detailed Workflows

### 1. Session Initialization & Golden Base Warm-Start Workflow

When a new session opens or an existing session resumes, the extension determines whether to restore a session checkpoint or load the Golden Base cache:

```mermaid
sequenceDiagram
    autonumber
    actor Agent as Pi Agent Runtime
    participant Ext as Extension (index.ts)
    participant Base as BaseCacheManager (base-cache.ts)
    participant Engine as CheckpointEngine (checkpoint-engine.ts)
    participant Llama as llama-server (:8001)
    participant Disk as NVMe Storage (~/.cache/llama-slots/)

    Agent->>Ext: Hook: session_start
    Ext->>Ext: Check if session has previous history

    alt Case A: Resuming Existing Session
        Ext->>Disk: Check if session_<id>.bin exists
        Disk-->>Ext: Snapshot found
        Ext->>Engine: restoreSlot(slotId=0, filename=session_<id>.bin)
        Engine->>Llama: POST /slots/0?action=restore&filename=session_<id>.bin
        Llama->>Disk: Read binary KV cache state
        Disk-->>Llama: Binary KV payload transferred
        Llama-->>Engine: { n_restored: 110450, timings: { restore_ms: 220.5 } }
        Ext->>Ext: Update UI Status: [KV: 110k ⚡]
    else Case B: Blank / New Session (Golden Base Acceleration)
        Ext->>Agent: ctx.getSystemPrompt() (includes Tools & <available_skills>)
        Agent-->>Ext: Return compiled System Prompt string
        Ext->>Base: Check Golden Base (prompt, hash=SHA256(prompt))
        Base->>Disk: Read base_system_prompt.meta.json
        
        alt Cache Hit: Hash matches
            Base->>Llama: POST /slots/0?action=restore&filename=base_system_prompt.bin
            Llama->>Disk: Fast load 28k tokens from NVMe
            Disk-->>Llama: Loaded in ~50ms
            Llama-->>Base: { n_restored: 28498, timings: { restore_ms: 48.2 } }
            Ext->>Ext: Update UI Status: [KV: Base 28k ⚡]
        else Cache Miss: Hash mismatch or file missing
            Base->>Llama: POST /completion (prefill system prompt & tools into Slot 0)
            Llama-->>Base: Prefill complete
            Base->>Llama: POST /slots/0?action=save&filename=base_system_prompt.bin
            Llama->>Disk: Write base_system_prompt.bin
            Base->>Disk: Write base_system_prompt.meta.json (hash, tokenCount, date)
            Ext->>Ext: Update UI Status: [KV: Base 28k 💾]
        end
    end
```

---

### 2. Incremental Lazy Checkpointing on `turn_end`

To protect long-running sessions without blocking interactive turns, snapshots are written asynchronously:

```mermaid
sequenceDiagram
    autonumber
    actor Agent as Pi Agent
    participant Ext as Extension (index.ts)
    participant Engine as CheckpointEngine (checkpoint-engine.ts)
    participant Lru as LruManager (lru-manager.ts)
    participant Llama as llama-server (:8001)
    participant Disk as NVMe Storage (~/.cache/llama-slots/)

    Agent->>Ext: Hook: turn_end
    Ext->>Ext: Inspect current token count & step delta
    
    alt Tokens < minTokensThreshold (3,000) OR Delta < stepTokensIncrement (3,000)
        Ext-->>Agent: Skip checkpoint (turn context too small)
    else Checkpoint Threshold Met
        Ext->>Engine: queueLazySave(sessionId, tokens, slotId=0)
        Note over Engine: Runs asynchronously; does NOT block user chat
        Engine->>Llama: POST /slots/0?action=save&filename=session_<id>.bin
        Llama->>Disk: Save binary KV tensors to NVMe
        Llama-->>Engine: { n_saved: 45000, n_written: 960000000, timings: { save_ms: 95.4 } }
        Engine->>Disk: Write session_<id>.meta.json
        Engine->>Lru: enforceLRU(config)
        Note over Lru,Disk: Check 30 sessions max & 40 GB limit
        Lru-->>Engine: Quota compliant
        Engine-->>Ext: Checkpoint complete
        Ext->>Ext: Update UI Status: [KV: 45k 💾]
    end
```

---

### 3. LRU Quota Eviction & Storage Budget Flowchart

The LRU engine guarantees that stored KV snapshots never exhaust disk space:

```mermaid
flowchart TD
    Start([Trigger: enforceLRU]) --> ReadMetas[Scan directory for *.meta.json files]
    ReadMetas --> FilterNonBase[Filter out isBaseSnapshot == true]
    FilterNonBase --> SortAsc[Sort snapshots ascending by lastAccessedAt]
    SortAsc --> CalcUsage[Calculate total disk usage in bytes]
    
    CalcUsage --> CheckQuota{Snapshots > maxSessions (30)<br/>OR<br/>TotalBytes > maxDiskUsageGb (40 GB)?}
    
    CheckQuota -- No --> Done([LRU Quota Satisfied])
    CheckQuota -- Yes --> PickOldest[Pick oldest snapshot in sorted queue]
    
    PickOldest --> UnlinkBin[Unlink snapshot.bin]
    UnlinkBin --> UnlinkMeta[Unlink snapshot.meta.json]
    UnlinkMeta --> UnlinkMedia[Unlink snapshot.bin.media.json if exists]
    
    UnlinkMedia --> UpdateStats[Subtract file size from totalBytes<br/>Remove from snapshot list]
    UpdateStats --> CheckQuota
```

---

### 4. Extension Slash Command Dispatcher (`/kv`)

```mermaid
sequenceDiagram
    autonumber
    actor User as User (TUI / Discord / Web)
    participant Runner as Pi Extension Command Router
    participant Ext as /kv Command Handler
    participant Lru as LruManager
    participant Engine as CheckpointEngine
    participant Base as BaseCacheManager
    participant Llama as llama-server

    User->>Runner: /kv status
    Runner->>Ext: Execute slash command 'status'
    Ext->>Llama: Inspect slot status (tokens, processing state)
    Ext->>Lru: listSnapshots()
    Lru-->>Ext: Array of SnapshotMetadata
    Ext->>Ext: Format Markdown table (token count, size, timestamps, quota)
    Ext-->>User: Output status report

    opt Manual Save (/kv save [name])
        User->>Ext: /kv save my-checkpoint
        Ext->>Engine: saveSlot(slotId=0, filename=my-checkpoint.bin)
        Engine->>Llama: POST /slots/0?action=save&filename=my-checkpoint.bin
        Engine->>Lru: Write metadata & touch lastAccessedAt
        Ext-->>User: ✅ Snapshot saved
    end

    opt Manual Prune (/kv prune)
        User->>Ext: /kv prune
        Ext->>Lru: enforceLRU(config)
        Lru-->>Ext: { prunedFiles, freedBytes }
        Ext-->>User: 🧹 Reclaimed disk space report
    end

    opt Golden Base Update (/kv base-update)
        User->>Ext: /kv base-update
        Ext->>Base: warmAndSave(ctx.getSystemPrompt())
        Base->>Llama: Prefill & Snapshot to base_system_prompt.bin
        Ext-->>User: ✅ Golden Base refreshed
    end
```

---

## 🚀 Key Features

1. **Upstream `llama.cpp` Multimodal Patch (`patches/0001-...`)**:
   - Solves the upstream limitation where loading `--mmproj` disables slot save/restore for all slots.
   - Checks slot-level media chunks rather than the global multimodal context, allowing pure text/code sessions to save and restore seamlessly even while vision models are loaded.

2. **LRU Session Quota & Sidecar Metadata**:
   - Maintains `.meta.json` sidecars tracking `sessionId`, `sessionName`, `tokenCount`, `fileSizeBytes`, and `lastAccessedAt`.
   - Automatically evicts the oldest snapshots when stored sessions exceed `maxSessions` (default: 30) or hard disk quota `maxDiskUsageGb` (default: 40 GB).

3. **Incremental Lazy Checkpointing**:
   - Saves slot state asynchronously on `turn_end` without stalling conversation.
   - Activates once context exceeds `minTokensThreshold` (default: 3,000 tokens) and advances by at least `stepTokensIncrement` (default: 3,000 tokens).
   - If an unexpected shutdown occurs, the next launch restores the snapshot in ~0.2s and only precomputes the trailing delta!

4. **Golden Base System Prompt & Skills Caching**:
   - Extracts the compiled system prompt, active skill descriptions, and tool schemas via `ctx.getSystemPrompt()`.
   - Hashes with SHA-256. If a match is found in `base_system_prompt.bin`, `pi new` boots in **~20ms** instead of 6~9s!
   - Automatically re-warms and updates the snapshot whenever skills or tools are modified.

---

## 📦 Installation

### 1. Apply Upstream `llama.cpp` Patch (Optional but Recommended)
If your `llama-server` runs with `--mmproj`:
```bash
git -C /path/to/llama.cpp apply /path/to/pi-kv-cache-manager/patches/0001-allow-text-slot-save-restore-with-mmproj.patch
cmake --build /path/to/llama.cpp/build --target llama-server -j$(nproc)
```

### 2. Configure `llama-server`
Ensure `llama-server` is started with `--slot-save-path`:
```bash
llama-server \
  -m /path/to/model.gguf \
  --slot-save-path /home/chihmin/.cache/llama-slots/ \
  --port 8001
```

### 3. Install Extension in Pi Agent
Link the extension directly into Pi's extension directory:
```bash
mkdir -p ~/.pi/agent/extensions
ln -s /path/to/pi-kv-cache-manager ~/.pi/agent/extensions/pi-kv-cache-manager
```

Build the TypeScript files:
```bash
cd /path/to/pi-kv-cache-manager
npm run build
```

---

## ⚙️ Configuration

Configuration is loaded from `~/.pi/agent/settings.json` (global) or `.pi/settings.json` (project-local):

```json
{
  "kvCache": {
    "llamaServerUrl": "http://127.0.0.1:8001",
    "slotId": 0,
    "cacheDir": "/home/chihmin/.cache/llama-slots",
    "maxSessions": 30,
    "maxDiskUsageGb": 40,
    "minTokensThreshold": 3000,
    "stepTokensIncrement": 3000,
    "enableBaseCache": true,
    "enableIncrementalSave": true
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `llamaServerUrl` | `string` | `http://127.0.0.1:8001` | Base URL for llama-server HTTP API |
| `slotId` | `number` | `0` | Active llama.cpp slot ID to manage |
| `cacheDir` | `string` | `~/.cache/llama-slots` | Storage directory for KV snapshots and metadata sidecars |
| `maxSessions` | `number` | `30` | Maximum number of session snapshots before LRU eviction |
| `maxDiskUsageGb` | `number` | `40` | Hard disk quota in Gigabytes before LRU eviction |
| `minTokensThreshold` | `number` | `3000` | Minimum token count before automatic turn snapshots activate |
| `stepTokensIncrement` | `number` | `3000` | Token growth required between consecutive automatic snapshots |
| `enableBaseCache` | `boolean` | `true` | Enables Golden Base System Prompt & Skills prefill caching |
| `enableIncrementalSave`| `boolean` | `true` | Enables automatic background checkpointing on `turn_end` |

---

## ⌨️ Slash Commands (`/kv`)

| Command | Description |
| :--- | :--- |
| `/kv status` | Shows cache status, disk space used, base cache stats, and active session snapshots |
| `/kv save [name]` | Manually saves current slot state to session snapshot or a custom named checkpoint |
| `/kv restore [name]` | Manually restores slot from a specified snapshot file |
| `/kv prune` | Manually triggers LRU cleanup to reclaim SSD disk space |
| `/kv base-update` | Forces prefilling and updating the Golden Base System Prompt snapshot |
| `/kv help` | Displays available commands and usage guide |

---

## 📊 Status Bar Indicators

The extension dynamically updates the status line in Pi's UI footer:
- `[KV: 110k ⚡]`: Instant restore completed for 110,000 tokens.
- `[KV: 115k 💾]`: Background incremental snapshot written to NVMe SSD.
- `[KV: Base 28k ⚡]`: Golden Base cache hit; instant cold start achieved.
- `[KV: Base 28k 💾]`: Golden Base pre-warmed and saved to disk.

---

## 🏗️ Project Structure

```text
pi-kv-cache-manager/
├── PLAN.md                     # Comprehensive 4-Phase Architecture Specification
├── README.md                   # Installation, Architecture & Workflow Documentation
├── package.json                # NPM Manifest & TypeScript Scripts
├── tsconfig.json               # ES2022 / NodeNext TypeScript Configuration
├── patches/
│   └── 0001-allow-text-slot-save-restore-with-mmproj.patch # Upstream PR patch for llama.cpp
└── src/
    ├── index.ts                # Pi Agent Extension Entry Point, Hooks & Command Wiring
    ├── config.ts               # Configuration Loader & Defaults (30 sessions / 40GB)
    ├── types.ts                # Data Types, Schemas & API Responses
    ├── lru-manager.ts          # LRU Eviction Engine, Sidecar Metadata & Multimodal Cleanup
    ├── checkpoint-engine.ts    # Incremental Lazy Checkpointer & llama-server API Client
    └── base-cache.ts           # Golden System Prompt & Skills Cache Manager
```

---

## 📄 License
MIT © 2026 Chih-Min
