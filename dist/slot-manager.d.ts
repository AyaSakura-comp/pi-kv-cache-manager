import type { KvManagerConfig } from "./types.js";
import { CheckpointEngine } from "./checkpoint-engine.js";
import { LruManager } from "./lru-manager.js";
import { BaseCacheManager } from "./base-cache.js";
export interface SlotResolutionResult {
    slotId: number;
    hit: boolean;
    restored: boolean;
    isBase?: boolean;
    tokens?: number;
    durationMs?: number;
}
export declare class SlotManager {
    private config;
    private lru;
    private engine;
    private baseCache;
    private activeSlotSessions;
    constructor(config: KvManagerConfig, lru: LruManager, engine: CheckpointEngine, baseCache: BaseCacheManager);
    getActiveSlot(sessionId: string): number | undefined;
    clearSession(sessionId: string): void;
    ensureSlotForSession(sessionId: string, systemPrompt?: string, tools?: unknown[]): Promise<SlotResolutionResult>;
}
//# sourceMappingURL=slot-manager.d.ts.map