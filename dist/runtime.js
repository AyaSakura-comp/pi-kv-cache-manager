import { boundedFetch } from "./request.js";
import { lookupLocalhost, resolveLocalhost, pinnedTransport } from "./loopback.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { computeHash, stableStringify } from "./base-cache.js";
const exec = promisify(execFile);
function argument(argv, names) {
    const values = [];
    for (let i = 1; i < argv.length; i++) {
        for (const name of names) {
            if (argv[i] === name)
                values.push(argv[i + 1]);
            else if (argv[i].startsWith(name + "="))
                values.push(argv[i].slice(name.length + 1));
        }
    }
    if (values.length > 1 || values.some(v => !v || v.startsWith("--")))
        throw new Error("Ambiguous server arguments");
    return values[0];
}
async function fileIdentity(filename) {
    const real = await fs.realpath(filename);
    const stat = await fs.stat(real, { bigint: true });
    if (!stat.isFile())
        throw new Error("Expected a local regular file");
    return [real, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
}
/** Only direct, same-namespace Linux listeners are supported. No pgrep or shell. */
export async function resolveRuntime(baseUrl, io = {}) {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash || !["", "/", "/v1", "/v1/"].includes(url.pathname)) {
        throw new Error("Persistent KV requires a direct verified loopback HTTP endpoint");
    }
    io.signal?.throwIfAborted();
    const addresses = url.hostname === "localhost" ? await resolveLocalhost(io.lookup ?? lookupLocalhost, io.signal, io.dnsTimeoutMs) : undefined;
    const transport = io.transport ?? (addresses ? pinnedTransport(addresses) : undefined);
    const port = Number(url.port || 80);
    const proc = io.procRoot ?? "/proc";
    const listener = io.listener ?? (async (p) => (await exec("ss", ["-H", "-ltnpe", `sport = :${p}`], {
        timeout: 1500, maxBuffer: 65536, signal: io.signal,
    })).stdout);
    const inspect = async () => {
        const lines = (await listener(port)).trim().split("\n").filter(Boolean);
        // A second listener, even inaccessible, makes ownership ambiguous.
        if (lines.length !== 1)
            throw new Error("Listener ownership unavailable or ambiguous");
        const line = lines[0];
        const local = line.trim().split(/\s+/)[3];
        io.signal?.throwIfAborted();
        const allowed = addresses ? addresses.flatMap(a => a.family === 4 ? ["127.0.0.1", "0.0.0.0"] : ["[::1]", "[::]"]) :
            url.hostname === "127.0.0.1" ? ["127.0.0.1", "0.0.0.0"] : ["[::1]", "[::]"];
        if (!allowed.some(a => local === `${a}:${port}`))
            throw new Error("Listener address/port mismatch");
        const owners = [...line.matchAll(/pid=(\d+),fd=(\d+)/g)];
        const inode = /\bino:(\d+)\b/.exec(line)?.[1];
        if (owners.length !== 1 || !inode)
            throw new Error("Listener owner unavailable");
        const [, pid, fd] = owners[0];
        const dir = path.join(proc, pid);
        if (await fs.readlink(path.join(dir, "fd", fd)) !== `socket:[${inode}]`)
            throw new Error("Listener fd mismatch");
        for (const ns of ["net", "mnt"]) {
            if (await fs.readlink(path.join(dir, "ns", ns)) !== await fs.readlink(path.join(proc, "self", "ns", ns))) {
                throw new Error("Server is in another namespace");
            }
        }
        if (await fs.realpath(path.join(dir, "root")) !== await fs.realpath(path.join(proc, "self", "root"))) {
            throw new Error("Server has a different filesystem root");
        }
        const exe = await fs.readlink(path.join(dir, "exe"));
        if (path.basename(exe) !== "llama-server")
            throw new Error("Listener is not llama-server");
        const argv = (await fs.readFile(path.join(dir, "cmdline"), "utf8")).split("\0").filter(Boolean);
        const cwd = await fs.readlink(path.join(dir, "cwd"));
        const stat = await fs.readFile(path.join(dir, "stat"), "utf8");
        const start = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
        if (!start)
            throw new Error("Missing process start identity");
        const env = (await fs.readFile(path.join(dir, "environ"), "utf8")).split("\0")
            .filter(v => /^(LLAMA_ARG_|GGML_|CUDA_|HIP_|ROCR_)/.test(v)).sort();
        const folder = argument(argv, ["--slot-save-path"]);
        if (!folder)
            throw new Error("Server --slot-save-path is not explicit");
        const cacheDir = await fs.realpath(path.resolve(cwd, folder));
        if (!(await fs.stat(cacheDir)).isDirectory())
            throw new Error("Snapshot path is not a directory");
        return { pid, start, inode, argv, cwd, env, cacheDir, executable: await fileIdentity(exe) };
    };
    const before = await inspect();
    const serverUrl = url.origin;
    const get = io.json ?? (async (url) => {
        const res = await boundedFetch(url, {}, { signal: io.signal, controlTimeoutMs: 2000, transport });
        if (!res.ok)
            throw new Error(`Discovery HTTP ${res.status}`);
        return res.json();
    });
    const props = await get(`${serverUrl}/props`);
    const adapters = await get(`${serverUrl}/lora-adapters`);
    if (typeof props?.model_path !== "string" || !props.model_path || !Array.isArray(adapters)) {
        throw new Error("Server model/adapter identity unavailable");
    }
    const modelPath = path.resolve(before.cwd, props.model_path);
    const modelArg = argument(before.argv, ["-m", "--model"]);
    if (!modelArg || await fs.realpath(path.resolve(before.cwd, modelArg)) !== await fs.realpath(modelPath)) {
        throw new Error("API model does not match listener model");
    }
    // Split weights need a complete manifest; do not silently bind only shard one.
    if (/-\d{5}-of-\d{5}\.gguf$/i.test(modelPath))
        throw new Error("Split GGUF identity not supported");
    const loras = [];
    for (const adapter of adapters) {
        if (typeof adapter?.path !== "string" || !adapter.path || !Number.isFinite(adapter.scale)) {
            throw new Error("Unknown adapter identity/scale");
        }
        loras.push({ ...adapter, file: await fileIdentity(path.resolve(before.cwd, adapter.path)) });
    }
    const extras = [];
    for (const names of [["--mmproj"], ["-md", "--model-draft"], ["--chat-template-file"]]) {
        const filename = argument(before.argv, names);
        if (filename)
            extras.push(await fileIdentity(path.resolve(before.cwd, filename)));
    }
    const model = await fileIdentity(modelPath);
    const after = await inspect();
    if (stableStringify(before) !== stableStringify(after))
        throw new Error("Listener changed during discovery");
    const identity = computeHash(stableStringify({
        version: 2, serverUrl, addresses, cacheDir: before.cacheDir, argv: before.argv, env: before.env,
        executable: before.executable, model, extras, loras,
        props: { model_alias: props.model_alias, build_info: props.build_info,
            default_generation_settings: props.default_generation_settings, chat_template: props.chat_template, total_slots: props.total_slots },
    }));
    io.signal?.throwIfAborted();
    return { transport, serverUrl, cacheDir: before.cacheDir, identity, generation: `${before.pid}:${before.start}:${before.inode}` };
}
/** One queue covers provider activation, saves, commands and shutdown. No detached jobs. */
export class RuntimeQueue {
    tail = Promise.resolve();
    run(job) {
        const result = this.tail.then(job);
        this.tail = result.catch(() => { });
        return result;
    }
}
/**
 * resolveRuntime() spawns `ss`, reads /proc and makes two HTTP calls (~0.1 s) and
 * ran several times per request. Reuse a verified result while the same listener
 * process is alive (pid + start time from /proc) and its LoRA adapters are
 * unchanged; anything else, or 60 s, re-runs the full verification.
 */
export function cachedRuntimeResolver(resolve = resolveRuntime, ttlMs = 60_000, procRoot = "/proc", now = Date.now) {
    const cache = new Map();
    const adapters = async (value, signal) => {
        const res = await boundedFetch(`${value.serverUrl}/lora-adapters`, {}, { signal, controlTimeoutMs: 2000, transport: value.transport });
        if (!res.ok)
            throw new Error(`Discovery HTTP ${res.status}`);
        return res.text();
    };
    return async (baseUrl, io = {}) => {
        const hit = cache.get(baseUrl);
        if (hit && now() - hit.at < ttlMs) {
            try {
                const [pid, start] = hit.value.generation.split(":");
                const stat = await fs.readFile(path.join(procRoot, pid, "stat"), "utf8");
                if (stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19] === start &&
                    await adapters(hit.value, io.signal) === hit.adapters)
                    return hit.value;
            }
            catch (error) {
                io.signal?.throwIfAborted();
            }
            cache.delete(baseUrl);
        }
        const value = await resolve(baseUrl, io);
        cache.set(baseUrl, { at: now(), value, adapters: await adapters(value, io.signal) });
        return value;
    };
}
//# sourceMappingURL=runtime.js.map