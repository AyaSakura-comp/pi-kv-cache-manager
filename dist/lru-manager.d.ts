import type { KvManagerConfig, SnapshotMetadata } from "./types.js";
export interface SnapshotItem {
    meta: SnapshotMetadata;
    binFilename: string;
    binPath: string;
    metaPath: string;
}
export declare class LruManager {
    private cacheDir;
    private evictionsCount;
    constructor(cacheDir: string);
    getEvictionsCount(): number;
    readMetadata(metaPath: string): Promise<SnapshotMetadata | null>;
    writeMetadata(metaPath: string, meta: SnapshotMetadata): Promise<void>;
    touchSnapshot(filename: string): Promise<void>;
    listSnapshots(): Promise<SnapshotItem[]>;
    /**
     * Enforces LRU eviction based on maxSessions and maxDiskUsageGb.
     * Golden base cache (base_system_prompt.bin) is always preserved.
     */
    enforceLRU(config: KvManagerConfig): Promise<{
        prunedFiles: string[];
        freedBytes: number;
    }>;
    static formatBytes(bytes: number): string;
}
//# sourceMappingURL=lru-manager.d.ts.map