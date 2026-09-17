/** Deadline remains armed until the entire response body has been consumed. */
export async function boundedFetch(url, init = {}, options = {}, prefill = false) {
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const timeout = prefill ? options.prefillTimeoutMs ?? 300_000 : options.controlTimeoutMs ?? 5_000;
    const timer = setTimeout(() => {
        const reason = new DOMException('KV request deadline exceeded', 'TimeoutError');
        controller.abort(reason);
        options.abortRuntime?.(reason);
    }, timeout);
    try {
        const response = await (options.transport ?? fetch)(url, { ...init, redirect: 'error', signal });
        const body = await response.text();
        signal.throwIfAborted();
        return new Response(body || null, { status: response.status, statusText: response.statusText });
    }
    finally {
        clearTimeout(timer);
    }
}
export function checkCancelled(options, error) {
    options.signal?.throwIfAborted();
    if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
        throw error;
}
//# sourceMappingURL=request.js.map