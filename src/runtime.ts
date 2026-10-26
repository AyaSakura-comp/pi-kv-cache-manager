import { boundedFetch } from "./request.js";
import { lookupLocalhost, resolveLocalhost, pinnedTransport, type Lookup } from "./loopback.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { computeHash, stableStringify } from "./base-cache.js";

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

const exec = promisify(execFile);

/**
 * llama-server answers /props and /lora-adapters from its main loop, so they queue behind
 * whatever the loop is doing (a 2048-token ubatch, a 2-3 s image encode). A 2 s deadline
 * timed out under load; the TimeoutError was treated as cancellation and silently discarded
 * finished golden warms and slot bindings. A dead server still fails within this bound.
 */
export const DISCOVERY_TIMEOUT_MS = 30_000;

function argument(argv: string[], names: string[]): string | undefined {
  const values: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    for (const name of names) {
      if (argv[i] === name) values.push(argv[i + 1]);
      else if (argv[i].startsWith(name + "=")) values.push(argv[i].slice(name.length + 1));
    }
  }
  if (values.length > 1 || values.some(v => !v || v.startsWith("--"))) throw new Error("Ambiguous server arguments");
  return values[0];
}

async function fileIdentity(filename: string): Promise<unknown> {
  const real = await fs.realpath(filename);
  const stat = await fs.stat(real, { bigint: true });
  if (!stat.isFile()) throw new Error("Expected a local regular file");
  return [real, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
}

/**
 * Strata (Qwen3.8-Flash-Next) serves llama-server's slot API from `python serve/server.py --engine strata
 * --config <run config>`; the run config names the engine and every model file. Returns the server script and
 * config path, or undefined for any other listener.
 */
function strataServer(exe: string, argv: string[], cwd: string): { script: string; config: string } | undefined {
  if (!/^python3?(\.\d+)?$/.test(path.basename(exe))) return undefined;
  const script = argv.slice(1).find(a => !a.startsWith("-"));
  if (!script || path.basename(script) !== "server.py" || path.basename(path.dirname(path.resolve(cwd, script))) !== "serve") {
    return undefined;
  }
  if (argument(argv, ["--engine"]) !== "strata") throw new Error("Strata listener does not run the Strata engine");
  const config = argument(argv, ["--config"]);
  if (!config) throw new Error("Strata --config is not explicit");
  return { script: path.resolve(cwd, script), config: path.resolve(cwd, config) };
}

/** A model folder (pack, MTP, tokenizer) by the identity of every file in it, a bounded walk. */
async function treeIdentity(root: string, depth = 3, budget = { left: 512 }): Promise<unknown> {
  const stat = await fs.stat(root);
  if (stat.isFile()) return fileIdentity(root);
  if (!stat.isDirectory() || depth < 0) throw new Error("Expected a local regular file or folder");
  const out: unknown[] = [await fs.realpath(root)];
  for (const name of (await fs.readdir(root)).sort()) {
    if (--budget.left < 0) throw new Error("Model folder too large to identify");
    out.push([name, await treeIdentity(path.join(root, name), depth - 1, budget)]);
  }
  return out;
}

/**
 * Strata's runtime: its run config (engine, arguments, environment) and the identity of the engine binary, the
 * server code that renders prompts and every file or folder an argument names. Session files are also bound to
 * the model and settings by the engine itself, which refuses a mismatched file.
 */
async function strataRuntime(server: { script: string; config: string }, argv: string[], cwd: string) {
  const config = JSON.parse(await fs.readFile(server.config, "utf8"));
  if (!config || typeof config !== "object" || typeof config.exe !== "string" || !Array.isArray(config.args)) {
    throw new Error("Strata run config has no engine");
  }
  // the engine runs in the config's "cwd" (relative to the server's), which its relative paths start from
  const base = typeof config.cwd === "string" ? path.resolve(cwd, config.cwd) : cwd;
  // --slot-save-path is relative to the server's working directory, the config's slot_save_path to its "cwd"
  const cli = argument(argv, ["--slot-save-path"]);
  const folder = cli ? path.resolve(cwd, cli) : typeof config.slot_save_path === "string" ? path.resolve(base, config.slot_save_path) : undefined;
  if (!folder) throw new Error("Server --slot-save-path is not explicit");
  const files: unknown[] = [];
  for (const value of [config.exe, ...config.args.filter((a: unknown) => typeof a === "string"), config.tokenizer,
    config.vision?.mmproj, config.vision?.exe]) {
    if (typeof value !== "string" || value.startsWith("-")) continue;
    // a control vector is named with its scale (FILE:SCALE); the scale stays in the arguments
    for (const candidate of [value, value.replace(/:[-+0-9.eE]+$/, "")]) {
      const file = path.resolve(base, candidate);
      try { await fs.access(file); } catch { continue; }
      files.push([candidate, await treeIdentity(file)]);
      break;
    }
  }
  const serve = path.dirname(server.script);
  const code = [];
  for (const name of ["server.py", "frontend.py", "chat_template.jinja"]) code.push(await fileIdentity(path.join(serve, name)));
  return { folder, config, files, code, configFile: await fileIdentity(server.config) };
}

/** Only direct, same-namespace Linux listeners are supported. No pgrep or shell. */
export async function resolveRuntime(baseUrl: string, io: DiscoveryIO = {}): Promise<ResolvedRuntime> {
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
  const listener = io.listener ?? (async (p: number) => (await exec("ss", ["-H", "-ltnpe", `sport = :${p}`], {
    timeout: 1500, maxBuffer: 65536, signal: io.signal,
  })).stdout);
  const inspect = async () => {
    const lines = (await listener(port)).trim().split("\n").filter(Boolean);
    // A second listener, even inaccessible, makes ownership ambiguous.
    if (lines.length !== 1) throw new Error("Listener ownership unavailable or ambiguous");
    const line = lines[0];
    const local = line.trim().split(/\s+/)[3];
    io.signal?.throwIfAborted();
    const allowed = addresses ? addresses.flatMap(a => a.family === 4 ? ["127.0.0.1", "0.0.0.0"] : ["[::1]", "[::]"]) :
      url.hostname === "127.0.0.1" ? ["127.0.0.1", "0.0.0.0"] : ["[::1]", "[::]"];
    if (!allowed.some(a => local === `${a}:${port}`)) throw new Error("Listener address/port mismatch");
    const owners = [...line.matchAll(/pid=(\d+),fd=(\d+)/g)];
    const inode = /\bino:(\d+)\b/.exec(line)?.[1];
    if (owners.length !== 1 || !inode) throw new Error("Listener owner unavailable");
    const [, pid, fd] = owners[0];
    const dir = path.join(proc, pid);
    if (await fs.readlink(path.join(dir, "fd", fd)) !== `socket:[${inode}]`) throw new Error("Listener fd mismatch");
    for (const ns of ["net", "mnt"]) {
      if (await fs.readlink(path.join(dir, "ns", ns)) !== await fs.readlink(path.join(proc, "self", "ns", ns))) {
        throw new Error("Server is in another namespace");
      }
    }
    if (await fs.realpath(path.join(dir, "root")) !== await fs.realpath(path.join(proc, "self", "root"))) {
      throw new Error("Server has a different filesystem root");
    }
    const exe = await fs.readlink(path.join(dir, "exe"));
    const argv = (await fs.readFile(path.join(dir, "cmdline"), "utf8")).split("\0").filter(Boolean);
    const cwd = await fs.readlink(path.join(dir, "cwd"));
    const strata = strataServer(exe, argv, cwd);
    if (path.basename(exe) !== "llama-server" && !strata) throw new Error("Listener is not llama-server or Strata");
    const stat = await fs.readFile(path.join(dir, "stat"), "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
    if (!start) throw new Error("Missing process start identity");
    const env = (await fs.readFile(path.join(dir, "environ"), "utf8")).split("\0")
      .filter(v => /^(LLAMA_ARG_|GGML_|CUDA_|HIP_|ROCR_|STRATA_)/.test(v)).sort();
    const runtime = strata ? await strataRuntime(strata, argv, cwd) : undefined;
    const folder = runtime ? runtime.folder : argument(argv, ["--slot-save-path"]);
    if (!folder) throw new Error("Server --slot-save-path is not explicit");
    const cacheDir = await fs.realpath(path.resolve(cwd, folder));
    if (!(await fs.stat(cacheDir)).isDirectory()) throw new Error("Snapshot path is not a directory");
    return { pid, start, inode, argv, cwd, env, cacheDir, executable: await fileIdentity(exe), strata: runtime };
  };
  const before = await inspect();
  const serverUrl = url.origin;
  const get = io.json ?? (async (url: string) => {
    const res = await boundedFetch(url, {}, {signal: io.signal, controlTimeoutMs: DISCOVERY_TIMEOUT_MS, transport});
    if (!res.ok) throw new Error(`Discovery HTTP ${res.status}`);
    return res.json();
  });
  const props = await get(`${serverUrl}/props`);
  const adapters = await get(`${serverUrl}/lora-adapters`);
  if (typeof props?.model_path !== "string" || !props.model_path || !Array.isArray(adapters)) {
    throw new Error("Server model/adapter identity unavailable");
  }
  if (before.strata) {
    // Strata names its model by the --native GGUF of its run config (or the pack) and loads no adapters.
    const named = before.strata.files.map(f => (f as [string, unknown])[0]);
    if (adapters.length || !named.includes(props.model_path)) throw new Error("API model does not match listener model");
    const after = await inspect();
    if (stableStringify(before) !== stableStringify(after)) throw new Error("Listener changed during discovery");
    const identity = computeHash(stableStringify({
      version: 2, engine: "strata", serverUrl, addresses, cacheDir: before.cacheDir, argv: before.argv, env: before.env,
      executable: before.executable, runtime: before.strata,
      props: { model_alias: props.model_alias, build_info: props.build_info, chat_template: props.chat_template,
        total_slots: props.total_slots, n_ctx: props.default_generation_settings?.n_ctx },
    }));
    io.signal?.throwIfAborted();
    return { transport, serverUrl, cacheDir: before.cacheDir, identity, generation: `${before.pid}:${before.start}:${before.inode}` };
  }
  const modelPath = path.resolve(before.cwd, props.model_path);
  const modelArg = argument(before.argv, ["-m", "--model"]);
  if (!modelArg || await fs.realpath(path.resolve(before.cwd, modelArg)) !== await fs.realpath(modelPath)) {
    throw new Error("API model does not match listener model");
  }
  // Split weights need a complete manifest; do not silently bind only shard one.
  if (/-\d{5}-of-\d{5}\.gguf$/i.test(modelPath)) throw new Error("Split GGUF identity not supported");
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
    if (filename) extras.push(await fileIdentity(path.resolve(before.cwd, filename)));
  }
  const model = await fileIdentity(modelPath);
  const after = await inspect();
  if (stableStringify(before) !== stableStringify(after)) throw new Error("Listener changed during discovery");
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
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job);
    this.tail = result.catch(() => {});
    return result;
  }
}

