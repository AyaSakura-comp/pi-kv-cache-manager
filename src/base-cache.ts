import { boundedFetch, checkCancelled } from "./request.js";
import * as crypto from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { KvManagerConfig, ResourceStamp, SnapshotMetadata } from "./types.js";
import { saveSlot, restoreSlot, eraseSlot, fetchSlots } from "./checkpoint-engine.js";
import { LruManager } from "./lru-manager.js";

export const BASE_SNAPSHOT_BIN = "base_system_prompt.bin";
export const BASE_SNAPSHOT_META = "base_system_prompt.meta.json";
export const BASE_TOOLS_JSON = "base_tools.json";
/** `/kv base-update` from a process that has no live prefix (piweb/Discord run each command in a fresh pi). */
export const GOLDEN_REFRESH_REQUEST = "refresh.request";
const GOLDEN_OBSERVED = "observed.json";
const HEAD_CHARS = 512;
const DAY_MS = 86_400_000;

const RESOURCE_PATTERNS = [/<project_instructions path="([^"]+)">/g, /<location>([^<]+)<\/location>/g];
const unescapeXml = (value: string) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Context files and skills Pi rendered into a system prompt (absolute paths, prompt order). */
export function extractResourcePaths(systemPrompt: string): string[] {
  const found = new Set<string>();
  for (const pattern of RESOURCE_PATTERNS) {
    for (const match of systemPrompt.matchAll(pattern)) {
      const file = unescapeXml(match[1].trim());
      if (path.isAbsolute(file)) found.add(file);
    }
  }
  return [...found];
}

/** The opening of Pi's prompt (identity + tool list) differs for subagents with their own system prompt. */
export function promptHead(systemPrompt: string): string {
  return computeHash(`head:${systemPrompt.slice(0, HEAD_CHARS)}`);
}

export function goldenRefreshRequestPath(cacheDir: string, goldenPrefix: string): string {
  return path.join(cacheDir, `${goldenPrefix}${GOLDEN_REFRESH_REQUEST}`);
}

/** Schedules a golden rebuild for the next new session in `cwd`, which has the exact serialized prefix. */
export async function requestGoldenRefresh(cacheDir: string, goldenPrefix: string, cwd: string): Promise<string> {
  const file = goldenRefreshRequestPath(cacheDir, goldenPrefix);
  await writeJsonAtomic(file, { requestedAt: new Date().toISOString(), cwd });
  return file;
}

async function writeJsonAtomic(file: string, value: unknown, signal?: AbortSignal): Promise<void> {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), { encoding: "utf-8", signal });
    await fs.rename(tmp, file);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await fs.readFile(file, "utf-8")) as T; } catch { return undefined; }
}

const prefixKey = (hash: string, rendered?: string) => `${hash}:${rendered ?? ""}`;

type RefreshReason = "requested" | "resources" | "quorum";
interface PendingRefresh { reason: RefreshReason; hash: string; rendered?: string }
interface Observation { sessions: string[]; firstSeen: number; lastSeen: number }

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
  /** Set when golden was rebuilt into the slot instead of restored. */
  rebuilt?: RefreshReason;
}

export class BaseCacheManager {
  private config: KvManagerConfig;
  private lru: LruManager;
  /** Decided while auditing a request; carried out by the next new session's golden restore. */
  private pendingRefresh?: PendingRefresh;

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

  private refreshRequestPath(): string {
    return goldenRefreshRequestPath(this.config.cacheDir, this.config.goldenPrefix ?? "");
  }

  private async log(record: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify({ ...record, timestamp: new Date().toISOString(), golden: this.getFilename() });
    console.warn(`[pi-kv-cache-manager] ${line}`);
    await fs.appendFile(path.join(this.config.cacheDir, "golden-warnings.jsonl"), `${line}\n`);
  }

  private async stat(file: string): Promise<import("node:fs").Stats | undefined> {
    try { return await fs.stat(file); } catch (error) { checkCancelled(this.config, error); return undefined; }
  }

