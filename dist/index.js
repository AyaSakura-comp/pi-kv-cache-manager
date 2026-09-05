import * as path from "node:path";
import * as fs from "node:fs/promises";
import { loadConfig } from "./config.js";
import { LruManager } from "./lru-manager.js";
import { CheckpointEngine, saveSlot, restoreSlot, sanitizeFilename } from "./checkpoint-engine.js";
import { BaseCacheManager, computeHash } from "./base-cache.js";
const STATUS_KEY = "kv-cache";
function formatTokens(n) {
    if (n >= 1000000)
        return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000)
        return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}
export default function piKvCacheManager(pi) {
    const config = loadConfig();
    const lru = new LruManager(config.cacheDir);
    const engine = new CheckpointEngine(config, lru);
    const baseCache = new BaseCacheManager(config, lru);
    // Hook 1: Session Start (Cold boot or resume)
    pi.on("session_start", async (_event, ctx) => {
        try {
            const sessionId = ctx.sessionManager?.getSessionId();
            if (!sessionId)
                return;
            const snapFilename = engine.getSnapshotFilename(sessionId);
            const snapPath = path.join(config.cacheDir, snapFilename);
            let resumed = false;
            try {
                await fs.access(snapPath);
                resumed = true;
            }
            catch {
                resumed = false;
            }
            if (resumed) {
                // Case A: Existing session resumption
                try {
                    const resp = await restoreSlot(config.llamaServerUrl, config.slotId, snapFilename);
                    await lru.touchSnapshot(snapFilename);
                    const tokens = resp.n_tokens ?? 0;
                    engine.setSavedTokens(sessionId, tokens);
                    ctx.ui.setStatus(STATUS_KEY, `KV: ${formatTokens(tokens)} ⚡`);
                    ctx.ui.notify(`Restored KV cache: ${tokens.toLocaleString()} tokens in ${resp.t_ms?.toFixed(1) || 0}ms (⚡ instant resume)`, "info");
                    return;
                }
                catch (err) {
                    console.warn(`[pi-kv-cache-manager] Failed to restore session snapshot:`, err);
                }
            }
            // Case B: Brand new session - check Golden Base cache
            if (config.enableBaseCache && typeof ctx.getSystemPrompt === "function") {
                const systemPrompt = ctx.getSystemPrompt();
                if (systemPrompt && systemPrompt.length > 0) {
                    const res = await baseCache.checkAndRestore(systemPrompt);
                    if (res.status === "hit") {
                        ctx.ui.setStatus(STATUS_KEY, `KV: Base ${formatTokens(res.tokens ?? 0)} ⚡`);
                        ctx.ui.notify(`Restored Golden Base KV: ${res.tokens?.toLocaleString()} tokens in ${res.durationMs?.toFixed(1) || 0}ms (⚡ instant boot)`, "info");
                    }
                    else if (res.status === "miss") {
                        // Background pre-warm and snapshot Golden Base for future sessions
                        baseCache.warmAndSave(systemPrompt, res.hash).then((warmInfo) => {
                            ctx.ui.setStatus(STATUS_KEY, `KV: Base ${formatTokens(warmInfo.tokens)} 💾`);
                            ctx.ui.notify(`Created Golden Base KV cache: ${warmInfo.tokens.toLocaleString()} tokens saved for instant future boots.`, "info");
                        }).catch((err) => {
                            console.warn(`[pi-kv-cache-manager] Failed to warm base cache:`, err);
                        });
                    }
                }
            }
        }
        catch (err) {
            console.warn(`[pi-kv-cache-manager] Error in session_start handler:`, err);
        }
    });
    // Hook 2: Turn End (Incremental lazy checkpointing)
    pi.on("turn_end", async (_event, ctx) => {
        try {
            const sessionId = ctx.sessionManager?.getSessionId();
            if (!sessionId)
                return;
            const usage = ctx.getContextUsage?.();
            const currentTokens = usage?.tokens || 0;
            const sessionName = ctx.sessionManager?.getSessionName?.();
            await engine.maybeCheckpoint(sessionId, sessionName, currentTokens, (info) => {
                ctx.ui.setStatus(STATUS_KEY, `KV: ${formatTokens(info.tokens)} 💾`);
                // Live status update without interrupting chat
            }, (err) => {
                console.warn(`[pi-kv-cache-manager] Incremental save error:`, err);
            });
        }
        catch (err) {
            console.warn(`[pi-kv-cache-manager] Error in turn_end handler:`, err);
        }
    });
    // Hook 3: Session Shutdown (Cleanup UI status)
    pi.on("session_shutdown", async (_event, ctx) => {
        try {
            ctx.ui.setStatus(STATUS_KEY, undefined);
        }
        catch {
            // Ignored
        }
    });
    // Slash Commands: /kv [status|save|restore|prune|base-update|help]
    pi.registerCommand("kv", {
        description: "Manage llama.cpp slot KV cache snapshots and lifecycle",
        getArgumentCompletions: (prefix) => {
            const subcommands = ["status", "save", "restore", "prune", "base-update", "help"];
            return subcommands
                .filter((s) => s.startsWith(prefix.toLowerCase()))
                .map((s) => ({ value: s, label: s }));
        },
        handler: async (rawArgs, ctx) => {
            const args = rawArgs.trim().split(/\s+/).filter(Boolean);
            const sub = (args[0] || "status").toLowerCase();
            switch (sub) {
                case "status": {
                    const snapshots = await lru.listSnapshots();
                    const totalBytes = snapshots.reduce((acc, s) => acc + s.meta.fileSizeBytes, 0);
                    const baseSnap = snapshots.find((s) => s.meta.isBaseSnapshot);
                    const sessionSnaps = snapshots.filter((s) => !s.meta.isBaseSnapshot);
                    const usage = ctx.getContextUsage?.();
                    const activeTokens = usage?.tokens ?? 0;
                    const sessionId = ctx.sessionManager?.getSessionId() || "unknown";
                    const lastSavedTokens = engine.getSavedTokens(sessionId);
                    const lines = [
                        "### ⚡ Pi KV Cache Manager Status",
                        "",
                        `- **Llama Server**: \`${config.llamaServerUrl}\` (Slot: \`${config.slotId}\`)`,
                        `- **Cache Storage Root**: \`${config.cacheDir}\``,
                        `- **Disk Usage**: **${LruManager.formatBytes(totalBytes)}** / ${config.maxDiskUsageGb} GB (${snapshots.length} total snapshots)`,
                        `- **Session Snapshots**: ${sessionSnaps.length} / ${config.maxSessions} max`,
                        `- **LRU Evictions Performed**: ${lru.getEvictionsCount()}`,
                        `- **Active Session Tokens**: ${activeTokens.toLocaleString()} (Saved: ${lastSavedTokens.toLocaleString()}, Delta: ${(activeTokens - lastSavedTokens).toLocaleString()})`,
                        `- **Incremental Auto-save**: ${config.enableIncrementalSave ? `Enabled (every ${config.stepTokensIncrement.toLocaleString()} tok, min ${config.minTokensThreshold.toLocaleString()})` : "Disabled"}`,
                        `- **Golden Base Cache**: ${baseSnap ? `✅ ${baseSnap.meta.tokenCount.toLocaleString()} tokens (${LruManager.formatBytes(baseSnap.meta.fileSizeBytes)})` : "❌ None"}`,
                        "",
                    ];
                    if (sessionSnaps.length > 0) {
                        lines.push("#### Stored Sessions:");
                        lines.push("| Session ID / Name | Tokens | Disk Size | Last Accessed |");
                        lines.push("| :--- | :---: | :---: | :---: |");
                        for (const s of sessionSnaps) {
                            const label = s.meta.sessionName ? `${s.meta.sessionName} (\`${s.meta.sessionId.slice(0, 8)}\`)` : `\`${s.meta.sessionId.slice(0, 8)}...\``;
                            lines.push(`| ${label} | ${s.meta.tokenCount.toLocaleString()} | ${LruManager.formatBytes(s.meta.fileSizeBytes)} | ${new Date(s.meta.lastAccessedAt).toLocaleString()} |`);
                        }
                    }
                    ctx.ui.notify(lines.join("\n"), "info");
                    break;
                }
                case "save": {
                    const customName = args[1];
                    const sessionId = ctx.sessionManager?.getSessionId() || "manual";
                    const filename = customName
                        ? `snap_${sanitizeFilename(customName)}.bin`
                        : engine.getSnapshotFilename(sessionId);
                    try {
                        ctx.ui.notify(`Saving KV snapshot to \`${filename}\`...`, "info");
                        const resp = await saveSlot(config.llamaServerUrl, config.slotId, filename);
                        const tokens = resp.n_tokens ?? 0;
                        engine.setSavedTokens(sessionId, tokens);
                        const metaPath = path.join(config.cacheDir, filename.replace(/\.bin$/, ".meta.json"));
                        await lru.writeMetadata(metaPath, {
                            sessionId,
                            sessionName: customName || ctx.sessionManager?.getSessionName?.(),
                            tokenCount: tokens,
                            fileSizeBytes: resp.n_bytes ?? 0,
                            createdAt: new Date().toISOString(),
                            lastAccessedAt: new Date().toISOString(),
                            promptPrefixHash: "",
                            isBaseSnapshot: false,
                        });
                        await lru.enforceLRU(config);
                        ctx.ui.setStatus(STATUS_KEY, `KV: ${formatTokens(tokens)} 💾`);
                        ctx.ui.notify(`✅ Successfully saved ${tokens.toLocaleString()} tokens (${LruManager.formatBytes(resp.n_bytes ?? 0)}) in ${resp.t_ms?.toFixed(1) || 0}ms`, "info");
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        ctx.ui.notify(`❌ Failed to save snapshot: ${msg}`, "error");
                    }
                    break;
                }
                case "restore": {
                    const customName = args[1];
                    const sessionId = ctx.sessionManager?.getSessionId() || "manual";
                    const filename = customName
                        ? (customName.endsWith(".bin") ? customName : `snap_${sanitizeFilename(customName)}.bin`)
                        : engine.getSnapshotFilename(sessionId);
                    try {
                        ctx.ui.notify(`Restoring KV snapshot from \`${filename}\`...`, "info");
                        const resp = await restoreSlot(config.llamaServerUrl, config.slotId, filename);
                        await lru.touchSnapshot(filename);
                        const tokens = resp.n_tokens ?? 0;
                        engine.setSavedTokens(sessionId, tokens);
                        ctx.ui.setStatus(STATUS_KEY, `KV: ${formatTokens(tokens)} ⚡`);
                        ctx.ui.notify(`✅ Successfully restored ${tokens.toLocaleString()} tokens in ${resp.t_ms?.toFixed(1) || 0}ms`, "info");
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        ctx.ui.notify(`❌ Failed to restore snapshot: ${msg}`, "error");
                    }
                    break;
                }
                case "prune": {
                    try {
                        const result = await lru.enforceLRU(config);
                        if (result.prunedFiles.length > 0) {
                            ctx.ui.notify(`🧹 Evicted ${result.prunedFiles.length} snapshot(s) (${LruManager.formatBytes(result.freedBytes)} freed):\n${result.prunedFiles.join(", ")}`, "info");
                        }
                        else {
                            ctx.ui.notify(`LRU cache is already within quota limits. Nothing to evict.`, "info");
                        }
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        ctx.ui.notify(`❌ Prune failed: ${msg}`, "error");
                    }
                    break;
                }
                case "base-update": {
                    if (typeof ctx.getSystemPrompt !== "function") {
                        ctx.ui.notify("System prompt unavailable in this context.", "warning");
                        return;
                    }
                    const prompt = ctx.getSystemPrompt();
                    const hash = computeHash(prompt);
                    try {
                        ctx.ui.notify("Prefilling system prompt and skills into slot 0...", "info");
                        const info = await baseCache.warmAndSave(prompt, hash);
                        ctx.ui.setStatus(STATUS_KEY, `KV: Base ${formatTokens(info.tokens)} 💾`);
                        ctx.ui.notify(`✅ Golden Base cache refreshed: ${info.tokens.toLocaleString()} tokens (${LruManager.formatBytes(info.bytes)}) saved in ${info.durationMs.toFixed(1)}ms`, "info");
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        ctx.ui.notify(`❌ Base update failed: ${msg}`, "error");
                    }
                    break;
                }
                case "help":
                default: {
                    ctx.ui.notify(`**Pi KV Cache Manager Commands**:\n` +
                        `- \`/kv status\` : Show current cache usage, active tokens, and snapshot table\n` +
                        `- \`/kv save [name]\` : Manually snapshot current session or named file\n` +
                        `- \`/kv restore [name]\` : Restore session or named snapshot\n` +
                        `- \`/kv prune\` : Enforce LRU session count and storage quotas\n` +
                        `- \`/kv base-update\` : Re-evaluate and cache Golden Base System Prompt\n` +
                        `- \`/kv help\` : Show this help message`, "info");
                    break;
                }
            }
        },
    });
}
//# sourceMappingURL=index.js.map