/**
 * resolveRuntime() spawns `ss`, reads /proc and makes two HTTP calls (~0.1 s) and
 * ran several times per request. Reuse a verified result while the same listener
 * process is alive (pid + start time from /proc) and its LoRA adapters are
 * unchanged; anything else, or 60 s, re-runs the full verification.
 */
export function cachedRuntimeResolver(resolve: typeof resolveRuntime = resolveRuntime, ttlMs = 60_000,
  procRoot = "/proc", now: () => number = Date.now) {
  const cache = new Map<string, { at: number; value: ResolvedRuntime; adapters: string }>();
  const adapters = async (value: ResolvedRuntime, signal?: AbortSignal) => {
    const res = await boundedFetch(`${value.serverUrl}/lora-adapters`, {}, { signal, controlTimeoutMs: DISCOVERY_TIMEOUT_MS, transport: value.transport });
    if (!res.ok) throw new Error(`Discovery HTTP ${res.status}`);
    return res.text();
  };
  return async (baseUrl: string, io: DiscoveryIO = {}): Promise<ResolvedRuntime> => {
    const hit = cache.get(baseUrl);
    if (hit && now() - hit.at < ttlMs) {
      try {
        const [pid, start] = hit.value.generation.split(":");
        const stat = await fs.readFile(path.join(procRoot, pid, "stat"), "utf8");
        if (stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19] === start &&
            await adapters(hit.value, io.signal) === hit.adapters) return hit.value;
      } catch (error) {
        io.signal?.throwIfAborted();
      }
      cache.delete(baseUrl);
    }
    const value = await resolve(baseUrl, io);
    cache.set(baseUrl, { at: now(), value, adapters: await adapters(value, io.signal) });
    return value;
  };
}
