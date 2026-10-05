import * as path from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "./config.js";
import { cachedRuntimeResolver, RuntimeQueue } from "./runtime.js";
import { LruManager } from "./lru-manager.js";
import { CheckpointEngine, saveSlot, restoreSlot, fetchSlots } from "./checkpoint-engine.js";
import { BaseCacheManager, computeHash, stableStringify } from "./base-cache.js";
import { SlotManager } from "./slot-manager.js";
import { boundedFetch, checkCancelled } from "./request.js";
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
            // Eligibility only. Actual listener ownership is verified before any slot API call.
            if (["127.0.0.1", "[::1]", "localhost"].includes(modelUrl.hostname))
                return true;
        }
        catch {
            // Ignore URL parse error
        }
    }
    return false;
}
// Request fields llama-server applies only after the chat template is rendered
// (sampling / length limits / response shaping). They never change the prompt
// tokens a snapshot holds, so they must not split the snapshot namespace:
// otherwise every thinking level re-warms its own copy of the same system prefix.
// Unknown fields still count, so anything that could reach the template stays safe.
const NON_PREFIX_OPTIONS = new Set([
    "max_tokens", "max_completion_tokens", "n_predict", "thinking_budget_tokens", "reasoning_budget_tokens",
    "temperature", "top_p", "top_k", "min_p", "typical_p", "seed", "presence_penalty", "frequency_penalty",
    "repeat_penalty", "repeat_last_n", "logit_bias", "logprobs", "top_logprobs", "n_probs", "stop",
    "store", "user", "metadata", "cache_prompt", "timings_per_token", "return_progress",
]);
export function prefixOptions(options) {
    return Object.fromEntries(Object.entries(options).filter(([key]) => !NON_PREFIX_OPTIONS.has(key)));
}
const renderedPrefixes = new Map();
/** Hash of the system prefix as llama-server's chat template renders it, or undefined. */
async function renderedPrefixKey(serverUrl, transport, prompt, tools, options, runtimeKey, signal) {
    const key = computeHash(stableStringify({ serverUrl, runtimeKey, prompt, tools, options }));
    const cached = renderedPrefixes.get(key);
    if (cached)
        return cached;
    try {
        const response = await boundedFetch(`${serverUrl.replace(/\/$/, "")}/apply-template`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages: [{ role: "system", content: prompt }], ...options,
                ...(tools.length ? { tools } : {}), add_generation_prompt: false }),
        }, { signal, transport });
        if (!response.ok)
            return undefined;
        const data = await response.json();
        if (typeof data.prompt !== "string" || !data.prompt)
            return undefined;
        const rendered = computeHash(`rendered:${data.prompt}`);
        if (renderedPrefixes.size >= 64)
            renderedPrefixes.delete(renderedPrefixes.keys().next().value);
        renderedPrefixes.set(key, rendered);
        return rendered;
    }
    catch (error) {
        signal.throwIfAborted();
        return undefined;
    }
}
export default function piKvCacheManager(pi, dependencies = {}) {
    const discover = dependencies.resolve ?? cachedRuntimeResolver();
    const readConfig = dependencies.loadConfig ?? loadConfig;
    let config = DEFAULT_CONFIG;
    let lru;
    let engine;
    let baseCache;
    let slotManager;
    let runtimeKey = "";
    let ready = false;
    let selectedModel = "";
    let lastPrefix;
    let lastCheckpointLeafKey;
    let extensionsFingerprint;
    let extensionLoadedAt = Date.now();
    const queue = new RuntimeQueue();
    let lifetime = new AbortController();
    let activeContext = "";
    const guardContext = (ctx, signal) => new Proxy(ctx, {
        get(target, key) {
            if (key !== "ui")
                return Reflect.get(target, key);
            return new Proxy(target.ui, { get(ui, method) {
                    const value = Reflect.get(ui, method);
                    return typeof value === "function" ? (...args) => {
                        if (!signal.aborted)
                            return value.apply(ui, args);
                    } : value;
                } });
        },
    });
    const on = (name, handler) => pi.on(name, (event, ctx) => {
        const contextKey = stableStringify([ctx.model, ctx.sessionManager?.getSessionId()]);
        if (["model_select", "session_start", "session_switch", "session_shutdown"].includes(name) ||
            (name === "before_provider_request" && (lifetime.signal.aborted || (activeContext && activeContext !== contextKey)))) {
            lifetime.abort(new DOMException("KV lifecycle changed", "AbortError"));
            lifetime = new AbortController();
            invalidate();
        }
        activeContext = contextKey;
        const signal = lifetime.signal;
        return queue.run(async () => {
            if (signal.aborted)
                return;
            try {
                return await handler(event, guardContext(ctx, signal));
            }
            catch (error) {
                if (!signal.aborted)
                    throw error;
            }
        });
    });
    const sessionSlots = new Map();
    const modelKey = (ctx) => stableStringify(ctx.model);
    const invalidate = () => { ready = false; runtimeKey = ""; sessionSlots.clear(); lastPrefix = undefined; lastCheckpointLeafKey = undefined; };
    const refresh = async (ctx, payload) => {
        const controller = lifetime;
        const signal = controller.signal;
        try {
            signal.throwIfAborted();
            const settings = readConfig(typeof ctx.isProjectTrusted === "function" && !ctx.isProjectTrusted() ? undefined : ctx.cwd);
            if (!isLlamaServerContext(ctx, settings))
                throw new Error("Not a llama-server model");
            const model = ctx.model;
            if (!model.baseUrl)
                throw new Error("Selected model endpoint unavailable");
            const resolved = await discover(model.baseUrl, { signal });
            signal.throwIfAborted();
            const messages = payload.messages;
            if (!Array.isArray(messages) || messages[0]?.role !== "system" || typeof messages[0]?.content !== "string" ||
                messages.slice(1).some((m) => m.role === "system" || m.role === "developer")) {
                throw new Error("A single serialized system prefix is required");
            }
            if (Object.keys(payload).some(key => /lora|adapter/i.test(key))) {
                throw new Error("Per-request adapter overrides are not supported for persistent reuse");
            }
            const tools = payload.tools ?? [];
            if (!Array.isArray(tools))
                throw new Error("Unsupported tool payload");
            const { messages: _messages, tools: _tools, id_slot: _slot, stream: _stream, stream_options: _streamOptions, ...options } = payload;
            // A snapshot holds the RENDERED system prefix, so it is keyed by the rendered
            // text: request options that do not change it (thinking on/off, budgets,
            // sampling) keep the same namespace and the session's live slot. Falls back to
            // hashing the options when the server cannot render.
            const prefix = await renderedPrefixKey(resolved.serverUrl, resolved.transport, messages[0].content, tools, options, `${resolved.identity}:${resolved.generation}`, signal)
                ?? computeHash(stableStringify({ prompt: messages[0].content, tools, options: prefixOptions(options) }));
            const snapshotPrefix = `kv2_${computeHash(resolved.identity + prefix)}_`;
            const key = stableStringify({ resolved, settings, snapshotPrefix });
            if (!ready || key !== runtimeKey) {
                invalidate();
                const assertCurrent = async () => {
                    signal.throwIfAborted();
                    const now = await discover(model.baseUrl, { signal });
                    signal.throwIfAborted();
                    if (stableStringify(now) !== stableStringify(resolved))
                        throw new Error("KV runtime changed; skip stale work");
                };
                config = { ...settings, llamaServerUrl: resolved.serverUrl, cacheDir: resolved.cacheDir,
                    goldenPrefix: `golden_${computeHash(resolved.identity)}_`, goldenCwd: ctx.cwd,
                    renderedPrefixHash: prefix, extensionsFingerprint, extensionLoadedAt,
                    runtimeIdentity: resolved.identity, snapshotPrefix, templateOptions: options, assertCurrent,
                    signal, abortRuntime: reason => controller.abort(reason), transport: resolved.transport };
                lru = new LruManager(config.cacheDir, snapshotPrefix, signal);
                engine = new CheckpointEngine(config, lru);
                baseCache = new BaseCacheManager(config, lru);
                slotManager = new SlotManager(config, lru, engine, baseCache);
                runtimeKey = key;
                ready = true;
            }
            selectedModel = modelKey(ctx);
            lastPrefix = { prompt: messages[0].content, tools };
            return true;
        }
        catch (error) {
            invalidate();
            try {
                ctx.ui.setStatus(STATUS_KEY, "KV: persistent reuse disabled (unverified runtime)");
            }
            catch { }
            console.warn(`[pi-kv-cache-manager] Persistent reuse disabled: ${String(error)}`);
            return false;
        }
    };
    const verifyActive = async (ctx) => {
        if (!ready || selectedModel !== modelKey(ctx) || !isLlamaServerContext(ctx, config))
            return false;
        try {
            await config.assertCurrent?.();
            return true;
        }
        catch {
            invalidate();
            return false;
        }
    };
    const activateSessionSlot = async (ctx, systemPromptOverride, toolsOverride) => {
        const sessionId = ctx.sessionManager?.getSessionId();
        if (!sessionId)
            return config.slotId;
        const systemPrompt = systemPromptOverride ??
            (typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : undefined);
        const tools = toolsOverride;
        const res = await slotManager.ensureSlotForSession(sessionId, systemPrompt, tools);
        config.signal?.throwIfAborted();
        sessionSlots.set(sessionId, res.slotId);
        if (res.restored) {
            const partial = res.isBase && res.exactBase === false;
            const label = partial ? "Golden candidate" : res.isBase ? `Base ${formatTokens(res.tokens ?? 0)}` : formatTokens(res.tokens ?? 0);
            try {
                if (ctx.hasUI) {
                    ctx.ui.setStatus(STATUS_KEY, `KV: ${label} (S${res.slotId}) ⚡`);
                    ctx.ui.notify(partial ? `Golden candidate loaded into slot ${res.slotId}; llama-server will validate the common token prefix. Snapshot token count is not a cache-hit measurement.` :
                        `Restored KV cache to slot ${res.slotId}: ${(res.tokens ?? 0).toLocaleString()} tokens in ${(res.durationMs || 0).toFixed(1)}ms`, "info");
                }
            }
            catch {
                // UI unavailable
            }
        }
        else if (res.warmed) {
            try {
                if (ctx.hasUI)
                    ctx.ui.setStatus(STATUS_KEY, `KV: Base ${formatTokens(res.tokens ?? 0)} (S${res.slotId}) warmed 💾`);
            }
            catch { }
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
    on("before_provider_request", async (event, ctx) => {
        if (!isLlamaServerContext(ctx, config)) {
            invalidate();
            if (event.payload && typeof event.payload === "object") {
                delete event.payload.id_slot;
            }
            return;
        }
        const payload = event.payload;
        const systemPrompt = (payload?.messages && payload.messages[0]?.role === "system" ? payload.messages[0].content : undefined) ??
            (typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : undefined);
        const tools = payload?.tools;
        if (!payload || typeof payload !== "object")
            return;
        const request = payload;
        request.chat_template_kwargs = { ...(request.chat_template_kwargs ?? {}), preserve_thinking: true };
        if (!await refresh(ctx, request)) {
            delete request.id_slot;
            return;
        }
        let slotId;
        try {
            try {
                await baseCache.ensureGolden(systemPrompt, tools ?? []);
            }
            catch (error) {
                checkCancelled(config, error);
                console.warn(`[pi-kv-cache-manager] Golden update deferred (previous golden preserved): ${String(error)}`);
            }
            slotId = await activateSessionSlot(ctx, systemPrompt, tools ?? []);
            await config.assertCurrent?.();
        }
        catch {
            invalidate();
            delete request.id_slot;
            return;
        }
        if (event.payload && typeof event.payload === "object") {
            event.payload.id_slot = slotId;
            // Names the snapshot this context belongs to: before llama-server lets another
            // context replace the slot, it saves any state this file does not have yet (e.g.
            // turns that ended in tool calls, which skip the save below).
            const sessionId = ctx.sessionManager?.getSessionId();
            if (sessionId)
                event.payload.slot_snapshot = engine.getSnapshotFilename(sessionId);
            // Ensure preserve_thinking is set so subsequent turns retain assistant thinking blocks in KV cache!
            const currentKwargs = event.payload.chat_template_kwargs || {};
            event.payload.chat_template_kwargs = {
                ...currentKwargs,
                preserve_thinking: true,
            };
        }
    });
    // Hook 1: Session Start (Cold boot or resume)
    on("session_start", async (event, ctx) => {
        extensionsFingerprint = event.extensionsFingerprint;
        extensionLoadedAt = Math.max(Date.now(), extensionLoadedAt + 1);
        invalidate();
        try {
            ctx.ui.setStatus(STATUS_KEY, undefined);
        }
        catch { }
    });
    on("extensions_changed", async (event) => {
        extensionsFingerprint = event.current;
        // Rebuild only after serialization supplies all before_agent_start changes and tools.
        invalidate();
    });
    on("session_switch", async () => { invalidate(); });
    // Hook 1.5: Before Agent Start (Persistent RPC & subsequent turns slot verification)
    // Activation deliberately waits for before_provider_request: earlier hooks lack serialized tools.
    // Hook 2: Turn End (Incremental lazy checkpointing)
    const checkpoint = async (ctx) => {
        if (!await verifyActive(ctx)) {
            return;
        }
        try {
            const sessionId = ctx.sessionManager?.getSessionId();
            if (!sessionId)
                return;
            const slotId = sessionSlots.get(sessionId);
            if (slotId === undefined)
                return;
            // Final turn_end and agent_end see the same persisted message leaf. With
            // stepTokensIncrement=0 they otherwise write the same large snapshot twice.
            // Token estimates alone are not a content identity; changed leaves still save.
            const leafId = ctx.sessionManager?.getLeafId?.();
            const leafKey = leafId ? stableStringify([sessionId, slotId, leafId]) : undefined;
            if (leafKey && leafKey === lastCheckpointLeafKey)
                return;
            const usage = ctx.getContextUsage?.();
            const currentTokens = usage?.tokens || 0;
            const sessionName = ctx.sessionManager?.getSessionName?.();
            await engine.maybeCheckpoint(sessionId, sessionName, currentTokens, slotId, (info) => {
                // Mark only successful saves, so agent_end can retry a failed turn_end.
                lastCheckpointLeafKey = leafKey;
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
    };
    // A turn that ended in tool calls is followed at once by the next request, so
    // saving there sat on the critical path (and queued behind any prefill of the
    // tool result on the same slot). Those turns save when the run ends instead.
    on("turn_end", async (event, ctx) => {
        if (Array.isArray(event?.toolResults) && event.toolResults.length > 0)
            return;
        await checkpoint(ctx);
    });
    on("agent_end", async (_event, ctx) => { await checkpoint(ctx); });
    // Hook 2.5: Model Select (Hide/show KV indicator dynamically when switching models)
    on("model_select", async (_event, ctx) => {
        invalidate();
        try {
            ctx.ui.setStatus(STATUS_KEY, undefined);
        }
        catch { }
    });
    // Hook 3: Session Shutdown (Cleanup UI status and slot session tracking)
    on("session_shutdown", async (_event, ctx) => {
        try {
            const sessionId = ctx.sessionManager?.getSessionId();
            if (sessionId) {
                slotManager?.clearSession(sessionId);
                sessionSlots.delete(sessionId);
            }
            ctx.ui.setStatus(STATUS_KEY, undefined);
        }
        catch {
            // Ignored
        }
        invalidate();
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
        handler: (rawArgs, ctx) => {
            const signal = lifetime.signal;
            ctx = guardContext(ctx, signal);
            return queue.run(async () => {
                if (signal.aborted)
                    return;
                const args = rawArgs.trim().split(/\s+/).filter(Boolean);
                const sub = (args[0] || "status").toLowerCase();
                if (sub !== "help" && !await verifyActive(ctx)) {
                    notifyUser(ctx, "Persistent KV unavailable: send a request to a verified local llama-server first. No files changed.", "warning");
                    return;
                }
                switch (sub) {
                    case "status": {
                        const snapshots = await lru.listSnapshots();
                        const allSnapshots = await lru.listSnapshots(true);
                        const totalGlobalBytes = allSnapshots.reduce((acc, s) => acc + s.meta.fileSizeBytes, 0);
                        const baseMeta = await baseCache.getBaseMetadata();
                        const baseSnap = allSnapshots.find((s) => s.binFilename === baseCache.getFilename());
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
                            `- **Disk Usage**: **${LruManager.formatBytes(totalGlobalBytes)}** / ${config.maxDiskUsageGb} GB (${allSnapshots.length} total snapshots in cache directory)`,
                            `- **Active Namespace Snapshots**: ${sessionSnaps.length} / ${config.maxSessions} max sessions (${snapshots.length} total)`,
                            `- **LRU Evictions Performed**: ${lru.getEvictionsCount()}`,
                            `- **Active Session Tokens**: ${activeTokens.toLocaleString()} (Saved: ${lastSavedTokens.toLocaleString()}, Delta: ${(activeTokens - lastSavedTokens).toLocaleString()})`,
                            `- **Incremental Auto-save**: ${config.enableIncrementalSave ? `Enabled (every ${config.stepTokensIncrement.toLocaleString()} tok, min ${config.minTokensThreshold.toLocaleString()})` : "Disabled"}`,
                            `- **Golden Base Cache**: ${baseSnap ? `✅ ${baseSnap.meta.tokenCount.toLocaleString()} tokens (${LruManager.formatBytes(baseSnap.meta.fileSizeBytes)})` : "❌ None"}`,
                            `- **Canonical Golden**: \`${baseCache.getFilename()}\` (cwd: \`${baseMeta?.canonicalCwd ?? "unset"}\`)`,
                            `- **Golden Warnings**: \`${path.join(config.cacheDir, "golden-warnings.jsonl")}\``,
                            `- **Loaded Extensions**: \`${extensionsFingerprint ?? "unavailable; reload updated pi core"}\``,
                            `- **Golden Extensions**: \`${baseMeta?.extensionsFingerprint ?? "unset"}\``,
                            `- **Pending Golden Update**: ${extensionsFingerprint && baseMeta?.extensionsFingerprint !== extensionsFingerprint ? "yes (next serialized request in canonical cwd)" : "no"}`,
                            "",
                        ];
                        try {
                            const liveSlots = await fetchSlots(config.llamaServerUrl, config);
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
                            ? engine.getSnapshotFilename(customName)
                            : engine.getSnapshotFilename(sessionId);
                        try {
                            notifyUser(ctx, `Saving KV snapshot (Slot ${slotId}) to \`${filename}\`...`, "info");
                            await config.assertCurrent?.();
                            await lru.invalidateSnapshot(filename);
                            const resp = await saveSlot(config.llamaServerUrl, slotId, filename, config);
                            await config.assertCurrent?.();
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
                            ? engine.getSnapshotFilename(customName.replace(/\.bin$/, ""))
                            : engine.getSnapshotFilename(sessionId);
                        try {
                            notifyUser(ctx, `Restoring KV snapshot (Slot ${slotId}) from \`${filename}\`...`, "info");
                            const meta = await lru.readMetadata(path.join(config.cacheDir, filename.replace(/\.bin$/, ".meta.json")));
                            if (!meta)
                                throw new Error("Snapshot is not bound to the current runtime/prefix");
                            await config.assertCurrent?.();
                            const resp = await restoreSlot(config.llamaServerUrl, slotId, filename, config);
                            await config.assertCurrent?.();
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
                        if (!lastPrefix)
                            return;
                        const { prompt, tools } = lastPrefix;
                        try {
                            notifyUser(ctx, "Prefilling system prompt and tools into an available slot...", "info");
                            await baseCache.ensureGolden(prompt, tools, true);
                            const meta = await baseCache.getBaseMetadata();
                            notifyUser(ctx, `Golden Base refreshed: ${meta?.tokenCount.toLocaleString() ?? "unknown"} tokens in ${baseCache.getFilename()}`, "info");
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
            });
        },
    });
}
//# sourceMappingURL=index.js.map