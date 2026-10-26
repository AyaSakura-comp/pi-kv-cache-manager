import { boundedFetch, checkCancelled, type RequestOptions } from "./request.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { KvManagerConfig, LlamaSlotActionResponse, LlamaSlotInfo, SnapshotMetadata } from "./types.js";
import { LruManager } from "./lru-manager.js";

export async function fetchSlots(baseUrl: string, options: RequestOptions = {}): Promise<LlamaSlotInfo[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/slots`;
  const res = await boundedFetch(url, {}, options);
  if (!res.ok) {
    throw new Error(`Failed to fetch slots from llama-server: HTTP ${res.status}`);
  }
  return (await res.json()) as LlamaSlotInfo[];
}

export function sanitizeFilename(name: string): string {
  // llama-server fs_validate_filename strictly disallows /, \, ..
  return name.replace(/[^a-zA-Z0-9_\-\.]/g, "_");
}

export async function saveSlot(
  baseUrl: string,
  slotId: number,
  filename: string,
  options: RequestOptions = {}
): Promise<LlamaSlotActionResponse> {
  const url = `${baseUrl.replace(/\/+$/, "")}/slots/${slotId}?action=save`;
  // Saving writes hundreds of MB and queues behind work already running on the
  // slot (e.g. a speculative prefill), so it gets the long deadline: hitting the
  // 5 s control deadline aborted the runtime and discarded the session's slot.
  const res = await boundedFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename }),
  }, options, true);

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
  filename: string,
  options: RequestOptions = {}
): Promise<LlamaSlotActionResponse> {
  const url = `${baseUrl.replace(/\/+$/, "")}/slots/${slotId}?action=restore`;
  const res = await boundedFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename }),
  }, options, true); // same as save: heavy slot I/O, long deadline

  const data = (await res.json()) as LlamaSlotActionResponse;
  if (!res.ok) {
    const msg = data.error?.message || `HTTP ${res.status} ${res.statusText}`;
    throw new Error(`llama-server slot restore failed: ${msg}`);
  }
  return data;
}

export async function eraseSlot(baseUrl: string, slotId: number, options: RequestOptions = {}): Promise<void> {
  const url = `${baseUrl.replace(/\/+$/, "")}/slots/${slotId}?action=erase`;
  // The server first saves a changed slot for its owner (slot_snapshot), and Strata's single slot waits for the
  // running request: the long deadline, as for save/restore.
  const res = await boundedFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  }, options, true);
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
    return `${this.config.snapshotPrefix ?? ""}snap_${sanitizeFilename(sessionId)}.bin`;
  }

  /**
   * Evaluates token progress after a turn and awaits a serialized snapshot
   * save if threshold conditions are met. Server disk I/O is synchronous.
   */
  /**
   * Requests name this session's snapshot (slot_snapshot), so llama-server may save it there
   * before another context evicts the slot, even before this extension's first save (turns that
   * end in tool calls skip it). Give such a file metadata up front, or the restore would ignore it
   * and fall back to golden. Never replaces existing metadata, including a save's tombstone.
   */
  async claimSnapshot(sessionId: string, sessionName?: string): Promise<void> {
    const metaPath = path.join(this.config.cacheDir, this.getSnapshotFilename(sessionId).replace(/\.bin$/, ".meta.json"));
    const now = new Date().toISOString();
    const meta: SnapshotMetadata = { sessionId, sessionName, tokenCount: 0, fileSizeBytes: 0, createdAt: now,
      lastAccessedAt: now, promptPrefixHash: "", isBaseSnapshot: false };
    try {
      await fs.writeFile(metaPath, JSON.stringify({ ...meta, namespace: this.config.snapshotPrefix }, null, 2),
        { flag: "wx", signal: this.config.signal });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") checkCancelled(this.config, error);
    }
  }

  async maybeCheckpoint(
    sessionId: string,
    sessionName: string | undefined,
    currentTokens: number,
    slotId: number = this.config.slotId,
    onSuccess?: (info: { tokens: number; durationMs: number; bytes: number }) => void,
    onError?: (error: Error) => void
  ): Promise<boolean> {
    checkCancelled(this.config);
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

    const filename = this.getSnapshotFilename(sessionId);
    const metaFilename = filename.replace(/\.bin$/, ".meta.json");
    const metaPath = path.join(this.config.cacheDir, metaFilename);

    try {
      await this.config.assertCurrent?.();
      const existingMeta = await this.lru.readMetadata(metaPath);
      checkCancelled(this.config);
      await this.lru.invalidateSnapshot(filename);
      const resp = await saveSlot(
        this.config.llamaServerUrl,
        slotId,
        filename, this.config
      );

      await this.config.assertCurrent?.();
      checkCancelled(this.config);
      const savedTokens = resp.n_saved ?? resp.n_tokens ?? currentTokens;
      const savedBytes = resp.n_written ?? resp.n_bytes ?? 0;
      const saveMs = resp.timings?.save_ms ?? resp.t_ms ?? 0;
      this.sessionSavedTokens.set(sessionId, savedTokens);

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

      checkCancelled(this.config);
      await this.lru.writeMetadata(metaPath, meta);

      // Run LRU check to maintain session quota
      await this.config.assertCurrent?.();
      await this.lru.enforceLRU(this.config);

      checkCancelled(this.config);
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
      if (!this.config.signal?.aborted && !["AbortError", "TimeoutError"].includes(error.name) && onError) onError(error);
    } finally {
      this.inFlightSaves.delete(sessionId);
    }

    return true;
  }
}
