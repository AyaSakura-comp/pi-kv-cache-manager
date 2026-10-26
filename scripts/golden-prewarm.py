#!/usr/bin/env python3
"""Refresh golden right after a Pi package change, before a real session needs it.

Run by Pi's `~/.pi/agent/hooks/after-package-change` (pi install/remove/update) or by hand after
editing AGENTS.md/skills/extension copies. It runs one throwaway new session in the canonical cwd.
That fresh worker loads the changed resources, so the extension's own rules (extension or resource
refresh seeded in that session's slot, or fingerprint adoption) publish the new golden. An unchanged
prefix costs one ~53-token request. The session and its snapshot are removed afterwards.
"""
import fcntl, glob, json, os, shutil, subprocess, sys, tempfile, time, urllib.request

HOME = os.path.expanduser("~")


def pi_default():
    """Pi's default local model (settings.json) and its server (models.json), so the prewarm follows a switch
    between qwen-mtp (:8001) and Strata (:8090). -> (provider, model, server) or Nones."""
    agent = os.path.join(HOME, ".pi", "agent")
    try:
        with open(os.path.join(agent, "settings.json")) as f:
            settings = json.load(f)
        with open(os.path.join(agent, "models.json")) as f:
            base = json.load(f)["providers"][settings["defaultProvider"]]["baseUrl"]
        return settings["defaultProvider"], settings["defaultModel"], base.rstrip("/").removesuffix("/v1")
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None, None, None


DEFAULT_PROVIDER, DEFAULT_MODEL, DEFAULT_SERVER = pi_default()
CACHE = os.environ.get("KV_CACHE_DIR", os.path.join(HOME, ".cache", "llama-slots"))
SERVER = os.environ.get("KV_SERVER", DEFAULT_SERVER or "http://127.0.0.1:8001")
PI_BIN = os.environ.get("PI_BIN", os.path.join(HOME, "src/pi-agent/packages/coding-agent/dist/cli.js"))
PROVIDER = os.environ.get("KV_PREWARM_PROVIDER", DEFAULT_PROVIDER or "local-llama")
MODEL = os.environ.get("KV_PREWARM_MODEL", DEFAULT_MODEL or "qwen3.6-35b-q4")
SETTLE = float(os.environ.get("KV_PREWARM_SETTLE", "5"))
WAIT_IDLE = float(os.environ.get("KV_PREWARM_WAIT_IDLE", "600"))
LOG = os.path.join(CACHE, "golden-prewarm.log")


def log(msg):
    line = f"{time.strftime('%F %T')} {msg}"
    print(line, flush=True)
    try:
        with open(LOG, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


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
    try:
        with open(os.path.join(CACHE, "golden-warnings.jsonl")) as f:
            f.seek(offset); return [json.loads(l) for l in f if l.strip()]
    except (OSError, ValueError):
        return []


def prewarm():
    path = os.path.join(CACHE, "golden-warnings.jsonl")
    offset = os.path.getsize(path) if os.path.exists(path) else 0
    tmp = tempfile.mkdtemp(prefix="kv-golden-prewarm-")
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
    reason = " ".join(sys.argv[1:]) or "manual"
    os.makedirs(CACHE, exist_ok=True)
    lock = open(os.path.join(CACHE, "golden-prewarm.lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        # A running prewarm may have started before this change landed: queue exactly one rerun.
        open(os.path.join(CACHE, "golden-prewarm.again"), "w").close()
        log(f"{reason}: prewarm already running, queued a rerun")
        return
    again = os.path.join(CACHE, "golden-prewarm.again")
    while True:
        time.sleep(SETTLE)  # let back-to-back package commands land first
        deadline = time.time() + WAIT_IDLE
        while not server_ready():
            if time.time() > deadline:
                log(f"{reason}: server unavailable or busy for {WAIT_IDLE:.0f}s; next new session refreshes instead")
                return
            time.sleep(5)
        log(f"{reason}: prewarm start")
        prewarm()
        if not os.path.exists(again):
            return
        os.unlink(again)
        reason = "rerun"


if __name__ == "__main__":
    main()
