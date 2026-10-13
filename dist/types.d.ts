import type { RequestOptions } from "./request.js";
/**
 * Type definitions for pi-kv-cache-manager
 */
export interface KvManagerConfig extends RequestOptions {
    /** Internal server + full request-prefix namespace; never loaded from user settings. */
    snapshotPrefix?: string;
    /** Canonical golden namespace (model/adapter identity only, independent of session prefix). */
    goldenPrefix?: string;
    goldenCwd?: string;
    renderedPrefixHash?: string;
    extensionsFingerprint?: string;
    extensionLoadedAt?: number;
    runtimeIdentity?: string;
    templateOptions?: Record<string, unknown>;
    assertCurrent?: () => Promise<void>;
    /** Base URL for llama-server HTTP API (default: http://127.0.0.1:8001) */
    llamaServerUrl: string;
    /** Active llama.cpp slot ID to manage (default: 0) */
    slotId: number;
    /** Storage directory for KV snapshots and metadata sidecars */
    cacheDir: string;
    /** Maximum number of session snapshots to keep in LRU cache (default: 30) */
    maxSessions: number;
    /** Hard disk quota in Gigabytes before eviction occurs (default: 40) */
    maxDiskUsageGb: number;
    /** Minimum token threshold before automatic snapshot saving activates (default: 25000) */
    minTokensThreshold: number;
    /** Token step increment to trigger an incremental lazy snapshot (default: 5000) */
    stepTokensIncrement: number;
    /** Whether to enable Golden Base System Prompt & Skills caching (default: true) */
    enableBaseCache: boolean;
    /** Whether to enable automatic incremental checkpointing on turn_end (default: true) */
    enableIncrementalSave: boolean;
}
export interface SnapshotMetadata {
    namespace?: string;
    canonicalCwd?: string;
    renderedPrefixHash?: string;
    extensionsFingerprint?: string;
    extensionLoadedAt?: number;
    sessionId: string;
    sessionName?: string;
    tokenCount: number;
    fileSizeBytes: number;
    createdAt: string;
    lastAccessedAt: string;
    promptPrefixHash: string;
    isBaseSnapshot?: boolean;
    /** Golden only: context files and skills rendered into the golden prompt, as stat'ed at build time. */
    resources?: ResourceStamp[];
    /** Golden only: hash of the raw system prompt's opening, to tell the main agent from foreign prompts. */
    headHash?: string;
    /** Golden only: prompt keys of replaced goldens; a vote cannot bring them back. */
    retired?: string[];
    /** Golden only: why the current golden was (re)built. */
    refreshReason?: string;
}
export interface ResourceStamp {
    path: string;
    /** -1 when the file changed after the builder process loaded it (its prompt may predate the edit). */
    mtimeMs: number;
    size: number;
}
export interface LlamaSlotActionResponse {
    id?: number;
    id_slot?: number;
    filename?: string;
    is_save?: boolean;
    n_saved?: number;
    n_restored?: number;
    n_tokens?: number;
    n_written?: number;
    n_read?: number;
    n_bytes?: number;
    timings?: {
        save_ms?: number;
        restore_ms?: number;
    };
    t_ms?: number;
    error?: {
        code: number;
        message: string;
        type: string;
    };
}
export interface CacheStatusReport {
    totalSnapshots: number;
    totalDiskBytes: number;
    sessionSnapshots: SnapshotMetadata[];
    baseSnapshot?: SnapshotMetadata | null;
    lruEvictionsCount: number;
    activeSessionTokens?: number;
    lastAction?: string;
}
export interface LlamaSlotInfo {
    id: number;
    n_ctx: number;
    speculative?: boolean;
    is_processing: boolean;
    snapshot_filename?: string;
    t_last_used?: number;
    id_task?: number;
}
//# sourceMappingURL=types.d.ts.map