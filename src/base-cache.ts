import { boundedFetch, checkCancelled } from "./request.js";
import * as crypto from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { KvManagerConfig, SnapshotMetadata } from "./types.js";
import { saveSlot, restoreSlot, eraseSlot, fetchSlots } from "./checkpoint-engine.js";
import { LruManager } from "./lru-manager.js";

export const BASE_SNAPSHOT_BIN = "base_system_prompt.bin";
export const BASE_SNAPSHOT_META = "base_system_prompt.meta.json";
export const BASE_TOOLS_JSON = "base_tools.json";

export function stableStringify(obj: unknown): string {
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

  getFilename(): string {
    return `${this.config.snapshotPrefix ?? ""}${BASE_SNAPSHOT_BIN}`;
  }

  getMetaPath(): string {
    return path.join(this.config.cacheDir, this.getFilename().replace(/\.bin$/, ".meta.json"));
  }

  getBinPath(): string {
    return path.join(this.config.cacheDir, this.getFilename());
  }

  getToolsPath(): string {
    return path.join(this.config.cacheDir, `${this.config.snapshotPrefix ?? ""}${BASE_TOOLS_JSON}`);
  }

  async loadCachedTools(): Promise<unknown[] | undefined> {
    try {
      const raw = await fs.readFile(this.getToolsPath(), "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (error) {
      checkCancelled(this.config, error);
      // Ignored
    }
    return undefined;
  }

  async saveCachedTools(tools: unknown[]): Promise<void> {
    checkCancelled(this.config);
    try {
      await fs.writeFile(this.getToolsPath(), JSON.stringify(tools, null, 2), { encoding: "utf-8", signal: this.config.signal });
    } catch (error) {
      checkCancelled(this.config, error);
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
    } catch (error) {
      checkCancelled(this.config, error);
      return { status: "miss", hash: currentHash };
    }

    try {
      checkCancelled(this.config);
      await this.config.assertCurrent?.();
      const resp = await restoreSlot(
        this.config.llamaServerUrl,
        slotId,
        this.getFilename(), this.config
      );

      checkCancelled(this.config);
      await this.config.assertCurrent?.();
      await this.lru.touchSnapshot(this.getFilename());

      return {
        status: "hit",
        hash: currentHash,
        tokens: resp.n_restored ?? resp.n_tokens ?? meta.tokenCount,
        durationMs: resp.timings?.restore_ms ?? resp.t_ms ?? 0,
      };
    } catch (err) {
      checkCancelled(this.config, err);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[pi-kv-cache-manager] Failed to restore base snapshot (${msg}); preserving files and trying a fresh warm...`
      );
      // An HTTP/discovery failure is not evidence that the snapshot is corrupt.
      // Leave binaries and MTP sidecars untouched; a later successful warm may replace them.
      return { status: "miss", hash: currentHash, error: msg };
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
    checkCancelled(this.config);
    await this.config.assertCurrent?.();
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
        const slots = await fetchSlots(this.config.llamaServerUrl, this.config);
        const idleSlot = slots.find((s) => !s.is_processing);
        targetSlot = idleSlot ? idleSlot.id : this.config.slotId;
      } catch (error) {
        checkCancelled(this.config, error);
        targetSlot = this.config.slotId;
      }
    }

    // 2. Format prompt via /apply-template if available to ensure chat template token consistency
    let formattedPrompt = systemPrompt;
    try {
      const templatePayload: Record<string, unknown> = {
        messages: [{ role: "system", content: systemPrompt }],
        ...this.config.templateOptions,
        add_generation_prompt: false,
      };
      if (effectiveTools && Array.isArray(effectiveTools) && effectiveTools.length > 0) {
        templatePayload.tools = effectiveTools;
      }

      const templateRes = await boundedFetch(`${baseUrl}/apply-template`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(templatePayload),
      }, this.config);
      if (!templateRes.ok) throw new Error("Chat template unavailable");
      const data = (await templateRes.json()) as { prompt?: string };
      if (typeof data.prompt !== "string") throw new Error("Missing formatted prefix");
      formattedPrompt = data.prompt;
    } catch (error) {
      // Never label raw, untemplated tokens as a valid golden prefix.
      throw error;
    }
    checkCancelled(this.config);
    await this.config.assertCurrent?.();

    // 3. Erase target slot first to guarantee a pure, clean prefill (no leftover tokens)
    try {
      await eraseSlot(this.config.llamaServerUrl, targetSlot, this.config);
    } catch (error) {
      checkCancelled(this.config, error);
      // Ignore if slot was already clean
    }

    // 4. Evaluate formatted prompt with n_predict = 0 to fill slot KV cache
    const completionUrl = `${baseUrl}/completion`;
    const evalRes = await boundedFetch(completionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: formattedPrompt,
        n_predict: 0,
        id_slot: targetSlot,
        cache_prompt: true,
      }),
    }, this.config, true);

    if (!evalRes.ok) {
      const text = await evalRes.text();
      throw new Error(`Failed to warm base prompt on llama-server: ${text}`);
    }

    // 5. Snapshot the prefilled slot to base_system_prompt.bin
    checkCancelled(this.config);
    await this.config.assertCurrent?.();
    await this.lru.invalidateSnapshot(this.getFilename());
    const saveResp = await saveSlot(
      this.config.llamaServerUrl,
      targetSlot,
      this.getFilename(), this.config
    );
    checkCancelled(this.config);
    await this.config.assertCurrent?.();

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