  /** A stamp is only trusted when the builder loaded the file after its last change. */
  private async stampResources(systemPrompt: string): Promise<ResourceStamp[]> {
    const loadedAt = this.config.extensionLoadedAt ?? 0;
    const stamps: ResourceStamp[] = [];
    for (const file of extractResourcePaths(systemPrompt)) {
      const st = await this.stat(file);
      if (!st) continue;
      stamps.push(Math.max(st.mtimeMs, st.ctimeMs) > loadedAt ? { path: file, mtimeMs: -1, size: -1 }
        : { path: file, mtimeMs: st.mtimeMs, size: st.size });
    }
    return stamps;
  }

  /**
   * Which rendered context files/skills changed since golden was built: edited or deleted golden
   * resources, plus files new to this prompt created after golden (an installed skill).
   * `missing` lists golden resources that still exist but this prompt lacks (a reduced variant).
   */
  private async resourceEvidence(systemPrompt: string, meta: SnapshotMetadata) {
    const current = extractResourcePaths(systemPrompt);
    const createdAt = Date.parse(meta.createdAt) || 0;
    const recorded = new Map((meta.resources ?? []).map(stamp => [stamp.path, stamp]));
    const changed: string[] = [];
    const missing: string[] = [];
    let newest = 0;
    for (const stamp of recorded.values()) {
      const st = await this.stat(stamp.path);
      if (!st) { changed.push(stamp.path); continue; }
      if (!current.includes(stamp.path)) missing.push(stamp.path);
      if (st.mtimeMs !== stamp.mtimeMs || st.size !== stamp.size) {
        changed.push(stamp.path);
        newest = Math.max(newest, st.mtimeMs, st.ctimeMs);
      }
    }
    for (const file of current) {
      if (recorded.has(file)) continue;
      const st = await this.stat(file);
      if (st && Math.max(st.mtimeMs, st.ctimeMs) > createdAt) {
        changed.push(file);
        newest = Math.max(newest, st.mtimeMs, st.ctimeMs);
      }
    }
    return { changed, missing, newest };
  }

  /** Records that `sessionId` sent prefix `key`; returns the vote so far. */
  private async observe(key: string, sessionId: string): Promise<Observation> {
    const file = path.join(this.config.cacheDir, `${this.config.goldenPrefix}${GOLDEN_OBSERVED}`);
    const now = Date.now();
    const store = (await readJson<Record<string, Observation>>(file)) ?? {};
    for (const [key, entry] of Object.entries(store)) if (now - entry.lastSeen > 7 * DAY_MS) delete store[key];
    const entry = store[key] ?? { sessions: [], firstSeen: now, lastSeen: now };
    if (!entry.sessions.includes(sessionId)) entry.sessions = [...entry.sessions, sessionId].slice(-8);
    entry.lastSeen = now;
    store[key] = entry;
    for (const stale of Object.keys(store).sort((a, b) => store[b].lastSeen - store[a].lastSeen).slice(32)) delete store[stale];
    await writeJsonAtomic(file, store, this.config.signal);
    return entry;
  }

  /**
   * Silent refresh policy (canonical cwd, same extension set). The prompt must open like golden and
   * keep every golden resource, so subagents and reduced variants never replace it. Then either a
   * rendered context file/skill changed and this worker loaded it afterwards, or two sessions sent
   * the same new prefix that was never golden before.
   */
  private async planRefresh(systemPrompt: string, hash: string, meta: SnapshotMetadata, mismatch: boolean,
    extensionsChanged: boolean, sessionId?: string): Promise<PendingRefresh | undefined> {
    const rendered = this.config.renderedPrefixHash;
    const request = await readJson<{ cwd?: string }>(this.refreshRequestPath());
    if (request && request.cwd === this.config.goldenCwd) return { reason: "requested", hash, rendered };
    if (!mismatch || extensionsChanged || meta.canonicalCwd !== this.config.goldenCwd) return undefined;
    if (meta.headHash && meta.headHash !== promptHead(systemPrompt)) return undefined;
    const evidence = await this.resourceEvidence(systemPrompt, meta);
    if (evidence.missing.length > 0) return undefined;
    if (evidence.changed.length > 0 && (this.config.extensionLoadedAt ?? 0) > evidence.newest) {
      return { reason: "resources", hash, rendered };
    }
    const key = prefixKey(hash, rendered);
    if (!sessionId || (meta.retired ?? []).includes(key)) return undefined;
    const vote = await this.observe(key, sessionId);
    return vote.sessions.length >= 2 && vote.firstSeen > (Date.parse(meta.createdAt) || 0)
      ? { reason: "quorum", hash, rendered } : undefined;
  }

