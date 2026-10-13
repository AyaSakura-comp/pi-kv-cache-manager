import type { KvManagerConfig, SnapshotMetadata } from "./types.js";
import { LruManager } from "./lru-manager.js";
export declare const BASE_SNAPSHOT_BIN = "base_system_prompt.bin";
export declare const BASE_SNAPSHOT_META = "base_system_prompt.meta.json";
export declare const BASE_TOOLS_JSON = "base_tools.json";
/** `/kv base-update` from a process that has no live prefix (piweb/Discord run each command in a fresh pi). */
export declare const GOLDEN_REFRESH_REQUEST = "refresh.request";
/** Context files and skills Pi rendered into a system prompt (absolute paths, prompt order). */
export declare function extractResourcePaths(systemPrompt: string): string[];
/** The opening of Pi's prompt (identity + tool list) differs for subagents with their own system prompt. */
export declare function promptHead(systemPrompt: string): string;
export declare function goldenRefreshRequestPath(cacheDir: string, goldenPrefix: string): string;
/** Schedules a golden rebuild for the next new session in `cwd`, which has the exact serialized prefix. */
export declare function requestGoldenRefresh(cacheDir: string, goldenPrefix: string, cwd: string): Promise<string>;
type RefreshReason = "requested" | "resources" | "quorum" | "extensions";
export declare function stableStringify(obj: unknown): string;
export declare function computeHash(content: string, tools?: unknown[]): string;
export interface BaseCacheRestoreResult {
    status: "hit" | "partial" | "miss" | "disabled" | "error";
    hash: string;
    tokens?: number;
    durationMs?: number;
    error?: string;
    /** Set when golden was rebuilt into the slot instead of restored. */
    rebuilt?: RefreshReason;
}
export declare class BaseCacheManager {
    private config;
    private lru;
    /** Decided while auditing a request; carried out by the next new session's golden restore. */
    private pendingRefresh?;
    constructor(config: KvManagerConfig, lru: LruManager);
    getFilename(): string;
    getMetaPath(): string;
    getBinPath(): string;
    getToolsPath(): string;
    loadCachedTools(): Promise<unknown[] | undefined>;
    saveCachedTools(tools: unknown[]): Promise<void>;
    getBaseMetadata(): Promise<SnapshotMetadata | null>;
    private withGoldenLock;
    private refreshRequestPath;
    private log;
    private stat;
    /** A stamp is only trusted when the builder loaded the file after its last change. */
    private stampResources;
    /**
     * Which rendered context files/skills changed since golden was built: edited or deleted golden
     * resources, plus files new to this prompt created after golden (an installed skill).
     * `missing` lists golden resources that still exist but this prompt lacks (a reduced variant).
     */
    private resourceEvidence;
    /** Records that `sessionId` sent prefix `key`; returns the vote so far. */
    private observe;
    /**
     * Silent refresh policy (canonical cwd, same extension set). The prompt must open like golden and
     * keep every golden resource, so subagents and reduced variants never replace it. Then either a
     * rendered context file/skill changed and this worker loaded it afterwards, or two sessions sent
     * the same new prefix that was never golden before.
     */
    private planRefresh;
    /**
     * Audit every request. An explicit update replaces golden now; a loaded-extension change, a context
     * file/skill edit, a repeated new prefix or a scheduled `/kv base-update` is carried out silently
     * by the next new session's golden restore (see checkAndRestore), seeded from the old golden.
     */
    ensureGolden(systemPrompt: string, tools: unknown[], force?: boolean, options?: {
        sessionId?: string;
    }): Promise<void>;
    /**
     * Warm, save and publish a new golden (caller holds the golden lock). `seed` restores the current
     * golden into `slotId` first, so llama-server re-prefills only the changed suffix of the prefix.
     */
    private rebuild;
    /** Carry out the refresh planned for this prefix, unless another worker already published it. */
    private performPendingRefresh;
    /**
     * Restore a validated runtime snapshot. Canonical golden may be a partial
     * candidate; only llama-server can measure the actually reusable token prefix.
     */
    checkAndRestore(systemPrompt: string, slotId?: number, tools?: unknown[]): Promise<BaseCacheRestoreResult>;
    private restoreBase;
    /**
     * Warms the base prompt by sending an evaluation request with n_predict=0,
     * then snapshots the resulting KV cache to disk as base_system_prompt.bin.
     * Dynamically selects an idle slot (or uses preferredSlotId), formats with /apply-template,
     * and cleanly erases the slot before prefilling (or restores `seedFilename` into it instead).
     */
    warmAndSave(systemPrompt: string, hash: string, preferredSlotId?: number, tools?: unknown[], seedFilename?: string): Promise<{
        tokens: number;
        durationMs: number;
        bytes: number;
        slotId: number;
        seeded: boolean;
    }>;
}
export {};
//# sourceMappingURL=base-cache.d.ts.map