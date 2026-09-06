import * as crypto from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { saveSlot, restoreSlot, eraseSlot, fetchSlots } from "./checkpoint-engine.js";
export const BASE_SNAPSHOT_BIN = "base_system_prompt.bin";
export const BASE_SNAPSHOT_META = "base_system_prompt.meta.json";
export function computeHash(content) {
    return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}
export class BaseCacheManager {
    config;
    lru;
    constructor(config, lru) {
        this.config = config;
        this.lru = lru;
    }
    getMetaPath() {
        return path.join(this.config.cacheDir, BASE_SNAPSHOT_META);
    }
    getBinPath() {
        return path.join(this.config.cacheDir, BASE_SNAPSHOT_BIN);
    }
    async getBaseMetadata() {
        return this.lru.readMetadata(this.getMetaPath());
    }
    /**
     * Checks whether the current system prompt matches the cached golden base snapshot.
     * If matched, restores it instantly into the slot (~20ms).
     */
    async checkAndRestore(systemPrompt, slotId = this.config.slotId) {
        if (!this.config.enableBaseCache) {
            return { status: "disabled", hash: "" };
        }
        const currentHash = computeHash(systemPrompt);
        const meta = await this.getBaseMetadata();
        if (!meta || meta.promptPrefixHash !== currentHash) {
            return { status: "miss", hash: currentHash };
        }
        // Verify bin file exists
        try {
            await fs.access(this.getBinPath());
        }
        catch {
            return { status: "miss", hash: currentHash };
        }
        try {
            const resp = await restoreSlot(this.config.llamaServerUrl, slotId, BASE_SNAPSHOT_BIN);
            await this.lru.touchSnapshot(BASE_SNAPSHOT_BIN);
            return {
                status: "hit",
                hash: currentHash,
                tokens: resp.n_restored ?? resp.n_tokens ?? meta.tokenCount,
                durationMs: resp.timings?.restore_ms ?? resp.t_ms ?? 0,
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { status: "error", hash: currentHash, error: msg };
        }
    }
    /**
     * Warms the base prompt by sending an evaluation request with n_predict=0,
     * then snapshots the resulting KV cache to disk as base_system_prompt.bin.
     * Dynamically selects an idle slot (or uses preferredSlotId), formats with /apply-template,
     * and cleanly erases the slot before prefilling.
     */
    async warmAndSave(systemPrompt, hash, preferredSlotId) {
        const baseUrl = this.config.llamaServerUrl.replace(/\/+$/, "");
        // 1. Determine target slot dynamically (prefer idle slot)
        let targetSlot = preferredSlotId;
        if (targetSlot === undefined) {
            try {
                const slots = await fetchSlots(this.config.llamaServerUrl);
                const idleSlot = slots.find((s) => !s.is_processing);
                targetSlot = idleSlot ? idleSlot.id : this.config.slotId;
            }
            catch {
                targetSlot = this.config.slotId;
            }
        }
        // 2. Format prompt via /apply-template if available to ensure chat template token consistency
        let formattedPrompt = systemPrompt;
        try {
            const templateRes = await fetch(`${baseUrl}/apply-template`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    messages: [{ role: "system", content: systemPrompt }],
                }),
            });
            if (templateRes.ok) {
                const data = (await templateRes.json());
                if (data.prompt) {
                    formattedPrompt = data.prompt;
                }
            }
        }
        catch {
            // Fallback to raw systemPrompt if /apply-template is unavailable
        }
        // 3. Erase target slot first to guarantee a pure, clean prefill (no leftover tokens)
        try {
            await eraseSlot(this.config.llamaServerUrl, targetSlot);
        }
        catch {
            // Ignore if slot was already clean
        }
        // 4. Evaluate formatted prompt with n_predict = 0 to fill slot KV cache
        const completionUrl = `${baseUrl}/completion`;
        const evalRes = await fetch(completionUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                prompt: formattedPrompt,
                n_predict: 0,
                id_slot: targetSlot,
                cache_prompt: true,
            }),
        });
        if (!evalRes.ok) {
            const text = await evalRes.text();
            throw new Error(`Failed to warm base prompt on llama-server: ${text}`);
        }
        // 5. Snapshot the prefilled slot to base_system_prompt.bin
        const saveResp = await saveSlot(this.config.llamaServerUrl, targetSlot, BASE_SNAPSHOT_BIN);
        const now = new Date().toISOString();
        const savedTokens = saveResp.n_saved ?? saveResp.n_tokens ?? 0;
        const savedBytes = saveResp.n_written ?? saveResp.n_bytes ?? 0;
        const durationMs = saveResp.timings?.save_ms ?? saveResp.t_ms ?? 0;
        const meta = {
            sessionId: "base_system_prompt",
            sessionName: "Golden Base (System Prompt + Skills)",
            tokenCount: savedTokens,
            fileSizeBytes: savedBytes,
            createdAt: now,
            lastAccessedAt: now,
            promptPrefixHash: hash,
            isBaseSnapshot: true,
        };
        await this.lru.writeMetadata(this.getMetaPath(), meta);
        return {
            tokens: savedTokens,
            durationMs,
            bytes: savedBytes,
            slotId: targetSlot,
        };
    }
}
//# sourceMappingURL=base-cache.js.map