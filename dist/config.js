import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
const DEFAULT_CACHE_DIR = path.join(os.homedir(), ".cache", "llama-slots");
export const DEFAULT_CONFIG = {
    llamaServerUrl: process.env.LLAMA_BASE_URL || "http://127.0.0.1:8001",
    slotId: 0,
    cacheDir: process.env.LLAMA_SLOT_SAVE_PATH || DEFAULT_CACHE_DIR,
    maxSessions: 30,
    maxDiskUsageGb: 40,
    minTokensThreshold: 3000,
    stepTokensIncrement: 3000,
    enableBaseCache: true,
    enableIncrementalSave: true,
};
/**
 * Load user configuration from settings.json if present, merged with defaults.
 */
export function loadConfig(cwd) {
    let userConfig = {};
    const globalSettingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
    const localSettingsPath = cwd ? path.join(cwd, ".pi", "settings.json") : undefined;
    for (const p of [globalSettingsPath, localSettingsPath]) {
        if (p && fs.existsSync(p)) {
            try {
                const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
                if (raw.kvCache && typeof raw.kvCache === "object") {
                    userConfig = { ...userConfig, ...raw.kvCache };
                }
            }
            catch {
                // Ignore JSON syntax errors in user config, use defaults
            }
        }
    }
    const merged = {
        ...DEFAULT_CONFIG,
        ...userConfig,
    };
    // Ensure cache directory exists
    if (!fs.existsSync(merged.cacheDir)) {
        try {
            fs.mkdirSync(merged.cacheDir, { recursive: true });
        }
        catch {
            // Best-effort directory creation
        }
    }
    return merged;
}
//# sourceMappingURL=config.js.map