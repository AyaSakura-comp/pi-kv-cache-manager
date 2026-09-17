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
/** Only direct, same-namespace Linux listeners are supported. No pgrep or shell. */
export declare function resolveRuntime(baseUrl: string, io?: DiscoveryIO): Promise<ResolvedRuntime>;
/** One queue covers provider activation, saves, commands and shutdown. No detached jobs. */
export declare class RuntimeQueue {
    private tail;
    run<T>(job: () => Promise<T>): Promise<T>;
}
//# sourceMappingURL=runtime.d.ts.map