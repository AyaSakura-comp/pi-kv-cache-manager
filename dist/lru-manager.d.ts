import type { KvManagerConfig, SnapshotMetadata } from "./types.js";
export interface SnapshotItem {
    meta: SnapshotMetadata;
    binFilename: string;
    binPath: string;
    metaPath: string;
}
export declare class LruManager {
    private namespace;
    private signal?;
    private cacheDir;
    private evictionsCount;
    constructor(cacheDir: string, namespace?: string, signal?: AbortSignal | undefined);
    invalidateSnapshot(filename: string): Promise<void>;
    getEvictionsCount(): number;
    readMetadata(metaPath: string, matchNamespace?: boolean): Promise<SnapshotMetadata | null>;
    writeMetadata(metaPath: string, meta: SnapshotMetadata): Promise<void>;
    touchSnapshot(filename: string): Promise<void>;
    listSnapshots(allNamespaces?: boolean): Promise<SnapshotItem[]>;
    /**
     * Enforces LRU eviction based on maxSessions and maxDiskUsageGb.
     * Golden base cache (base_system_prompt.bin) is always preserved.
     * Global disk usage is checked across all namespaces in cacheDir.
     */
    enforceLRU(config: KvManagerConfig): Promise<{
        prunedFiles: string[];
        freedBytes: number;
    }>;
    static formatBytes(bytes: number): string;
}
//# sourceMappingURL=lru-manager.d.ts.map