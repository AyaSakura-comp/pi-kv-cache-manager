import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { KvManagerConfig, SnapshotMetadata } from "./types.js";

export interface SnapshotItem {
  meta: SnapshotMetadata;
  binFilename: string;
  binPath: string;
  metaPath: string;
}

export class LruManager {
  private cacheDir: string;
  private evictionsCount: number = 0;

  constructor(cacheDir: string, private namespace = "", private signal?: AbortSignal) {
    this.cacheDir = cacheDir;
  }

  async invalidateSnapshot(filename: string): Promise<void> {
    // Tombstone before an overwrite: a failed/stale save must not inherit old valid metadata.
    this.signal?.throwIfAborted();
    await fs.writeFile(path.join(this.cacheDir, filename.replace(/\.bin$/, ".meta.json")), '{"pending":true}', "utf8");
  }

  getEvictionsCount(): number {
    return this.evictionsCount;
  }

  async readMetadata(metaPath: string, matchNamespace = true): Promise<SnapshotMetadata | null> {
    try {
      const data = await fs.readFile(metaPath, "utf-8");
      const meta = JSON.parse(data);
      if (meta.pending) return null;
      // Cross-namespace inspection must still prove extension ownership. A
      // metadata file next to a legacy/foreign binary is not permission to evict it.
      if (!matchNamespace && (typeof meta.namespace !== "string" ||
          !/^(?:kv2|golden)_[a-zA-Z0-9_-]+_$/.test(meta.namespace) ||
          !path.basename(metaPath).startsWith(meta.namespace))) return null;
      if (matchNamespace && this.namespace) {
        if (meta.namespace !== this.namespace || !path.basename(metaPath).startsWith(this.namespace)) {
          return null;
        }
      }
      return meta as SnapshotMetadata;
    } catch {
      return null;
    }
  }

  async writeMetadata(metaPath: string, meta: SnapshotMetadata): Promise<void> {
    try {
      const tmpPath = `${metaPath}.tmp.${Date.now()}`;
      this.signal?.throwIfAborted();
      await fs.writeFile(tmpPath, JSON.stringify({ ...meta, namespace: this.namespace }, null, 2), "utf-8");
      this.signal?.throwIfAborted();
      await fs.rename(tmpPath, metaPath);
    } catch (err) {
      console.error(`[pi-kv-cache-manager] Failed to write metadata to ${metaPath}:`, err);
    }
  }

  async touchSnapshot(filename: string): Promise<void> {
    const metaFilename = filename.endsWith(".bin")
      ? filename.replace(/\.bin$/, ".meta.json")
      : `${filename}.meta.json`;
    const metaPath = path.join(this.cacheDir, metaFilename);

    const meta = await this.readMetadata(metaPath);
    if (meta) {
      meta.lastAccessedAt = new Date().toISOString();
      await this.writeMetadata(metaPath, meta);
    }
  }

  async listSnapshots(allNamespaces = false): Promise<SnapshotItem[]> {
    const items: SnapshotItem[] = [];
    try {
      const files = await fs.readdir(this.cacheDir);
      for (const file of files) {
        const matches = allNamespaces
          ? file.endsWith(".meta.json")
          : file.startsWith(this.namespace) && file.endsWith(".meta.json");
        if (matches) {
          const metaPath = path.join(this.cacheDir, file);
          const binFilename = file.replace(/\.meta\.json$/, ".bin");
          const binPath = path.join(this.cacheDir, binFilename);

          const meta = await this.readMetadata(metaPath, !allNamespaces);
          if (meta) {
            // Check if the binary exists and account for all server-owned sidecars.
            try {
              const stat = await fs.stat(binPath);
              let snapshotBytes = stat.size;
              for (const suffix of [".dft", ".ckpt", ".media.json"]) {
                try {
                  snapshotBytes += (await fs.stat(`${binPath}${suffix}`)).size;
                } catch {
                  // Optional sidecar is absent.
                }
              }
              meta.fileSizeBytes = snapshotBytes;
              items.push({ meta, binFilename, binPath, metaPath });
            } catch {
              // Missing/inaccessible binaries are not proof of an orphan. Never delete on inspection.
            }
          }
        }
      }
    } catch (err) {
      console.error(`[pi-kv-cache-manager] Error reading cache dir ${this.cacheDir}:`, err);
    }
    return items;
  }

