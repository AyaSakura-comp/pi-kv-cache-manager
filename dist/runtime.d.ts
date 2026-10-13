import { type Lookup } from "./loopback.js";
export interface ResolvedRuntime {
    serverUrl: string;
    cacheDir: string;
    identity: string;
    generation: string;
    transport?: typeof fetch;
}
export interface DiscoveryIO {
    procRoot?: string;
    signal?: AbortSignal;
    lookup?: Lookup;
    dnsTimeoutMs?: number;
    transport?: typeof fetch;
    listener?: (port: number) => Promise<string>;
    json?: (url: string) => Promise<any>;
}
/**
 * llama-server answers /props and /lora-adapters from its main loop, so they queue behind
 * whatever the loop is doing (a 2048-token ubatch, a 2-3 s image encode). A 2 s deadline
 * timed out under load; the TimeoutError was treated as cancellation and silently discarded
 * finished golden warms and slot bindings. A dead server still fails within this bound.
 */
export declare const DISCOVERY_TIMEOUT_MS = 30000;
/** Only direct, same-namespace Linux listeners are supported. No pgrep or shell. */
export declare function resolveRuntime(baseUrl: string, io?: DiscoveryIO): Promise<ResolvedRuntime>;
/** One queue covers provider activation, saves, commands and shutdown. No detached jobs. */
export declare class RuntimeQueue {
    private tail;
    run<T>(job: () => Promise<T>): Promise<T>;
}
/**
 * resolveRuntime() spawns `ss`, reads /proc and makes two HTTP calls (~0.1 s) and
 * ran several times per request. Reuse a verified result while the same listener
 * process is alive (pid + start time from /proc) and its LoRA adapters are
 * unchanged; anything else, or 60 s, re-runs the full verification.
 */
export declare function cachedRuntimeResolver(resolve?: typeof resolveRuntime, ttlMs?: number, procRoot?: string, now?: () => number): (baseUrl: string, io?: DiscoveryIO) => Promise<ResolvedRuntime>;
//# sourceMappingURL=runtime.d.ts.map