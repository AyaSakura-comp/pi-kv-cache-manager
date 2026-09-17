import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { type ResolvedRuntime } from "./runtime.js";
export interface RuntimeDependencies {
    resolve?: (baseUrl: string, io?: {
        signal?: AbortSignal;
    }) => Promise<ResolvedRuntime>;
    loadConfig?: typeof loadConfig;
}
export default function piKvCacheManager(pi: ExtensionAPI, dependencies?: RuntimeDependencies): void;
//# sourceMappingURL=index.d.ts.map