  /**
   * Audit every request. A loaded-extension change or explicit update replaces golden now; a context
   * file/skill edit, a repeated new prefix or a scheduled `/kv base-update` is carried out silently
   * by the next new session's golden restore (see checkAndRestore).
   */
  async ensureGolden(systemPrompt: string, tools: unknown[], force = false, options: { sessionId?: string } = {}): Promise<void> {
    if ((!this.config.enableBaseCache && !force) || !this.config.goldenPrefix) return;
    await this.withGoldenLock(async () => {
      await this.config.assertCurrent?.();
      this.pendingRefresh = undefined;
      const meta = await this.getBaseMetadata();
      const hash = computeHash(systemPrompt, tools);
      const mismatch = !!meta && (meta.promptPrefixHash !== hash || meta.renderedPrefixHash !== this.config.renderedPrefixHash);
      const changed = !!meta && !!this.config.extensionsFingerprint && meta.extensionsFingerprint !== this.config.extensionsFingerprint;
      const canUpdate = changed && meta?.canonicalCwd === this.config.goldenCwd &&
        (this.config.extensionLoadedAt ?? 0) > (meta?.extensionLoadedAt ?? 0);
      let present = false;
      try { await fs.access(this.getBinPath()); present = true; } catch (error) { checkCancelled(this.config, error); }
      const deferred = meta && present && !force && !canUpdate;
      if (deferred) this.pendingRefresh = await this.planRefresh(systemPrompt, hash, meta, mismatch, changed, options.sessionId);
      if (mismatch || changed) {
        await this.log({ type: "golden_mismatch",
          expectedHash: meta?.promptPrefixHash, actualHash: hash,
          expectedRenderedHash: meta?.renderedPrefixHash, actualRenderedHash: this.config.renderedPrefixHash,
          expectedExtensions: meta?.extensionsFingerprint, actualExtensions: this.config.extensionsFingerprint,
          canonicalCwd: meta?.canonicalCwd, cwd: this.config.goldenCwd,
          action: !deferred ? "update" : this.pendingRefresh ? `refresh-next-session:${this.pendingRefresh.reason}` : "preserve" });
      }
      if (deferred) return;
      await this.rebuild(systemPrompt, tools, hash, { reason: force ? "explicit" : !meta ? "cold" : canUpdate ? "extensions" : "missing-binary" });
    });
  }

