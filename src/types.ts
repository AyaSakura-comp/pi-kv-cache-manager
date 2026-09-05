/**
 * Type definitions for pi-kv-cache-manager
 */

export interface KvManagerConfig {
  /** Base URL for llama-server HTTP API (default: http://127.0.0.1:8001) */
  llamaServerUrl: string;
  /** Active llama.cpp slot ID to manage (default: 0) */
  slotId: number;
  /** Storage directory for KV snapshots and metadata sidecars */
  cacheDir: string;
  /** Maximum number of session snapshots to keep in LRU cache (default: 5) */
  maxSessions: number;
  /** Hard disk quota in Gigabytes before eviction occurs (default: 30) */
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
  sessionId: string;
  sessionName?: string;
  tokenCount: number;
  fileSizeBytes: number;
  createdAt: string;
  lastAccessedAt: string;
  promptPrefixHash: string;
  isBaseSnapshot?: boolean;
}

export interface LlamaSlotActionResponse {
  id?: number;
  id_slot?: number;
  filename?: string;
  is_save?: boolean;
  n_tokens?: number;
  n_bytes?: number;
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
