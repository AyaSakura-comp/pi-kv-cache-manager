export interface RequestOptions {
    signal?: AbortSignal;
    controlTimeoutMs?: number;
    prefillTimeoutMs?: number;
    transport?: typeof fetch;
    abortRuntime?: (reason: unknown) => void;
}
/** Deadline remains armed until the entire response body has been consumed. */
export declare function boundedFetch(url: string, init?: RequestInit, options?: RequestOptions, prefill?: boolean): Promise<Response>;
export declare function checkCancelled(options: RequestOptions, error?: unknown): void;
//# sourceMappingURL=request.d.ts.map