import * as crypto from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { KvManagerConfig, SnapshotMetadata } from "./types.js";
import { saveSlot, restoreSlot } from "./checkpoint-engine.js";
import { LruManager } from "./lru-manager.js";

export const BASE_SNAPSHOT_BIN = "base_system_prompt.bin";
export const BASE_SNAPSHOT_META = "base_system_prompt.meta.json";

export function computeHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

export interface BaseCacheRestoreResult {
  status: "hit" | "miss" | "disabled" | "error";
  hash: string;
  tokens?: number;
  durationMs?: number;
  error?: string;
}

export class BaseCacheManager {
  private config: KvManagerConfig;
  private lru: LruManager;

  constructor(config: KvManagerConfig, lru: LruManager) {
    this.config = config;
    this.lru = lru;
  }

  getMetaPath(): string {
    return path.join(this.config.cacheDir, BASE_SNAPSHOT_META);
  }

  getBinPath(): string {
    return path.join(this.config.cacheDir, BASE_SNAPSHOT_BIN);
  }

  async getBaseMetadata(): Promise<SnapshotMetadata | null> {
    return this.lru.readMetadata(this.getMetaPath());
  }

  /**
   * Checks whether the current system prompt matches the cached golden base snapshot.
   * If matched, restores it instantly into the slot (~20ms).
   */
  async checkAndRestore(systemPrompt: string, slotId: number = this.config.slotId): Promise<BaseCacheRestoreResult> {
    if (!this.config.enableBaseCache) {
      return { status: "disabled", hash: "" };
    }

    const currentHash = computeHash(systemPrompt);
    const meta = await this.getBaseMetadata();

    if (!meta || meta.promptPrefixHash !== currentHash) {
      return { status: "miss", hash: currentHash };
    }

    // Verify bin file exists
    try {
      await fs.access(this.getBinPath());
    } catch {
      return { status: "miss", hash: currentHash };
    }

    try {
      const resp = await restoreSlot(
        this.config.llamaServerUrl,
        slotId,
        BASE_SNAPSHOT_BIN
      );

      await this.lru.touchSnapshot(BASE_SNAPSHOT_BIN);

      return {
        status: "hit",
        hash: currentHash,
        tokens: resp.n_restored ?? resp.n_tokens ?? meta.tokenCount,
        durationMs: resp.timings?.restore_ms ?? resp.t_ms ?? 0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: "error", hash: currentHash, error: msg };
    }
  }

  /**
   * Warms the base prompt by sending an evaluation request with n_predict=0,
   * then snapshots the resulting KV cache to disk as base_system_prompt.bin.
   */
  async warmAndSave(
    systemPrompt: string,
    hash: string
  ): Promise<{ tokens: number; durationMs: number; bytes: number }> {
    const completionUrl = `${this.config.llamaServerUrl.replace(/\/+$/, "")}/completion`;

    // 1. Evaluate prompt with n_predict = 0 to fill slot KV cache
    const evalRes = await fetch(completionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: systemPrompt,
        n_predict: 0,
        id_slot: this.config.slotId,
        cache_prompt: true,
      }),
    });

    if (!evalRes.ok) {
      const text = await evalRes.text();
      throw new Error(`Failed to warm base prompt on llama-server: ${text}`);
    }

    // 2. Snapshot the prefilled slot to base_system_prompt.bin
    const saveResp = await saveSlot(
      this.config.llamaServerUrl,
      this.config.slotId,
      BASE_SNAPSHOT_BIN
    );

    const now = new Date().toISOString();
    const savedTokens = saveResp.n_saved ?? saveResp.n_tokens ?? 0;
    const savedBytes = saveResp.n_written ?? saveResp.n_bytes ?? 0;
    const durationMs = saveResp.timings?.save_ms ?? saveResp.t_ms ?? 0;

    const meta: SnapshotMetadata = {
      sessionId: "base_system_prompt",
      sessionName: "Golden Base (System Prompt + Skills)",
      tokenCount: savedTokens,
      fileSizeBytes: savedBytes,
      createdAt: now,
      lastAccessedAt: now,
      promptPrefixHash: hash,
      isBaseSnapshot: true,
    };

    await this.lru.writeMetadata(this.getMetaPath(), meta);

    return {
      tokens: savedTokens,
      durationMs,
      bytes: savedBytes,
    };
  }
}