  /**
   * Enforces LRU eviction based on maxSessions and maxDiskUsageGb.
   * Golden base cache (base_system_prompt.bin) is always preserved.
   * Global disk usage is checked across all namespaces in cacheDir.
   */
  async enforceLRU(config: KvManagerConfig): Promise<{ prunedFiles: string[]; freedBytes: number }> {
    const allGlobal = await this.listSnapshots(true);
    const prunedFiles: string[] = [];
    let freedBytes = 0;

    const isBase = (item: SnapshotItem) =>
      item.meta.isBaseSnapshot || item.binFilename.endsWith("base_system_prompt.bin");

    const evict = async (item: SnapshotItem) => {
      this.signal?.throwIfAborted();
      await fs.unlink(item.binPath);
      for (const suffix of [".media.json", ".dft", ".ckpt"]) {
        this.signal?.throwIfAborted();
        await fs.unlink(`${item.binPath}${suffix}`).catch(() => {});
      }
      this.signal?.throwIfAborted();
      await fs.unlink(item.metaPath);
      prunedFiles.push(item.binFilename);
      freedBytes += item.meta.fileSizeBytes;
      this.evictionsCount++;
    };

    // 1. Enforce maxSessions for the active namespace
    const currentSessions = allGlobal.filter(
      (item) => !isBase(item) && (this.namespace ? item.binFilename.startsWith(this.namespace) : true)
    );
    currentSessions.sort((a, b) => {
      const timeA = Date.parse(a.meta.lastAccessedAt || a.meta.createdAt || "0");
      const timeB = Date.parse(b.meta.lastAccessedAt || b.meta.createdAt || "0");
      return timeA - timeB;
    });

    const evictedFiles = new Set<string>();
    while (currentSessions.length > config.maxSessions) {
      const oldest = currentSessions.shift();
      if (!oldest) break;
      try {
        await evict(oldest);
        evictedFiles.add(oldest.binFilename);
      } catch (err) {
        console.error(`[pi-kv-cache-manager] Error evicting snapshot ${oldest.binFilename}:`, err);
      }
    }

    // 2. Enforce global maxDiskUsageGb across all namespaces
    const remainingGlobal = allGlobal.filter((item) => !evictedFiles.has(item.binFilename));
    let totalBytes = remainingGlobal.reduce((acc, item) => acc + item.meta.fileSizeBytes, 0);
    const maxBytes = config.maxDiskUsageGb * 1024 * 1024 * 1024;

    if (totalBytes > maxBytes) {
      const evictableGlobal = remainingGlobal.filter((item) => !isBase(item));
      // Sort ascending by lastAccessedAt (oldest across all namespaces first)
      evictableGlobal.sort((a, b) => {
        const timeA = Date.parse(a.meta.lastAccessedAt || a.meta.createdAt || "0");
        const timeB = Date.parse(b.meta.lastAccessedAt || b.meta.createdAt || "0");
        return timeA - timeB;
      });

      while (evictableGlobal.length > 0 && totalBytes > maxBytes) {
        const oldest = evictableGlobal.shift();
        if (!oldest) break;
        try {
          await evict(oldest);
          totalBytes -= oldest.meta.fileSizeBytes;
        } catch (err) {
          console.error(`[pi-kv-cache-manager] Error evicting global snapshot ${oldest.binFilename}:`, err);
        }
      }
    }

    return { prunedFiles, freedBytes };
  }

  static formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  }
}
