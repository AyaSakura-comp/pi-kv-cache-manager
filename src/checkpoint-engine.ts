import * as path from "node:path";
import type { KvManagerConfig, LlamaSlotActionResponse, SnapshotMetadata } from "./types.js";
import { LruManager } from "./lru-manager.js";

export function sanitizeFilename(name: string): string {
  // llama-server fs_validate_filename strictly disallows /, \, ..
  return name.replace(/[^a-zA-Z0-9_\-\.]/g, "_");
}

export async function saveSlot(
  baseUrl: string,
  slotId: number,
  filename: string
): Promise<LlamaSlotActionResponse> {
  const url = `${baseUrl.replace(/\/+$/, "")}/slots/${slotId}?action=save`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename }),
  });

  const data = (await res.json()) as LlamaSlotActionResponse;
  if (!res.ok) {
    const msg = data.error?.message || `HTTP ${res.status} ${res.statusText}`;
    throw new Error(`llama-server slot save failed: ${msg}`);
  }
  return data;
}

export async function restoreSlot(
  baseUrl: string,
  slotId: number,
  filename: string
): Promise<LlamaSlotActionResponse> {
  const url = `${baseUrl.replace(/\/+$/, "")}/slots/${slotId}?action=restore`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename }),
  });

  const data = (await res.json()) as LlamaSlotActionResponse;
  if (!res.ok) {
    const msg = data.error?.message || `HTTP ${res.status} ${res.statusText}`;
    throw new Error(`llama-server slot restore failed: ${msg}`);
  }
  return data;
}

export async function eraseSlot(baseUrl: string, slotId: number): Promise<void> {
  const url = `${baseUrl.replace(/\/+$/, "")}/slots/${slotId}?action=erase`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`llama-server slot erase failed: ${text}`);
  }
}

export class CheckpointEngine {
  private config: KvManagerConfig;
  private lru: LruManager;
  private sessionSavedTokens = new Map<string, number>();
  private inFlightSaves = new Set<string>();

  constructor(config: KvManagerConfig, lru: LruManager) {
    this.config = config;
    this.lru = lru;
  }

  getSavedTokens(sessionId: string): number {
    return this.sessionSavedTokens.get(sessionId) || 0;
  }

  setSavedTokens(sessionId: string, count: number): void {
    this.sessionSavedTokens.set(sessionId, count);
  }

  isSaving(sessionId: string): boolean {
    return this.inFlightSaves.has(sessionId);
  }

  getSnapshotFilename(sessionId: string): string {
    return `snap_${sanitizeFilename(sessionId)}.bin`;
  }

  /**
   * Evaluates token progress after a turn and executes an asynchronous,
   * non-blocking snapshot save if threshold conditions are met.
   */
  async maybeCheckpoint(
    sessionId: string,
    sessionName: string | undefined,
    currentTokens: number,
    onSuccess?: (info: { tokens: number; durationMs: number; bytes: number }) => void,
    onError?: (error: Error) => void
  ): Promise<boolean> {
    if (!this.config.enableIncrementalSave) {
      return false;
    }

    if (currentTokens < this.config.minTokensThreshold) {
      return false;
    }

    const lastSaved = this.sessionSavedTokens.get(sessionId) || 0;
    const delta = currentTokens - lastSaved;

    if (delta < this.config.stepTokensIncrement) {
      return false;
    }

    if (this.inFlightSaves.has(sessionId)) {
      return false;
    }

    this.inFlightSaves.add(sessionId);

    // Run async checkpoint in background so the UI and agent loop are never stalled
    (async () => {
      const filename = this.getSnapshotFilename(sessionId);
      const metaFilename = filename.replace(/\.bin$/, ".meta.json");
      const metaPath = path.join(this.config.cacheDir, metaFilename);

      try {
        const resp = await saveSlot(
          this.config.llamaServerUrl,
          this.config.slotId,
          filename
        );

        const savedTokens = resp.n_saved ?? resp.n_tokens ?? currentTokens;
        const savedBytes = resp.n_written ?? resp.n_bytes ?? 0;
        const saveMs = resp.timings?.save_ms ?? resp.t_ms ?? 0;
        this.sessionSavedTokens.set(sessionId, savedTokens);

        const existingMeta = await this.lru.readMetadata(metaPath);
        const now = new Date().toISOString();

        const meta: SnapshotMetadata = {
          sessionId,
          sessionName,
          tokenCount: savedTokens,
          fileSizeBytes: savedBytes,
          createdAt: existingMeta?.createdAt || now,
          lastAccessedAt: now,
          promptPrefixHash: existingMeta?.promptPrefixHash || "",
          isBaseSnapshot: false,
        };

        await this.lru.writeMetadata(metaPath, meta);

        // Run LRU check to maintain session quota
        await this.lru.enforceLRU(this.config);

        if (onSuccess) {
          onSuccess({
            tokens: savedTokens,
            durationMs: saveMs,
            bytes: savedBytes,
          });
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error(`[pi-kv-cache-manager] Checkpoint error for ${sessionId}:`, error);
        if (onError) onError(error);
      } finally {
        this.inFlightSaves.delete(sessionId);
      }
    })();

    return true;
  }
}
