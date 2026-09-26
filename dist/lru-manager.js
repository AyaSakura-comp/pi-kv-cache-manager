import * as fs from "node:fs/promises";
import * as path from "node:path";
export class LruManager {
    namespace;
    signal;
    cacheDir;
    evictionsCount = 0;
    constructor(cacheDir, namespace = "", signal) {
        this.namespace = namespace;
        this.signal = signal;
        this.cacheDir = cacheDir;
    }
    async invalidateSnapshot(filename) {
        // Tombstone before an overwrite: a failed/stale save must not inherit old valid metadata.
        this.signal?.throwIfAborted();
        await fs.writeFile(path.join(this.cacheDir, filename.replace(/\.bin$/, ".meta.json")), '{"pending":true}', "utf8");
    }
    getEvictionsCount() {
        return this.evictionsCount;
    }
    async readMetadata(metaPath) {
        try {
            const data = await fs.readFile(metaPath, "utf-8");
            const meta = JSON.parse(data);
            if (meta.pending || (this.namespace && (meta.namespace !== this.namespace || !path.basename(metaPath).startsWith(this.namespace))))
                return null;
            return meta;
        }
        catch {
            return null;
        }
    }
    async writeMetadata(metaPath, meta) {
        try {
            const tmpPath = `${metaPath}.tmp.${Date.now()}`;
            this.signal?.throwIfAborted();
            await fs.writeFile(tmpPath, JSON.stringify({ ...meta, namespace: this.namespace }, null, 2), "utf-8");
            this.signal?.throwIfAborted();
            await fs.rename(tmpPath, metaPath);
        }
        catch (err) {
            console.error(`[pi-kv-cache-manager] Failed to write metadata to ${metaPath}:`, err);
        }
    }
    async touchSnapshot(filename) {
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
    async listSnapshots() {
        const items = [];
        try {
            const files = await fs.readdir(this.cacheDir);
            for (const file of files) {
                if (file.startsWith(this.namespace) && file.endsWith(".meta.json")) {
                    const metaPath = path.join(this.cacheDir, file);
                    const binFilename = file.replace(/\.meta\.json$/, ".bin");
                    const binPath = path.join(this.cacheDir, binFilename);
                    const meta = await this.readMetadata(metaPath);
                    if (meta) {
                        // Check if the binary exists and account for all server-owned sidecars.
                        try {
                            const stat = await fs.stat(binPath);
                            let snapshotBytes = stat.size;
                            for (const suffix of [".dft", ".ckpt", ".media.json"]) {
                                try {
                                    snapshotBytes += (await fs.stat(`${binPath}${suffix}`)).size;
                                }
                                catch {
                                    // Optional sidecar is absent.
                                }
                            }
                            meta.fileSizeBytes = snapshotBytes;
                            items.push({ meta, binFilename, binPath, metaPath });
                        }
                        catch {
                            // Missing/inaccessible binaries are not proof of an orphan. Never delete on inspection.
                        }
                    }
                }
            }
        }
        catch (err) {
            console.error(`[pi-kv-cache-manager] Error reading cache dir ${this.cacheDir}:`, err);
        }
        return items;
    }
    /**
     * Enforces LRU eviction based on maxSessions and maxDiskUsageGb.
     * Golden base cache (base_system_prompt.bin) is always preserved.
     */
    async enforceLRU(config) {
        const all = await this.listSnapshots();
        const prunedFiles = [];
        let freedBytes = 0;
        // Filter out Golden Base snapshots
        const sessions = all.filter((item) => !item.meta.isBaseSnapshot && item.binFilename !== "base_system_prompt.bin");
        // Calculate total disk usage
        let totalBytes = all.reduce((acc, item) => acc + item.meta.fileSizeBytes, 0);
        const maxBytes = config.maxDiskUsageGb * 1024 * 1024 * 1024;
        // Sort sessions ascending by lastAccessedAt (oldest first)
        sessions.sort((a, b) => {
            const timeA = Date.parse(a.meta.lastAccessedAt || a.meta.createdAt || "0");
            const timeB = Date.parse(b.meta.lastAccessedAt || b.meta.createdAt || "0");
            return timeA - timeB;
        });
        while (sessions.length > 0 &&
            (sessions.length > config.maxSessions || totalBytes > maxBytes)) {
            const oldest = sessions.shift();
            if (!oldest)
                break;
            try {
                this.signal?.throwIfAborted();
                await fs.unlink(oldest.binPath);
                for (const suffix of [".media.json", ".dft", ".ckpt"]) {
                    this.signal?.throwIfAborted();
                    await fs.unlink(`${oldest.binPath}${suffix}`).catch(() => { });
                }
                this.signal?.throwIfAborted();
                await fs.unlink(oldest.metaPath);
                prunedFiles.push(oldest.binFilename);
                freedBytes += oldest.meta.fileSizeBytes;
                totalBytes -= oldest.meta.fileSizeBytes;
                this.evictionsCount++;
            }
            catch (err) {
                console.error(`[pi-kv-cache-manager] Error evicting snapshot ${oldest.binFilename}:`, err);
            }
        }
        return { prunedFiles, freedBytes };
    }
    static formatBytes(bytes) {
        if (bytes === 0)
            return "0 B";
        const k = 1024;
        const sizes = ["B", "KB", "MB", "GB", "TB"];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
    }
}
//# sourceMappingURL=lru-manager.js.map