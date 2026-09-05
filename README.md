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

## 🚀 Key Features

1. **Upstream `llama.cpp` Multimodal Patch (`patches/0001-...`)**:
   - Solves the upstream limitation where loading `--mmproj` disables slot save/restore for all slots.
   - Checks slot-level media chunks rather than the global multimodal context, allowing pure text/code sessions to save and restore seamlessly even while vision models are loaded.

2. **LRU Session Quota & Sidecar Metadata**:
   - Maintains `.meta.json` sidecars tracking `sessionId`, `sessionName`, `tokenCount`, `fileSizeBytes`, and `lastAccessedAt`.
   - Automatically evicts the oldest snapshots when stored sessions exceed `maxSessions` (default: 30) or hard disk quota `maxDiskUsageGb` (default: 40 GB).

3. **Incremental Lazy Checkpointing**:
   - Saves slot state asynchronously on `turn_end` without stalling conversation.
   - Activates only once context exceeds `minTokensThreshold` (default: 25,000 tokens) and advances by at least `stepTokensIncrement` (default: 5,000 tokens).
   - If an unexpected shutdown occurs, the next launch restores the 110k token snapshot in 0.2s and only precomputes the trailing delta!

4. **Golden Base System Prompt & Skills Caching**:
   - Extracts the compiled system prompt, active skill descriptions, and tool schemas.
   - Hashes with SHA256. If a match is found in `base_system_prompt.bin`, `pi new` boots in **~20ms** instead of 6~9s!
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
ln -s /home/chihmin/.gemini/antigravity-cli/scratch/pi-kv-cache-manager ~/.pi/agent/extensions/pi-kv-cache-manager
```

Build the TypeScript files:
```bash
cd /home/chihmin/.gemini/antigravity-cli/scratch/pi-kv-cache-manager
npm run build
```

---

## ⚙️ Configuration

Add a `kvCache` block to `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
  "kvCache": {
    "llamaServerUrl": "http://127.0.0.1:8001",
    "slotId": 0,
    "cacheDir": "/home/chihmin/.cache/llama-slots",
    "maxSessions": 30,
    "maxDiskUsageGb": 40,
    "minTokensThreshold": 25000,
    "stepTokensIncrement": 5000,
    "enableBaseCache": true,
    "enableIncrementalSave": true
  }
}
```

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
- `[KV: Base 12k ⚡]`: Golden Base cache hit; instant cold start achieved.

---

## 🏗️ Project Architecture

```text
pi-kv-cache-manager/
├── PLAN.md                     # Comprehensive 4-Phase Architecture Specification
├── README.md                   # Installation & User Documentation
├── package.json                # NPM Manifest & TypeScript Scripts
├── tsconfig.json               # ES2022 / NodeNext TypeScript Configuration
├── patches/
│   └── 0001-allow-text-slot-save-restore-with-mmproj.patch # Upstream PR patch
└── src/
    ├── index.ts                # Pi Agent Extension Entry Point & Hook Wiring
    ├── config.ts               # Configuration Loader & Environment Defaults
    ├── types.ts                # Data Types, Schemas & API Responses
    ├── lru-manager.ts          # LRU Eviction Engine & Sidecar Metadata
    ├── checkpoint-engine.ts    # Incremental Lazy Checkpointer & llama-server API
    └── base-cache.ts           # Golden System Prompt & Skills Cache Manager
```

---

## 📄 License
MIT © 2026 Chih-Min