  /**
   * Warm, save and publish a new golden (caller holds the golden lock). `seed` restores the current
   * golden into `slotId` first, so llama-server re-prefills only the changed suffix of the prefix.
   */
  private async rebuild(systemPrompt: string, tools: unknown[], hash: string,
    options: { reason: string; slotId?: number; seed?: boolean }): Promise<{ tokens: number; durationMs: number }> {
    const started = Date.now();
    const previous = await this.getBaseMetadata();
    let seed: string | undefined;
    if (options.seed && previous) {
      try { await fs.access(this.getBinPath()); seed = this.getFilename(); } catch (error) { checkCancelled(this.config, error); }
    }
    // A unique staging snapshot keeps the previous golden usable if warm/save fails.
    const prefix = `${this.config.goldenPrefix}build_${crypto.randomUUID()}_`;
    const stageConfig = { ...this.config, goldenPrefix: undefined, snapshotPrefix: prefix };
    const stage = new BaseCacheManager(stageConfig, new LruManager(this.config.cacheDir, prefix, this.config.signal));
    const suffixes = ["", ".dft", ".ckpt", ".media.json"];
    const backups: Array<{ target: string; backup: string }> = [];
    const installed: string[] = [];
    let committed = false;
    let tokens = 0;
    let seeded = false;
    try {
      seeded = (await stage.warmAndSave(systemPrompt, hash, options.slotId, tools, seed)).seeded;
      const saved = await stage.getBaseMetadata();
      if (!saved || saved.tokenCount <= 0) throw new Error("Golden staging metadata unavailable");
      tokens = saved.tokenCount;
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
      const key = prefixKey(hash, this.config.renderedPrefixHash);
      const retired = previous ? [prefixKey(previous.promptPrefixHash, previous.renderedPrefixHash), ...(previous.retired ?? [])]
        .filter((k, i, all) => k !== key && all.indexOf(k) === i).slice(0, 8) : [];
      const published: SnapshotMetadata = { ...saved, namespace: this.config.goldenPrefix, canonicalCwd: this.config.goldenCwd,
        renderedPrefixHash: this.config.renderedPrefixHash, extensionsFingerprint: this.config.extensionsFingerprint,
        extensionLoadedAt: this.config.extensionLoadedAt, headHash: promptHead(systemPrompt),
        resources: await this.stampResources(systemPrompt), retired, refreshReason: options.reason };
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
    const request = await readJson<{ cwd?: string }>(this.refreshRequestPath());
    if (request && request.cwd === this.config.goldenCwd) await fs.unlink(this.refreshRequestPath()).catch(() => {});
    const durationMs = Date.now() - started;
    await this.log({ type: "golden_refreshed", reason: options.reason, seeded, slot: options.slotId, tokens, durationMs,
      promptHash: hash, renderedHash: this.config.renderedPrefixHash, cwd: this.config.goldenCwd });
    return { tokens, durationMs };
  }

  /** Carry out the refresh planned for this prefix, unless another worker already published it. */
  private async performPendingRefresh(systemPrompt: string, slotId: number, tools?: unknown[]): Promise<BaseCacheRestoreResult | undefined> {
    const pending = this.pendingRefresh;
    this.pendingRefresh = undefined;
    if (!pending) return undefined;
    const effectiveTools = tools ?? await this.loadCachedTools() ?? [];
    const hash = computeHash(systemPrompt, effectiveTools);
    if (hash !== pending.hash || this.config.renderedPrefixHash !== pending.rendered) return undefined;
    const meta = await this.getBaseMetadata();
    if (meta && meta.promptPrefixHash === hash && meta.renderedPrefixHash === pending.rendered) {
      // Already current (another worker refreshed it, or base-update found nothing stale). A seeded
      // warm of an identical prompt is not even cheap: llama-server must re-evaluate the last token,
      // cannot truncate recurrent state in place and re-prefills everything.
      if (pending.reason === "requested") {
        await fs.unlink(this.refreshRequestPath()).catch(() => {});
        await this.log({ type: "golden_refresh_skipped", reason: pending.reason, why: "golden already matches this prefix",
          promptHash: hash, cwd: this.config.goldenCwd });
      }
      return undefined;
    }
    try {
      const result = await this.rebuild(systemPrompt, effectiveTools, hash, { reason: pending.reason, slotId, seed: true });
      return { status: "hit", hash, tokens: result.tokens, durationMs: result.durationMs, rebuilt: pending.reason };
    } catch (error) {
      checkCancelled(this.config, error);
      console.warn(`[pi-kv-cache-manager] Golden refresh failed; previous golden preserved: ${String(error)}`);
      return undefined;
    }
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
      return this.withGoldenLock(async () =>
        await this.performPendingRefresh(systemPrompt, slotId, tools) ?? this.restoreBase(systemPrompt, slotId, tools));
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
   * and cleanly erases the slot before prefilling (or restores `seedFilename` into it instead).
   */
  async warmAndSave(
    systemPrompt: string,
    hash: string,
    preferredSlotId?: number,
    tools?: unknown[],
    seedFilename?: string
  ): Promise<{ tokens: number; durationMs: number; bytes: number; slotId: number; seeded: boolean }> {
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

    // 3. Start from the previous golden when seeding: llama-server keeps the common token prefix
    // (restoring a context checkpoint) and prefills only the changed suffix. Restore, like erase,
    // first saves any unsaved owner state of the slot. Otherwise erase for a pure, clean prefill.
    let seeded = false;
    if (seedFilename) {
      try {
        await restoreSlot(this.config.llamaServerUrl, targetSlot, seedFilename, this.config);
        seeded = true;
      } catch (error) {
        checkCancelled(this.config, error);
      }
    }
    if (!seeded) {
      try {
        await eraseSlot(this.config.llamaServerUrl, targetSlot, this.config);
      } catch (error) {
        checkCancelled(this.config, error);
        // Ignore if slot was already clean
      }
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
      seeded,
    };
  }
}
