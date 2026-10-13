#!/usr/bin/env python3
"""Rebuild golden in the background as soon as its inputs change.

Polls the files that shape Pi's canonical prefix (context files, skills, extension sources).
After a change and a quiet period it runs one throwaway new session in the canonical cwd. That
fresh worker sees the edit, so the extension's own rules (resource refresh, extension refresh or
fingerprint adoption, seeded in that session's slot) publish the new golden before a real session
needs it. An unchanged prefix costs one ~53-token request. The session and its snapshot are removed.
"""
import glob, json, os, shutil, subprocess, sys, tempfile, time, urllib.request

HOME = os.path.expanduser("~")
AGENT = os.path.join(HOME, ".pi", "agent")
CACHE = os.environ.get("KV_CACHE_DIR", os.path.join(HOME, ".cache", "llama-slots"))
SERVER = os.environ.get("KV_SERVER", "http://127.0.0.1:8001")
PI_BIN = os.environ.get("PI_BIN", os.path.join(HOME, "src/pi-agent/packages/coding-agent/dist/cli.js"))
PROVIDER = os.environ.get("KV_WATCH_PROVIDER", "local-llama")
MODEL = os.environ.get("KV_WATCH_MODEL", "qwen3.6-35b-q4")
POLL, QUIET, MIN_GAP = (float(os.environ.get(k, d)) for k, d in
                        (("KV_WATCH_POLL", "15"), ("KV_WATCH_QUIET", "45"), ("KV_WATCH_MIN_GAP", "120")))
SKIP_DIRS = {"node_modules", ".git", "__pycache__", ".venv", "venv", "logs", "test", "tests", "coverage", "dist-test"}
SOURCE_EXT = (".ts", ".js", ".mjs", ".cjs", ".json", ".md")


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def roots():
    """Context files plus every skill/extension tree Pi loads."""
    files = [os.path.join(AGENT, "AGENTS.md"), os.path.join(AGENT, "settings.json")]
    trees = [os.path.join(AGENT, "skills")]
    trees += [p for p in glob.glob(os.path.join(AGENT, "extensions", "*")) if os.path.isdir(p)]
    try:
        settings = json.load(open(os.path.join(AGENT, "settings.json")))
    except (OSError, ValueError):
        settings = {}
    for pkg in settings.get("packages") or []:
        name = pkg if isinstance(pkg, str) else pkg.get("source", "")
        path = (os.path.join(AGENT, "npm", "node_modules", name[4:]) if name.startswith("npm:")
                else os.path.normpath(os.path.join(AGENT, os.path.expanduser(name))))
        if os.path.isdir(path):
            trees.append(path)
    return files, sorted({os.path.realpath(t) for t in trees})


def signature():
    files, trees = roots()
    sig = {}
    for f in files:
        try:
            st = os.stat(f); sig[f] = (st.st_mtime_ns, st.st_size)
        except OSError:
            pass
    for tree in trees:
        for top, dirs, names in os.walk(tree, followlinks=True):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
            for n in names:
                if n.endswith(SOURCE_EXT) and n != "package-lock.json":
                    p = os.path.join(top, n)
                    try:
                        st = os.stat(p); sig[p] = (st.st_mtime_ns, st.st_size)
                    except OSError:
                        pass
    return sig


def server_ready():
    """Healthy, and one slot is idle so the warm does not queue behind (or evict) live work."""
    try:
        with urllib.request.urlopen(f"{SERVER}/health", timeout=5) as r:
            if r.status != 200:
                return False
        with urllib.request.urlopen(f"{SERVER}/slots", timeout=30) as r:
            return any(not s.get("is_processing") for s in json.load(r))
    except Exception:
        return False


def warnings_tail(offset):
    path = os.path.join(CACHE, "golden-warnings.jsonl")
    try:
        with open(path) as f:
            f.seek(offset); return [json.loads(l) for l in f if l.strip()]
    except (OSError, ValueError):
        return []


def prewarm():
    path = os.path.join(CACHE, "golden-warnings.jsonl")
    offset = os.path.getsize(path) if os.path.exists(path) else 0
    tmp = tempfile.mkdtemp(prefix="kv-golden-watch-")
    env = {k: v for k, v in os.environ.items() if k not in ("PI_SESSION_FILE", "PI_SESSION_ID")}
    started = time.time()
    try:
        subprocess.run(["node", PI_BIN, "--provider", PROVIDER, "--model", MODEL, "--session-dir", tmp,
                        "-p", "hello"], cwd=HOME, env=env, stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=600)
    except subprocess.TimeoutExpired:
        log("prewarm timed out")
    finally:
        for f in glob.glob(os.path.join(tmp, "*.jsonl")):
            sid = os.path.basename(f).rsplit("_", 1)[-1].removesuffix(".jsonl")
            for snap in glob.glob(os.path.join(CACHE, f"kv2_*_snap_{sid}.*")):
                os.unlink(snap)
        shutil.rmtree(tmp, ignore_errors=True)
    rows = [r for r in warnings_tail(offset) if r.get("type") != "golden_mismatch"]
    done = "; ".join(f"{r['type']}:{r.get('reason')} seeded={r.get('seeded')} tokens={r.get('tokens')} "
                     f"{r.get('durationMs')}ms {r.get('why', '')}".strip() for r in rows) or "golden already current"
    log(f"prewarm {time.time() - started:.1f}s -> {done}")


def main():
    last = signature()
    log(f"watching {len(last)} files")
    changed_at, last_run = None, 0.0
    while True:
        time.sleep(POLL)
        sig = signature()
        if sig != last:
            diff = sorted(set(sig) ^ set(last) | {k for k in sig.keys() & last.keys() if sig[k] != last[k]})
            log(f"changed: {', '.join(os.path.relpath(p, HOME) for p in diff[:5])}{' …' if len(diff) > 5 else ''}")
            last, changed_at = sig, time.time()
            continue
        if changed_at is None or time.time() - changed_at < QUIET or time.time() - last_run < MIN_GAP:
            continue
        if not server_ready():
            continue
        changed_at, last_run = None, time.time()
        prewarm()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
