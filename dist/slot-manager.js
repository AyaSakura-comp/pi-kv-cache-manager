import * as path from "node:path";
import * as fs from "node:fs/promises";
import { fetchSlots, restoreSlot, eraseSlot } from "./checkpoint-engine.js";
export class SlotManager {
    config;
    lru;
    engine;
    baseCache;
    constructor(config, lru, engine, baseCache) {
        this.config = config;
        this.lru = lru;
        this.engine = engine;
        this.baseCache = baseCache;
    }
    async ensureSlotForSession(sessionId, systemPrompt) {
        const snapFilename = this.engine.getSnapshotFilename(sessionId);
        let slots = [];
        try {
            slots = await fetchSlots(this.config.llamaServerUrl);
        }
        catch (err) {
            console.warn(`[pi-kv-cache-manager] Failed to fetch slots from ${this.config.llamaServerUrl}, using fallback slot ${this.config.slotId}:`, err);
            slots = [{ id: this.config.slotId, n_ctx: 0, is_processing: false, snapshot_filename: "" }];
        }
        if (slots.length === 0) {
            slots = [{ id: this.config.slotId, n_ctx: 0, is_processing: false, snapshot_filename: "" }];
        }
        // 1. Direct RAM Cache Hit:
        // Does any slot currently have our snapshot_filename loaded?
        const residentSlot = slots.find((s) => s.snapshot_filename === snapFilename);
        if (residentSlot) {
            return {
                slotId: residentSlot.id,
                hit: true,
                restored: false,
            };
        }
        // 2. RAM Cache Miss: Select the best slot to restore into.
        // Prefer idle slots (not currently processing a request)
        const idleSlots = slots.filter((s) => !s.is_processing);
        const candidates = idleSlots.length > 0 ? idleSlots : slots;
        // Selection priority:
        // Priority A: An empty / fresh slot (no snapshot loaded)
        let chosenSlot = candidates.find((s) => !s.snapshot_filename);
        // Priority B: The least recently used slot (smallest t_last_used)
        if (!chosenSlot) {
            chosenSlot = [...candidates].sort((a, b) => (a.t_last_used ?? 0) - (b.t_last_used ?? 0))[0];
        }
        const targetSlotId = chosenSlot ? chosenSlot.id : this.config.slotId;
        // 3. Restore session snapshot from disk if available
        const snapPath = path.join(this.config.cacheDir, snapFilename);
        let snapExists = false;
        try {
            await fs.access(snapPath);
            snapExists = true;
        }
        catch {
            snapExists = false;
        }
        if (snapExists) {
            const resp = await restoreSlot(this.config.llamaServerUrl, targetSlotId, snapFilename);
            await this.lru.touchSnapshot(snapFilename);
            const tokens = resp.n_restored ?? resp.n_tokens ?? 0;
            const durationMs = resp.timings?.restore_ms ?? resp.t_ms ?? 0;
            this.engine.setSavedTokens(sessionId, tokens);
            return {
                slotId: targetSlotId,
                hit: false,
                restored: true,
                tokens,
                durationMs,
            };
        }
        // 4. If new session (no snapshot on disk), check Golden Base Cache
        if (this.config.enableBaseCache && systemPrompt && systemPrompt.length > 0) {
            const baseRes = await this.baseCache.checkAndRestore(systemPrompt, targetSlotId);
            if (baseRes.status === "hit") {
                return {
                    slotId: targetSlotId,
                    hit: false,
                    restored: true,
                    isBase: true,
                    tokens: baseRes.tokens,
                    durationMs: baseRes.durationMs,
                };
            }
            else if (baseRes.status === "miss") {
                // Auto-warm and snapshot Golden Base on miss (system prompt changed or first run)
                try {
                    const warmRes = await this.baseCache.warmAndSave(systemPrompt, baseRes.hash, targetSlotId);
                    return {
                        slotId: targetSlotId,
                        hit: false,
                        restored: true,
                        isBase: true,
                        tokens: warmRes.tokens,
                        durationMs: warmRes.durationMs,
                    };
                }
                catch (err) {
                    console.warn("[pi-kv-cache-manager] Auto-warming base cache failed, falling back to cold start:", err);
                }
            }
        }
        // 5. If no snapshot and no base cache, but target slot had a previous session's snapshot:
        // Erase the slot so stale context does not pollute the new session
        if (chosenSlot && chosenSlot.snapshot_filename) {
            try {
                await eraseSlot(this.config.llamaServerUrl, targetSlotId);
            }
            catch {
                // Best effort
            }
        }
        return {
            slotId: targetSlotId,
            hit: false,
            restored: false,
        };
    }
}
//# sourceMappingURL=slot-manager.js.map