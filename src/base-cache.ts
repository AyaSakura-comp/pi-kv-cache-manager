import { boundedFetch, checkCancelled } from "./request.js";
import * as crypto from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
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
  status: "hit" | "partial" | "miss" | "disabled" | "error";
  hash: string;
  tokens?: number;
  durationMs?: number;
  error?: string;
}

export class BaseCacheManager {
  private config: KvManagerConfig;
  private lru: LruManager;

  constructor(config: KvManagerConfig, lru: LruManager) {
    this.config = config.goldenPrefix ? { ...config, snapshotPrefix: config.goldenPrefix } : config;
    this.lru = config.goldenPrefix ? new LruManager(config.cacheDir, config.goldenPrefix, config.signal) : lru;
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

  private async withGoldenLock<T>(operation: () => Promise<T>): Promise<T> {
    const lock = path.join(this.config.cacheDir, `${this.config.goldenPrefix}update.lock`);
    const deadline = Date.now() + 60_000;
    for (;;) {
      checkCancelled(this.config);
      try { await fs.mkdir(lock); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() > deadline) throw new Error(`Golden update lock busy: ${lock}; no cache files changed`);
        await delay(25, undefined, { signal: this.config.signal });
      }
    }
    try { return await operation(); }
    finally { await fs.rmdir(lock); }
  }

