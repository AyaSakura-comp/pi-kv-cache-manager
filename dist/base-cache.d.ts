import type { KvManagerConfig, SnapshotMetadata } from "./types.js";
import { LruManager } from "./lru-manager.js";
export declare const BASE_SNAPSHOT_BIN = "base_system_prompt.bin";
export declare const BASE_SNAPSHOT_META = "base_system_prompt.meta.json";
export declare function computeHash(content: string): string;
export interface BaseCacheRestoreResult {
    status: "hit" | "miss" | "disabled" | "error";
    hash: string;
    tokens?: number;
    durationMs?: number;
    error?: string;
}
export declare class BaseCacheManager {
    private config;
    private lru;
    constructor(config: KvManagerConfig, lru: LruManager);
    getMetaPath(): string;
    getBinPath(): string;
    getBaseMetadata(): Promise<SnapshotMetadata | null>;
    /**
     * Checks whether the current system prompt matches the cached golden base snapshot.
     * If matched, restores it instantly into the slot (~20ms).
     */
    checkAndRestore(systemPrompt: string, slotId?: number): Promise<BaseCacheRestoreResult>;
    /**
     * Warms the base prompt by sending an evaluation request with n_predict=0,
     * then snapshots the resulting KV cache to disk as base_system_prompt.bin.
     * Dynamically selects an idle slot (or uses preferredSlotId), formats with /apply-template,
     * and cleanly erases the slot before prefilling.
     */
    warmAndSave(systemPrompt: string, hash: string, preferredSlotId?: number): Promise<{
        tokens: number;
        durationMs: number;
        bytes: number;
        slotId: number;
    }>;
}
//# sourceMappingURL=base-cache.d.ts.map