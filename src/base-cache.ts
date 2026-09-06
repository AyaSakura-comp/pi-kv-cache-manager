import * as crypto from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { KvManagerConfig, SnapshotMetadata } from "./types.js";
import { saveSlot, restoreSlot, eraseSlot, fetchSlots } from "./checkpoint-engine.js";
import { LruManager } from "./lru-manager.js";

export const BASE_SNAPSHOT_BIN = "base_system_prompt.bin";
export const BASE_SNAPSHOT_META = "base_system_prompt.meta.json";
export const BASE_TOOLS_JSON = "base_tools.json";

function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((obj as Record<string, unknown>)[k])).join(",") + "}";
}

export function computeHash(content: string, tools?: unknown[]): string {
  const h = crypto.createHash("sha256").update(content, "utf-8");
  if (tools && Array.isArray(tools) && tools.length > 0) {
    h.update(stableStringify(tools), "utf-8");
  }
  return h.digest("hex");
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

  getToolsPath(): string {
    return path.join(this.config.cacheDir, BASE_TOOLS_JSON);
  }

  async loadCachedTools(): Promise<unknown[] | undefined> {
    try {
      const raw = await fs.readFile(this.getToolsPath(), "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      // Ignored
    }
    return undefined;
  }

  async saveCachedTools(tools: unknown[]): Promise<void> {
    try {
      await fs.writeFile(this.getToolsPath(), JSON.stringify(tools, null, 2), "utf-8");
    } catch {
      // Ignored
    }
  }

  async getBaseMetadata(): Promise<SnapshotMetadata | null> {
    return this.lru.readMetadata(this.getMetaPath());
  }

  /**
   * Checks whether the current system prompt + tools match the cached golden base snapshot.
   * If matched, restores it instantly into the slot (~20ms).
   */
  async checkAndRestore(
    systemPrompt: string,
    slotId: number = this.config.slotId,
    tools?: unknown[]
  ): Promise<BaseCacheRestoreResult> {
    if (!this.config.enableBaseCache) {
      return { status: "disabled", hash: "" };
    }

    let effectiveTools = tools;
    if (effectiveTools === undefined) {
      effectiveTools = await this.loadCachedTools();
    }

    const currentHash = computeHash(systemPrompt, effectiveTools);
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
   * Dynamically selects an idle slot (or uses preferredSlotId), formats with /apply-template,
   * and cleanly erases the slot before prefilling.
   */
  async warmAndSave(
    systemPrompt: string,
    hash: string,
    preferredSlotId?: number,
    tools?: unknown[]
  ): Promise<{ tokens: number; durationMs: number; bytes: number; slotId: number }> {
    const baseUrl = this.config.llamaServerUrl.replace(/\/+$/, "");

    let effectiveTools = tools;
    if (effectiveTools === undefined) {
      effectiveTools = await this.loadCachedTools();
    }
    if (effectiveTools && Array.isArray(effectiveTools) && effectiveTools.length > 0) {
      await this.saveCachedTools(effectiveTools);
    }

    // 1. Determine target slot dynamically (prefer idle slot)
    let targetSlot = preferredSlotId;
    if (targetSlot === undefined) {
      try {
        const slots = await fetchSlots(this.config.llamaServerUrl);
        const idleSlot = slots.find((s) => !s.is_processing);
        targetSlot = idleSlot ? idleSlot.id : this.config.slotId;
      } catch {
        targetSlot = this.config.slotId;
      }
    }

    // 2. Format prompt via /apply-template if available to ensure chat template token consistency
    let formattedPrompt = systemPrompt;
    try {
      const templatePayload: Record<string, unknown> = {
        messages: [{ role: "system", content: systemPrompt }],
        add_generation_prompt: false,
      };
      if (effectiveTools && Array.isArray(effectiveTools) && effectiveTools.length > 0) {
        templatePayload.tools = effectiveTools;
      }

      const templateRes = await fetch(`${baseUrl}/apply-template`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(templatePayload),
      });
      if (templateRes.ok) {
        const data = (await templateRes.json()) as { prompt?: string };
        if (data.prompt) {
          formattedPrompt = data.prompt;
        }
      }
    } catch {
      // Fallback to raw systemPrompt if /apply-template is unavailable
    }

    // 3. Erase target slot first to guarantee a pure, clean prefill (no leftover tokens)
    try {
      await eraseSlot(this.config.llamaServerUrl, targetSlot);
    } catch {
      // Ignore if slot was already clean
    }

    // 4. Evaluate formatted prompt with n_predict = 0 to fill slot KV cache
    const completionUrl = `${baseUrl}/completion`;
    const evalRes = await fetch(completionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: formattedPrompt,
        n_predict: 0,
        id_slot: targetSlot,
        cache_prompt: true,
      }),
    });

    if (!evalRes.ok) {
      const text = await evalRes.text();
      throw new Error(`Failed to warm base prompt on llama-server: ${text}`);
    }

    // 5. Snapshot the prefilled slot to base_system_prompt.bin
    const saveResp = await saveSlot(
      this.config.llamaServerUrl,
      targetSlot,
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
      slotId: targetSlot,
    };
  }
}
