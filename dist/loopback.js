import { lookup } from 'node:dns';
import { request } from 'node:http';
export const lookupLocalhost = () => new Promise((resolve, reject) => {
    lookup('localhost', { all: true, verbatim: true }, (error, addresses) => error ? reject(error) : resolve(addresses));
});
/** OS getaddrinfo itself cannot be cancelled; late answers have no side effects. */
export async function resolveLocalhost(get, signal, timeoutMs = 2000) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new DOMException('DNS deadline exceeded', 'TimeoutError')), timeoutMs);
    let abort = () => { };
    try {
        const addresses = await Promise.race([get(), new Promise((_, reject) => {
                abort = () => reject(combined.reason);
                combined.addEventListener('abort', abort, { once: true });
            })]);
        combined.throwIfAborted();
        if (!addresses.length || addresses.some(a => !((a.address === '127.0.0.1' && a.family === 4) || (a.address === '::1' && a.family === 6)))) {
            throw new Error('Non-loopback or ambiguous localhost DNS');
        }
        return addresses;
    }
    finally {
        clearTimeout(timer);
        combined.removeEventListener('abort', abort);
    }
}
/** Retain the selected hostname/Host header, but pin validated DNS answers for this runtime.
 * Never re-resolve between validation and connection; redirects are never followed.
 */
export function pinnedTransport(addresses) {
    return (async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.protocol !== 'http:' || url.hostname !== 'localhost')
            throw new Error('Pinned transport origin mismatch');
        return new Promise((resolve, reject) => {
            const req = request(url, {
                method: init.method ?? 'GET', headers: init.headers,
                signal: init.signal ?? undefined, autoSelectFamily: true,
                lookup: ((_host, options, callback) => {
                    if (options.all)
                        callback(null, addresses);
                    else
                        callback(null, addresses[0].address, addresses[0].family);
                }),
            }, res => {
                const chunks = [];
                res.on('data', chunk => chunks.push(Buffer.from(chunk)));
                res.on('error', reject);
                res.on('end', () => {
                    if (init.signal?.aborted) {
                        reject(init.signal.reason);
                        return;
                    }
                    const status = res.statusCode ?? 500;
                    if (status >= 300 && status < 400) {
                        reject(new Error('Redirect forbidden'));
                        return;
                    }
                    resolve(new Response(Buffer.concat(chunks).length ? Buffer.concat(chunks) : null, { status }));
                });
            });
            req.on('error', reject);
            req.end(init.body ?? undefined);
        });
    });
}
//# sourceMappingURL=loopback.js.map