import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { KvManagerConfig, LlamaSlotInfo } from "./types.js";
import { fetchSlots, restoreSlot, eraseSlot, CheckpointEngine } from "./checkpoint-engine.js";
import { LruManager } from "./lru-manager.js";
import { BaseCacheManager, BASE_SNAPSHOT_BIN } from "./base-cache.js";

export interface SlotResolutionResult {
  slotId: number;
  hit: boolean;
  restored: boolean;
  isBase?: boolean;
  tokens?: number;
  durationMs?: number;
}

export class SlotManager {
  private config: KvManagerConfig;
  private lru: LruManager;
  private engine: CheckpointEngine;
  private baseCache: BaseCacheManager;
  private activeSlotSessions = new Map<number, string>(); // slotId -> sessionId

  constructor(
    config: KvManagerConfig,
    lru: LruManager,
    engine: CheckpointEngine,
    baseCache: BaseCacheManager
  ) {
    this.config = config;
    this.lru = lru;
    this.engine = engine;
    this.baseCache = baseCache;
  }

  getActiveSlot(sessionId: string): number | undefined {
    for (const [slotId, sid] of this.activeSlotSessions.entries()) {
      if (sid === sessionId) return slotId;
    }
    return undefined;
  }

  clearSession(sessionId: string): void {
    for (const [slotId, sid] of this.activeSlotSessions.entries()) {
      if (sid === sessionId) {
        this.activeSlotSessions.delete(slotId);
      }
    }
  }

  async ensureSlotForSession(
    sessionId: string,
    systemPrompt?: string,
    tools?: unknown[]
  ): Promise<SlotResolutionResult> {
    const snapFilename = this.engine.getSnapshotFilename(sessionId);
    let slots: LlamaSlotInfo[] = [];

    try {
      slots = await fetchSlots(this.config.llamaServerUrl);
    } catch (err) {
      console.warn(
        `[pi-kv-cache-manager] Failed to fetch slots from ${this.config.llamaServerUrl}, using fallback slot ${this.config.slotId}:`,
        err
      );
      slots = [{ id: this.config.slotId, n_ctx: 0, is_processing: false, snapshot_filename: "" }];
    }

    if (slots.length === 0) {
      slots = [{ id: this.config.slotId, n_ctx: 0, is_processing: false, snapshot_filename: "" }];
    }

    // 1. Direct RAM Cache Hit:
    // A) Is this session currently tracked as active in one of our slots?
    for (const [slotId, activeSid] of this.activeSlotSessions.entries()) {
      if (activeSid === sessionId) {
        const live = slots.find((s) => s.id === slotId);
        if (live) {
          if (
            live.snapshot_filename &&
            live.snapshot_filename !== snapFilename &&
            live.snapshot_filename !== BASE_SNAPSHOT_BIN
          ) {
            this.activeSlotSessions.delete(slotId);
          } else {
            return {
              slotId,
              hit: true,
              restored: false,
            };
          }
        }
      }
    }

    // B) Does any slot currently have our snapshot_filename loaded?
    const residentSlot = slots.find((s) => s.snapshot_filename === snapFilename);
    if (residentSlot) {
      this.activeSlotSessions.set(residentSlot.id, sessionId);
      return {
        slotId: residentSlot.id,
        hit: true,
        restored: false,
      };
    }

    // 2. RAM Cache Miss: Select the best slot to restore into.
    // Prefer idle slots (not currently processing a request)
    const idleSlots = slots.filter((s) => !s.is_processing);
    const candidates = idleSlots.length > 0 ? idleSlots : slots;

    // Selection priority:
    // Priority A: An empty / fresh slot not actively assigned to another session
    let chosenSlot = candidates.find(
      (s) => !s.snapshot_filename && !this.activeSlotSessions.has(s.id)
    );

    // Priority B: Any slot not actively assigned to another session
    if (!chosenSlot) {
      chosenSlot = candidates.find((s) => !this.activeSlotSessions.has(s.id));
    }

    // Priority C: The least recently used slot (smallest t_last_used)
    if (!chosenSlot) {
      chosenSlot = [...candidates].sort((a, b) => (a.t_last_used ?? 0) - (b.t_last_used ?? 0))[0];
    }

    const targetSlotId = chosenSlot ? chosenSlot.id : this.config.slotId;
    this.activeSlotSessions.delete(targetSlotId);

    // 3. Restore session snapshot from disk if available
    const snapPath = path.join(this.config.cacheDir, snapFilename);
    let snapExists = false;
    try {
      await fs.access(snapPath);
      snapExists = true;
    } catch {
      snapExists = false;
    }

    if (snapExists) {
      const resp = await restoreSlot(this.config.llamaServerUrl, targetSlotId, snapFilename);
      await this.lru.touchSnapshot(snapFilename);
      const tokens = resp.n_restored ?? resp.n_tokens ?? 0;
      const durationMs = resp.timings?.restore_ms ?? resp.t_ms ?? 0;
      this.engine.setSavedTokens(sessionId, tokens);
      this.activeSlotSessions.set(targetSlotId, sessionId);

      return {
        slotId: targetSlotId,
        hit: false,
        restored: true,
        tokens,
        durationMs,
      };
    }

    if (!snapExists && tools === undefined) {
      return {
        slotId: targetSlotId,
        hit: false,
        restored: false,
      };
    }

    // 4. If new session (no snapshot on disk), check Golden Base Cache
    // ONLY check/warm if tools are provided (ensures full system prompt + tool schemas are present)
    if (this.config.enableBaseCache && systemPrompt && systemPrompt.length > 0 && tools !== undefined) {
      const targetLive = slots.find((s) => s.id === targetSlotId);
      if (targetLive?.snapshot_filename === BASE_SNAPSHOT_BIN) {
        this.activeSlotSessions.set(targetSlotId, sessionId);
        return {
          slotId: targetSlotId,
          hit: true,
          restored: false,
          isBase: true,
        };
      }

      const baseRes = await this.baseCache.checkAndRestore(systemPrompt, targetSlotId, tools);
      if (baseRes.status === "hit") {
        this.activeSlotSessions.set(targetSlotId, sessionId);
        return {
          slotId: targetSlotId,
          hit: false,
          restored: true,
          isBase: true,
          tokens: baseRes.tokens,
          durationMs: baseRes.durationMs,
        };
      } else if (baseRes.status === "miss") {
        // Auto-warm and snapshot Golden Base on miss (system prompt or tools changed or first run)
        try {
          const warmRes = await this.baseCache.warmAndSave(systemPrompt, baseRes.hash, targetSlotId, tools);
          this.activeSlotSessions.set(targetSlotId, sessionId);
          return {
            slotId: targetSlotId,
            hit: false,
            restored: true,
            isBase: true,
            tokens: warmRes.tokens,
            durationMs: warmRes.durationMs,
          };
        } catch (err) {
          console.warn("[pi-kv-cache-manager] Auto-warming base cache failed, falling back to cold start:", err);
        }
      }
    }

    // 5. If no snapshot and base cache wasn't restored, but target slot had a previous session's snapshot:
    // Erase the slot so stale context does not pollute the new session
    if (chosenSlot && (chosenSlot.snapshot_filename || this.activeSlotSessions.has(targetSlotId))) {
      try {
        await eraseSlot(this.config.llamaServerUrl, targetSlotId);
      } catch {
        // Best effort
      }
    }

    if (tools !== undefined || snapExists) {
      this.activeSlotSessions.set(targetSlotId, sessionId);
    }

    return {
      slotId: targetSlotId,
      hit: false,
      restored: false,
    };
  }
}
