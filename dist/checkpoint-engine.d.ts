import type { KvManagerConfig, LlamaSlotActionResponse } from "./types.js";
import { LruManager } from "./lru-manager.js";
export declare function sanitizeFilename(name: string): string;
export declare function saveSlot(baseUrl: string, slotId: number, filename: string): Promise<LlamaSlotActionResponse>;
export declare function restoreSlot(baseUrl: string, slotId: number, filename: string): Promise<LlamaSlotActionResponse>;
export declare function eraseSlot(baseUrl: string, slotId: number): Promise<void>;
export declare class CheckpointEngine {
    private config;
    private lru;
    private sessionSavedTokens;
    private inFlightSaves;
    constructor(config: KvManagerConfig, lru: LruManager);
    getSavedTokens(sessionId: string): number;
    setSavedTokens(sessionId: string, count: number): void;
    isSaving(sessionId: string): boolean;
    getSnapshotFilename(sessionId: string): string;
    /**
     * Evaluates token progress after a turn and executes an asynchronous,
     * non-blocking snapshot save if threshold conditions are met.
     */
    maybeCheckpoint(sessionId: string, sessionName: string | undefined, currentTokens: number, onSuccess?: (info: {
        tokens: number;
        durationMs: number;
        bytes: number;
    }) => void, onError?: (error: Error) => void): Promise<boolean>;
}
//# sourceMappingURL=checkpoint-engine.d.ts.map