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

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
  }

  getEvictionsCount(): number {
    return this.evictionsCount;
  }

  async readMetadata(metaPath: string): Promise<SnapshotMetadata | null> {
    try {
      const data = await fs.readFile(metaPath, "utf-8");
      return JSON.parse(data) as SnapshotMetadata;
    } catch {
      return null;
    }
  }

  async writeMetadata(metaPath: string, meta: SnapshotMetadata): Promise<void> {
    try {
      const tmpPath = `${metaPath}.tmp.${Date.now()}`;
      await fs.writeFile(tmpPath, JSON.stringify(meta, null, 2), "utf-8");
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

  async listSnapshots(): Promise<SnapshotItem[]> {
    const items: SnapshotItem[] = [];
    try {
      const files = await fs.readdir(this.cacheDir);
      for (const file of files) {
        if (file.endsWith(".meta.json")) {
          const metaPath = path.join(this.cacheDir, file);
          const binFilename = file.replace(/\.meta\.json$/, ".bin");
          const binPath = path.join(this.cacheDir, binFilename);

          const meta = await this.readMetadata(metaPath);
          if (meta) {
            // Check if bin file actually exists on disk
            try {
              const stat = await fs.stat(binPath);
              meta.fileSizeBytes = stat.size;
              items.push({ meta, binFilename, binPath, metaPath });
            } catch {
              // Orphaned metadata file without corresponding .bin
              await fs.unlink(metaPath).catch(() => {});
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
   */
  async enforceLRU(config: KvManagerConfig): Promise<{ prunedFiles: string[]; freedBytes: number }> {
    const all = await this.listSnapshots();
    const prunedFiles: string[] = [];
    let freedBytes = 0;

    // Filter out Golden Base snapshots
    const sessions = all.filter(
      (item) => !item.meta.isBaseSnapshot && item.binFilename !== "base_system_prompt.bin"
    );

    // Calculate total disk usage
    let totalBytes = all.reduce((acc, item) => acc + item.meta.fileSizeBytes, 0);
    const maxBytes = config.maxDiskUsageGb * 1024 * 1024 * 1024;

    // Sort sessions ascending by lastAccessedAt (oldest first)
    sessions.sort((a, b) => {
      const timeA = Date.parse(a.meta.lastAccessedAt || a.meta.createdAt || "0");
      const timeB = Date.parse(b.meta.lastAccessedAt || b.meta.createdAt || "0");
      return timeA - timeB;
    });

    while (
      sessions.length > 0 &&
      (sessions.length > config.maxSessions || totalBytes > maxBytes)
    ) {
      const oldest = sessions.shift();
      if (!oldest) break;

      try {
        await fs.unlink(oldest.binPath);
        await fs.unlink(oldest.metaPath);
        prunedFiles.push(oldest.binFilename);
        freedBytes += oldest.meta.fileSizeBytes;
        totalBytes -= oldest.meta.fileSizeBytes;
        this.evictionsCount++;
      } catch (err) {
        console.error(`[pi-kv-cache-manager] Error evicting snapshot ${oldest.binFilename}:`, err);
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
