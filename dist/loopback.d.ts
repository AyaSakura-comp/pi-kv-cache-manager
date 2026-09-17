export type Address = {
    address: string;
    family: number;
};
export type Lookup = () => Promise<Address[]>;
export declare const lookupLocalhost: Lookup;
/** OS getaddrinfo itself cannot be cancelled; late answers have no side effects. */
export declare function resolveLocalhost(get: Lookup, signal?: AbortSignal, timeoutMs?: number): Promise<Address[]>;
/** Retain the selected hostname/Host header, but pin validated DNS answers for this runtime.
 * Never re-resolve between validation and connection; redirects are never followed.
 */
export declare function pinnedTransport(addresses: Address[]): typeof fetch;
//# sourceMappingURL=loopback.d.ts.map