  /** Audit every request; only a loaded-extension change or explicit update replaces golden. */
  async ensureGolden(systemPrompt: string, tools: unknown[], force = false): Promise<void> {
    if ((!this.config.enableBaseCache && !force) || !this.config.goldenPrefix) return;
    await this.withGoldenLock(async () => {
      await this.config.assertCurrent?.();
      const meta = await this.getBaseMetadata();
      const hash = computeHash(systemPrompt, tools);
      const mismatch = !!meta && (meta.promptPrefixHash !== hash || meta.renderedPrefixHash !== this.config.renderedPrefixHash);
      const changed = !!meta && !!this.config.extensionsFingerprint && meta.extensionsFingerprint !== this.config.extensionsFingerprint;
      const canUpdate = changed && meta?.canonicalCwd === this.config.goldenCwd &&
        (this.config.extensionLoadedAt ?? 0) > (meta?.extensionLoadedAt ?? 0);
      if (mismatch || changed) {
        const warning = { type: "golden_mismatch", timestamp: new Date().toISOString(),
          golden: this.getFilename(), expectedHash: meta?.promptPrefixHash, actualHash: hash,
          expectedRenderedHash: meta?.renderedPrefixHash, actualRenderedHash: this.config.renderedPrefixHash,
          expectedExtensions: meta?.extensionsFingerprint, actualExtensions: this.config.extensionsFingerprint,
          canonicalCwd: meta?.canonicalCwd, cwd: this.config.goldenCwd,
          action: force || canUpdate ? "update" : "preserve" };
        console.warn(`[pi-kv-cache-manager] ${JSON.stringify(warning)}`);
        await fs.appendFile(path.join(this.config.cacheDir, "golden-warnings.jsonl"), `${JSON.stringify(warning)}\n`);
      }
      let present = false;
      try { await fs.access(this.getBinPath()); present = true; } catch (error) { checkCancelled(this.config, error); }
      if (meta && present && !force && !canUpdate) return;
      // A unique staging snapshot keeps the previous golden usable if warm/save fails.
      const prefix = `${this.config.goldenPrefix}build_${crypto.randomUUID()}_`;
      const stageConfig = { ...this.config, goldenPrefix: undefined, snapshotPrefix: prefix };
      const stage = new BaseCacheManager(stageConfig, new LruManager(this.config.cacheDir, prefix, this.config.signal));
      const suffixes = ["", ".dft", ".ckpt", ".media.json"];
      const backups: Array<{ target: string; backup: string }> = [];
      const installed: string[] = [];
      let committed = false;
      try {
        await stage.warmAndSave(systemPrompt, hash, undefined, tools);
        const saved = await stage.getBaseMetadata();
        if (!saved || saved.tokenCount <= 0) throw new Error("Golden staging metadata unavailable");
        await this.config.assertCurrent?.();
        for (const suffix of [...suffixes, ".meta.json", ".tools.json"]) {
          const target = suffix === ".meta.json" ? this.getMetaPath() : suffix === ".tools.json" ? this.getToolsPath() : this.getBinPath() + suffix;
          const source = suffix === ".meta.json" ? stage.getMetaPath() : suffix === ".tools.json" ? stage.getToolsPath() : stage.getBinPath() + suffix;
          const backup = `${target}.${crypto.randomUUID()}.backup`;
          try { await fs.rename(target, backup); backups.push({ target, backup }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          if (suffix === ".meta.json") continue;
          try { await fs.rename(source, target); installed.push(target); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || suffix === "") throw error; }
        }
        const published = { ...saved, namespace: this.config.goldenPrefix, canonicalCwd: this.config.goldenCwd,
          renderedPrefixHash: this.config.renderedPrefixHash, extensionsFingerprint: this.config.extensionsFingerprint,
          extensionLoadedAt: this.config.extensionLoadedAt };
        await fs.writeFile(stage.getMetaPath(), JSON.stringify(published, null, 2), { signal: this.config.signal });
        checkCancelled(this.config);
        await fs.rename(stage.getMetaPath(), this.getMetaPath());
        committed = true;
      } finally {
        if (!committed) {
          for (const target of installed) await fs.unlink(target).catch(() => {});
          for (const { target, backup } of backups.reverse()) await fs.rename(backup, target);
        } else {
          for (const { backup } of backups) await fs.unlink(backup).catch(() => {});
        }
        for (const file of [stage.getBinPath(), ...suffixes.slice(1).map(s => stage.getBinPath() + s), stage.getMetaPath(), stage.getToolsPath()]) {
          await fs.unlink(file).catch(() => {});
        }
      }
    });
  }

  /**
   * Restore a validated runtime snapshot. Canonical golden may be a partial
   * candidate; only llama-server can measure the actually reusable token prefix.
   */
  async checkAndRestore(
    systemPrompt: string,
    slotId: number = this.config.slotId,
    tools?: unknown[]
  ): Promise<BaseCacheRestoreResult> {
    if (this.config.goldenPrefix && this.config.enableBaseCache) {
      return this.withGoldenLock(() => this.restoreBase(systemPrompt, slotId, tools));
    }
    return this.restoreBase(systemPrompt, slotId, tools);
  }

  private async restoreBase(systemPrompt: string, slotId: number, tools?: unknown[]): Promise<BaseCacheRestoreResult> {
    if (!this.config.enableBaseCache) {
      return { status: "disabled", hash: "" };
    }

    let effectiveTools = tools;
    if (effectiveTools === undefined) {
      effectiveTools = await this.loadCachedTools();
    }

    const currentHash = computeHash(systemPrompt, effectiveTools);
    const meta = await this.getBaseMetadata();

    if (!meta || (!this.config.goldenPrefix && meta.promptPrefixHash !== currentHash)) {
      return { status: "miss", hash: currentHash };
    }
    const exact = meta.promptPrefixHash === currentHash && (!this.config.goldenPrefix || meta.renderedPrefixHash === this.config.renderedPrefixHash);

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
        // llama-server verifies token equality and resumes only the common prefix.
        status: exact ? "hit" : "partial",
        hash: currentHash,
        tokens: resp.n_restored ?? resp.n_tokens ?? meta.tokenCount,
        durationMs: resp.timings?.restore_ms ?? resp.t_ms ?? 0,
      };
    } catch (err) {
      checkCancelled(this.config, err);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[pi-kv-cache-manager] Failed to restore base snapshot (${msg}); preserving files for a later retry...`
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
