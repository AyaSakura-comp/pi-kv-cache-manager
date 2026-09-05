#!/usr/bin/env python3
"""
Test & Verification Suite for Image / Multimodal Cases with Slot Snapshots
=========================================================================
This script exercises various multimodal scenarios against llama-server
to verify behavior and identify potential bugs / edge cases.
"""

import urllib.request
import urllib.error
import json
import base64
import sys

BASE_URL = "http://127.0.0.1:8001"

# 1x1 transparent PNG
PNG_1X1_BASE64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)

def http_post(endpoint: str, payload: dict) -> tuple[int, dict]:
    url = f"{BASE_URL}{endpoint}"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return resp.status, data
    except urllib.error.HTTPError as e:
        try:
            err_data = json.loads(e.read().decode("utf-8"))
        except Exception:
            err_data = {"raw": str(e)}
        return e.code, err_data

def get_slots() -> list:
    url = f"{BASE_URL}/slots"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))

def run_tests():
    print("=" * 60)
    print("  Multimodal & Slot Action Test Suite for llama-server")
    print("=" * 60)

    # 1. Check Server Health & Slots
    print("\n[Test 1] Inspecting Active Server Slots...")
    try:
        slots = get_slots()
        print(f"  Found {len(slots)} active slot(s).")
        for s in slots:
            print(f"  - Slot {s['id']}: n_ctx={s['n_ctx']}, is_processing={s['is_processing']}")
    except Exception as e:
        print(f"  Failed to query /slots: {e}")
        return

    # 2. Test Multimodal Image Completion (Turn 1)
    print("\n[Test 2] Sending Image Request (Turn 1: 1x1 image + text prompt)...")
    img_payload = {
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{PNG_1X1_BASE64}"}},
                    {"type": "text", "text": "What is in this image? Respond concisely."}
                ]
            }
        ],
        "max_tokens": 15,
        "temperature": 0.1
    }
    status, res = http_post("/v1/chat/completions", img_payload)
    print(f"  HTTP Status: {status}")
    if status == 200:
        usage = res.get("usage", {})
        timings = res.get("timings", {})
        print(f"  Prompt tokens: {usage.get('prompt_tokens')}, Completion: {usage.get('completion_tokens')}")
        print(f"  Prompt eval time: {timings.get('prompt_ms', 0):.2f} ms")
    else:
        print(f"  Image completion failed: {res}")

    # 3. Test Slot Actions against Unpatched Server
    print("\n[Test 3] Testing Slot Actions on Running Server...")
    for action, payload in [
        ("save", {"filename": "test_snap.bin"}),
        ("restore", {"filename": "test_snap.bin"}),
        ("erase", {})
    ]:
        code, resp = http_post(f"/slots/1?action={action}", payload)
        print(f"  - POST /slots/1?action={action} -> HTTP {code}")
        err_msg = resp.get("error", {}).get("message", resp)
        print(f"    Result: {err_msg}")

    print("\n" + "=" * 60)
    print("  Analysis Complete.")
    print("=" * 60)

if __name__ == "__main__":
    run_tests()
