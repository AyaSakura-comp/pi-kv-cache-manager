import { type RequestOptions } from "./request.js";
import type { KvManagerConfig, LlamaSlotActionResponse, LlamaSlotInfo } from "./types.js";
import { LruManager } from "./lru-manager.js";
export declare function fetchSlots(baseUrl: string, options?: RequestOptions): Promise<LlamaSlotInfo[]>;
export declare function sanitizeFilename(name: string): string;
export declare function saveSlot(baseUrl: string, slotId: number, filename: string, options?: RequestOptions): Promise<LlamaSlotActionResponse>;
export declare function restoreSlot(baseUrl: string, slotId: number, filename: string, options?: RequestOptions): Promise<LlamaSlotActionResponse>;
export declare function eraseSlot(baseUrl: string, slotId: number, options?: RequestOptions): Promise<void>;
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
     * Evaluates token progress after a turn and awaits a serialized snapshot
     * save if threshold conditions are met. Server disk I/O is synchronous.
     */
    maybeCheckpoint(sessionId: string, sessionName: string | undefined, currentTokens: number, slotId?: number, onSuccess?: (info: {
        tokens: number;
        durationMs: number;
        bytes: number;
    }) => void, onError?: (error: Error) => void): Promise<boolean>;
}
//# sourceMappingURL=checkpoint-engine.d.ts.map