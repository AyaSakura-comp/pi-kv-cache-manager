import * as path from "node:path";
import { loadConfig } from "./config.js";
import { LruManager } from "./lru-manager.js";
import { CheckpointEngine, saveSlot, restoreSlot, sanitizeFilename, fetchSlots } from "./checkpoint-engine.js";
import { BaseCacheManager, computeHash } from "./base-cache.js";
import { SlotManager } from "./slot-manager.js";
const STATUS_KEY = "kv-cache";
function formatTokens(n) {
    if (n >= 1000000)
        return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000)
        return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}
function notifyUser(ctx, message, type = "info") {
    if (ctx.hasUI) {
        try {
            ctx.ui.notify(message, type);
            return;
        }
        catch {
            // Fallback to console
        }
    }
    if (type === "error") {
        console.error(message);
    }
    else if (type === "warning") {
        console.warn(message);
    }
    else {
        console.log(message);
    }
}
function isLlamaServerContext(ctx, config) {
    const model = ctx?.model;
    if (!model) {
        return false;
    }
    // 1. Explicit local llama provider
    if (model.provider === "local-llama") {
        return true;
    }
    // 2. Cloud and remote providers that do not support llama.cpp slots
    const nonLlamaProviders = [
        "openai-codex",
        "openai",
        "azure-openai",
        "anthropic",
        "gemini",
        "nvim",
        "sakana",
        "groq",
        "cerebras",
        "openrouter",
        "deepseek",
        "bedrock",
        "ollama",
        "ollama-gemma",
        "ollama-lfm2",
    ];
    if (model.provider && nonLlamaProviders.includes(model.provider)) {
        return false;
    }
    // 3. Match baseUrl host and port with configured llamaServerUrl
    if (model.baseUrl) {
        try {
            const modelUrl = new URL(model.baseUrl);
            const serverUrl = new URL(config.llamaServerUrl);
            const isLoopback = (host) => host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
            if (isLoopback(modelUrl.hostname) && isLoopback(serverUrl.hostname)) {
                if (modelUrl.port === serverUrl.port || (!modelUrl.port && serverUrl.port === "80")) {
                    return true;
                }
            }
        }
        catch {
            // Ignore URL parse error
        }
    }
    return false;
}
export default function piKvCacheManager(pi) {
    const config = loadConfig();
    const lru = new LruManager(config.cacheDir);
    const engine = new CheckpointEngine(config, lru);
    const baseCache = new BaseCacheManager(config, lru);
    const slotManager = new SlotManager(config, lru, engine, baseCache);
    const sessionSlots = new Map();
    const activateSessionSlot = async (ctx, systemPromptOverride, toolsOverride) => {
        const sessionId = ctx.sessionManager?.getSessionId();
        if (!sessionId)
            return config.slotId;
        const systemPrompt = systemPromptOverride ??
            (typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : undefined);
        const tools = toolsOverride;
        const res = await slotManager.ensureSlotForSession(sessionId, systemPrompt, tools);
        sessionSlots.set(sessionId, res.slotId);
        if (res.restored) {
            const label = res.isBase ? `Base ${formatTokens(res.tokens ?? 0)}` : formatTokens(res.tokens ?? 0);
            try {
                if (ctx.hasUI) {
                    ctx.ui.setStatus(STATUS_KEY, `KV: ${label} (S${res.slotId}) ⚡`);
                    ctx.ui.notify(`Restored KV cache to slot ${res.slotId}: ${(res.tokens ?? 0).toLocaleString()} tokens in ${(res.durationMs || 0).toFixed(1)}ms (⚡ instant resume)`, "info");
                }
            }
            catch {
                // UI unavailable
            }
        }
        else if (res.hit) {
            try {
                if (ctx.hasUI) {
                    ctx.ui.setStatus(STATUS_KEY, `KV: Warm (S${res.slotId}) ⚡`);
                }
            }
            catch {
                // UI unavailable
            }
        }
        return res.slotId;
    };
    // Hook 0: Bind outgoing provider requests directly to the allocated slot (STRICTLY for llama-server)
    pi.on("before_provider_request", async (event, ctx) => {
        if (!isLlamaServerContext(ctx, config)) {
            if (event.payload && typeof event.payload === "object") {
                delete event.payload.id_slot;
            }
            return;
        }
        const payload = event.payload;
        const systemPrompt = (payload?.messages && payload.messages[0]?.role === "system" ? payload.messages[0].content : undefined) ??
            (typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : undefined);
        const tools = payload?.tools;
        const slotId = await activateSessionSlot(ctx, systemPrompt, tools);
        if (event.payload && typeof event.payload === "object") {
            event.payload.id_slot = slotId;
        }
    });
    // Hook 1: Session Start (Cold boot or resume)
    pi.on("session_start", async (_event, ctx) => {
        if (!isLlamaServerContext(ctx, config)) {
            try {
                ctx.ui.setStatus(STATUS_KEY, undefined);
            }
            catch { }
            return;
        }
        try {
            await activateSessionSlot(ctx);
        }
        catch (err) {
            console.warn(`[pi-kv-cache-manager] Error in session_start handler:`, err);
        }
    });
    // Hook 1.5: Before Agent Start (Persistent RPC & subsequent turns slot verification)
    pi.on("before_agent_start", async (_event, ctx) => {
        if (!isLlamaServerContext(ctx, config)) {
            try {
                ctx.ui.setStatus(STATUS_KEY, undefined);
            }
            catch { }
            return;
        }
        try {
            await activateSessionSlot(ctx);
        }
        catch (err) {
            console.warn(`[pi-kv-cache-manager] Error in before_agent_start handler:`, err);
        }
    });
    // Hook 2: Turn End (Incremental lazy checkpointing)
    pi.on("turn_end", async (_event, ctx) => {
        if (!isLlamaServerContext(ctx, config)) {
            return;
        }
        try {
            const sessionId = ctx.sessionManager?.getSessionId();
            if (!sessionId)
                return;
            const slotId = sessionSlots.get(sessionId) ?? config.slotId;
            const usage = ctx.getContextUsage?.();
            const currentTokens = usage?.tokens || 0;
            const sessionName = ctx.sessionManager?.getSessionName?.();
            await engine.maybeCheckpoint(sessionId, sessionName, currentTokens, slotId, (info) => {
                try {
                    if (ctx.hasUI) {
                        ctx.ui.setStatus(STATUS_KEY, `KV: ${formatTokens(info.tokens)} (S${slotId}) 💾`);
                    }
                }
                catch {
                    // Ignore stale context if print mode or session exited
                }
            }, (err) => {
                if (!String(err).includes("stale after session")) {
                    console.warn(`[pi-kv-cache-manager] Incremental save error:`, err);
                }
            });
        }
        catch (err) {
            console.warn(`[pi-kv-cache-manager] Error in turn_end handler:`, err);
        }
    });
    // Hook 2.5: Model Select (Hide/show KV indicator dynamically when switching models)
    pi.on("model_select", async (_event, ctx) => {
        if (!isLlamaServerContext(ctx, config)) {
            try {
                ctx.ui.setStatus(STATUS_KEY, undefined);
            }
            catch { }
        }
        else {
            try {
                await activateSessionSlot(ctx);
            }
            catch (err) {
                console.warn(`[pi-kv-cache-manager] Error in model_select slot activation:`, err);
            }
        }
    });
    // Hook 3: Session Shutdown (Cleanup UI status and slot session tracking)
    pi.on("session_shutdown", async (_event, ctx) => {
        try {
            const sessionId = ctx.sessionManager?.getSessionId();
            if (sessionId) {
                slotManager.clearSession(sessionId);
                sessionSlots.delete(sessionId);
            }
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
                    const currentSlot = sessionSlots.get(sessionId) ?? config.slotId;
                    const lastSavedTokens = engine.getSavedTokens(sessionId);
                    const lines = [
                        "### ⚡ Pi KV Cache Manager Status",
                        "",
                        `- **Llama Server**: \`${config.llamaServerUrl}\` (Active Slot: \`${currentSlot}\`)`,
                        `- **Cache Storage Root**: \`${config.cacheDir}\``,
                        `- **Disk Usage**: **${LruManager.formatBytes(totalBytes)}** / ${config.maxDiskUsageGb} GB (${snapshots.length} total snapshots)`,
                        `- **Session Snapshots**: ${sessionSnaps.length} / ${config.maxSessions} max`,
                        `- **LRU Evictions Performed**: ${lru.getEvictionsCount()}`,
                        `- **Active Session Tokens**: ${activeTokens.toLocaleString()} (Saved: ${lastSavedTokens.toLocaleString()}, Delta: ${(activeTokens - lastSavedTokens).toLocaleString()})`,
                        `- **Incremental Auto-save**: ${config.enableIncrementalSave ? `Enabled (every ${config.stepTokensIncrement.toLocaleString()} tok, min ${config.minTokensThreshold.toLocaleString()})` : "Disabled"}`,
                        `- **Golden Base Cache**: ${baseSnap ? `✅ ${baseSnap.meta.tokenCount.toLocaleString()} tokens (${LruManager.formatBytes(baseSnap.meta.fileSizeBytes)})` : "❌ None"}`,
                        "",
                    ];
                    try {
                        const liveSlots = await fetchSlots(config.llamaServerUrl);
                        lines.push("#### Live Server Slots:");
                        lines.push("| Slot ID | Status | Active Snapshot | Last Used |");
                        lines.push("| :---: | :---: | :--- | :---: |");
                        for (const ls of liveSlots) {
                            const status = ls.is_processing ? "🔄 Busy" : "💤 Idle";
                            const snap = ls.snapshot_filename || "(empty)";
                            const lu = ls.t_last_used && ls.t_last_used > 0 ? new Date(ls.t_last_used / 1000).toLocaleTimeString() : "-";
                            lines.push(`| ${ls.id} | ${status} | \`${snap}\` | ${lu} |`);
                        }
                        lines.push("");
                    }
                    catch {
                        // Live slots fetch is best-effort
                    }
                    if (sessionSnaps.length > 0) {
                        lines.push("#### Stored Sessions:");
                        lines.push("| Session ID / Name | Tokens | Disk Size | Last Accessed |");
                        lines.push("| :--- | :---: | :---: | :---: |");
                        for (const s of sessionSnaps) {
                            const label = s.meta.sessionName ? `${s.meta.sessionName} (\`${s.meta.sessionId.slice(0, 8)}\`)` : `\`${s.meta.sessionId.slice(0, 8)}...\``;
                            lines.push(`| ${label} | ${s.meta.tokenCount.toLocaleString()} | ${LruManager.formatBytes(s.meta.fileSizeBytes)} | ${new Date(s.meta.lastAccessedAt).toLocaleString()} |`);
                        }
                    }
                    notifyUser(ctx, lines.join("\n"), "info");
                    break;
                }
                case "save": {
                    const curModel = ctx.model;
                    if (!isLlamaServerContext(ctx, config)) {
                        notifyUser(ctx, `⚠️ Current model (${curModel?.name || curModel?.id || "cloud"}) is not using local llama-server. KV slot snapshot is only available for local llama models.`, "warning");
                        break;
                    }
                    const customName = args[1];
                    const sessionId = ctx.sessionManager?.getSessionId() || "manual";
                    const slotId = sessionSlots.get(sessionId) ?? config.slotId;
                    const filename = customName
                        ? `snap_${sanitizeFilename(customName)}.bin`
                        : engine.getSnapshotFilename(sessionId);
                    try {
                        notifyUser(ctx, `Saving KV snapshot (Slot ${slotId}) to \`${filename}\`...`, "info");
                        const resp = await saveSlot(config.llamaServerUrl, slotId, filename);
                        const tokens = resp.n_saved ?? resp.n_tokens ?? 0;
                        const bytes = resp.n_written ?? resp.n_bytes ?? 0;
                        const saveMs = resp.timings?.save_ms ?? resp.t_ms ?? 0;
                        engine.setSavedTokens(sessionId, tokens);
                        const metaPath = path.join(config.cacheDir, filename.replace(/\.bin$/, ".meta.json"));
                        await lru.writeMetadata(metaPath, {
                            sessionId,
                            sessionName: customName || ctx.sessionManager?.getSessionName?.(),
                            tokenCount: tokens,
                            fileSizeBytes: bytes,
                            createdAt: new Date().toISOString(),
                            lastAccessedAt: new Date().toISOString(),
                            promptPrefixHash: "",
                            isBaseSnapshot: false,
                        });
                        await lru.enforceLRU(config);
                        try {
                            ctx.ui.setStatus(STATUS_KEY, `KV: ${formatTokens(tokens)} (S${slotId}) 💾`);
                        }
                        catch { }
                        notifyUser(ctx, `✅ Successfully saved ${tokens.toLocaleString()} tokens (${LruManager.formatBytes(bytes)}) in ${saveMs.toFixed(1)}ms`, "info");
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        notifyUser(ctx, `❌ Failed to save snapshot: ${msg}`, "error");
                    }
                    break;
                }
                case "restore": {
                    const curModel = ctx.model;
                    if (!isLlamaServerContext(ctx, config)) {
                        notifyUser(ctx, `⚠️ Current model (${curModel?.name || curModel?.id || "cloud"}) is not using local llama-server. KV slot restore is only available for local llama models.`, "warning");
                        break;
                    }
                    const customName = args[1];
                    const sessionId = ctx.sessionManager?.getSessionId() || "manual";
                    const slotId = sessionSlots.get(sessionId) ?? config.slotId;
                    const filename = customName
                        ? (customName.endsWith(".bin") ? customName : `snap_${sanitizeFilename(customName)}.bin`)
                        : engine.getSnapshotFilename(sessionId);
                    try {
                        notifyUser(ctx, `Restoring KV snapshot (Slot ${slotId}) from \`${filename}\`...`, "info");
                        const resp = await restoreSlot(config.llamaServerUrl, slotId, filename);
                        await lru.touchSnapshot(filename);
                        const tokens = resp.n_restored ?? resp.n_tokens ?? 0;
                        const restoreMs = resp.timings?.restore_ms ?? resp.t_ms ?? 0;
                        engine.setSavedTokens(sessionId, tokens);
                        try {
                            ctx.ui.setStatus(STATUS_KEY, `KV: ${formatTokens(tokens)} (S${slotId}) ⚡`);
                        }
                        catch { }
                        notifyUser(ctx, `✅ Successfully restored ${tokens.toLocaleString()} tokens in ${restoreMs.toFixed(1)}ms`, "info");
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        notifyUser(ctx, `❌ Failed to restore snapshot: ${msg}`, "error");
                    }
                    break;
                }
                case "prune": {
                    try {
                        const result = await lru.enforceLRU(config);
                        if (result.prunedFiles.length > 0) {
                            notifyUser(ctx, `🧹 Evicted ${result.prunedFiles.length} snapshot(s) (${LruManager.formatBytes(result.freedBytes)} freed):\n${result.prunedFiles.join(", ")}`, "info");
                        }
                        else {
                            notifyUser(ctx, `LRU cache is already within quota limits. Nothing to evict.`, "info");
                        }
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        notifyUser(ctx, `❌ Prune failed: ${msg}`, "error");
                    }
                    break;
                }
                case "base-update": {
                    if (!isLlamaServerContext(ctx, config)) {
                        notifyUser(ctx, `⚠️ Base cache update is only available for local llama-server models.`, "warning");
                        break;
                    }
                    if (typeof ctx.getSystemPrompt !== "function") {
                        notifyUser(ctx, "System prompt unavailable in this context.", "warning");
                        return;
                    }
                    const prompt = ctx.getSystemPrompt();
                    const tools = await baseCache.loadCachedTools();
                    const hash = computeHash(prompt, tools);
                    try {
                        notifyUser(ctx, "Prefilling system prompt and tools into an available slot...", "info");
                        const info = await baseCache.warmAndSave(prompt, hash, undefined, tools);
                        try {
                            ctx.ui.setStatus(STATUS_KEY, `KV: Base ${formatTokens(info.tokens)} (S${info.slotId}) 💾`);
                        }
                        catch { }
                        notifyUser(ctx, `✅ Golden Base cache refreshed: ${info.tokens.toLocaleString()} tokens (${LruManager.formatBytes(info.bytes)}) saved into Slot ${info.slotId} in ${info.durationMs.toFixed(1)}ms`, "info");
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        notifyUser(ctx, `❌ Base update failed: ${msg}`, "error");
                    }
                    break;
                }
                case "help":
                default: {
                    notifyUser(ctx, `**Pi KV Cache Manager Commands**:\n` +
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