#!/usr/bin/env python3
"""Verification suite for claude-max-bridge.

Run against a live bridge:   python3 verify.py
Override the base URL with:  CMB_BASE=http://127.0.0.1:8766 python3 verify.py

Every test hits the real bridge, which spawns the real `claude` binary, which
makes a real API call. It costs subscription quota. It is not a unit test.
"""
import json
import os
import sys
import urllib.request
import urllib.error

BASE = os.environ.get("CMB_BASE", "http://127.0.0.1:8766")

# Model aliases as named in bridge.config.json5. Override if you renamed them.
MODEL = os.environ.get("CMB_MODEL", "fast")

PASS, FAIL = [], []


def post(path, payload, timeout=300):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return json.loads(r.read())


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


# Realistic client-style tool names, including a hyphen — which MCP tool names
# allow but Claude Code normalises to '_' somewhere in the ToolSearch path.
# T2 and T8 are the regression tests for that round-trip.
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "mcp_demo-server_run_command",
            "description": "Run a shell command on the demo host.",
            "parameters": {
                "type": "object",
                "properties": {"cmd": {"type": "string", "description": "The command"}},
                "required": ["cmd"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "mcp_demo_get_status",
            "description": "Get hardware status from the demo host.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
]


def t1_text():
    print("\n[T1] Plain text, no tools")
    r = post("/v1/chat/completions", {
        "model": MODEL,
        "messages": [{"role": "user", "content": "Reply with exactly the word PONG and nothing else."}],
    })
    msg = r["choices"][0]["message"]
    b = r.get("_bridge", {})
    check("a response comes back", "PONG" in (msg.get("content") or ""), repr(msg.get("content"))[:80])
    check("finish_reason=stop", r["choices"][0]["finish_reason"] == "stop")
    check("apiKeySource=none (subscription, not an API key)", b.get("apiKeySource") == "none",
          f"apiKeySource={b.get('apiKeySource')}")
    rl = b.get("rateLimit") or {}
    check("isUsingOverage=false (included quota)", rl.get("isUsingOverage") is False, json.dumps(rl))
    check("no native tools exposed beyond ToolSearch",
          b.get("exposedBuiltinTools") in (["ToolSearch"], []),
          f"exposed={b.get('exposedBuiltinTools')}")
    return r


def t2_toolcall():
    print("\n[T2] Tool call -> OpenAI tool_calls")
    r = post("/v1/chat/completions", {
        "model": MODEL,
        "tools": TOOLS,
        "messages": [
            {"role": "system", "content": "You are a helpful assistant with tools. Use them when needed."},
            {"role": "user", "content": "Run 'uname -s' on the demo host and tell me what you get."},
        ],
    })
    ch = r["choices"][0]
    tc = ch["message"].get("tool_calls") or []
    b = r.get("_bridge", {})
    check("finish_reason=tool_calls", ch["finish_reason"] == "tool_calls", ch["finish_reason"])
    check("at least one tool_call", len(tc) >= 1, f"{len(tc)}")
    if tc:
        name = tc[0]["function"]["name"]
        check("original name preserved (hyphen and all)",
              name == "mcp_demo-server_run_command", f"got {name}")
        try:
            args = json.loads(tc[0]["function"]["arguments"])
            check("arguments are valid JSON containing cmd", "cmd" in args, json.dumps(args)[:120])
        except Exception as e:
            check("arguments are valid JSON", False, str(e))
    check("no Claude built-in leaked as a tool_call",
          all(t["function"]["name"] not in ("Bash", "Read", "Edit", "Write", "WebFetch") for t in tc))
    check("apiKeySource=none", b.get("apiKeySource") == "none")
    check("isUsingOverage=false", (b.get("rateLimit") or {}).get("isUsingOverage") is False)
    return r, tc


def t3_roundtrip(tc):
    print("\n[T3] Full round trip: tool_result back -> final answer")
    if not tc:
        check("round trip", False, "no tool_call from T2")
        return
    r = post("/v1/chat/completions", {
        "model": MODEL,
        "tools": TOOLS,
        "messages": [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "Run 'uname -s' on the demo host and tell me what you get."},
            {"role": "assistant", "content": None, "tool_calls": [
                {"id": tc[0]["id"], "type": "function",
                 "function": {"name": tc[0]["function"]["name"],
                              "arguments": tc[0]["function"]["arguments"]}}]},
            {"role": "tool", "tool_call_id": tc[0]["id"], "name": "mcp_demo-server_run_command",
             "content": "Darwin"},
        ],
    })
    ch = r["choices"][0]
    content = ch["message"].get("content") or ""
    check("final answer without a new tool call", ch["finish_reason"] == "stop", ch["finish_reason"])
    check("the answer uses the tool result", "darwin" in content.lower(), content[:150])


def t4_large_system_prompt():
    print("\n[T4] Large system prompt (~16 kB) + tools")
    # Synthetic filler of the size a real agent persona tends to reach. The point
    # is to check that a large --append-system-prompt does not flip the request
    # into the overage lane — see README, "Billing".
    persona = (
        "You are a systems assistant. You are concise and precise.\n"
        "You have access to tools and you use them rather than guessing.\n"
    )
    filler = "\n".join(
        f"Rule {i}: prefer verified facts over assumptions; state uncertainty explicitly."
        for i in range(1, 190)
    )
    system = persona + filler
    print(f"  (system prompt = {len(system)} chars)")
    r = post("/v1/chat/completions", {
        "model": MODEL,
        "tools": TOOLS,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": "Check the hardware status on the demo host."},
        ],
    })
    ch = r["choices"][0]
    rl = (r.get("_bridge", {}).get("rateLimit")) or {}
    check("no 429 / no overage signature", ch["finish_reason"] in ("tool_calls", "stop"),
          ch["finish_reason"])
    check("isUsingOverage=false even with a 16 kB system prompt",
          rl.get("isUsingOverage") is False, json.dumps(rl))
    check("status=allowed", rl.get("status") == "allowed", rl.get("status"))
    tc = ch["message"].get("tool_calls") or []
    check("picked the right tool", any(t["function"]["name"] == "mcp_demo_get_status" for t in tc),
          str([t["function"]["name"] for t in tc]))


def t5_badmodel():
    print("\n[T5] Unknown model returns 400, not a silent fallback")
    try:
        post("/v1/chat/completions", {"model": "gpt-4", "messages": [{"role": "user", "content": "hi"}]})
        check("unknown model is rejected", False, "got 200")
    except urllib.error.HTTPError as e:
        check("unknown model rejected with 400", e.code == 400, f"HTTP {e.code}")


def t6_health():
    print("\n[T6] /health")
    h = get("/health")
    check("status ok", h.get("status") == "ok", h.get("status"))
    check("overageSeen=false", h.get("overageSeen") is False)
    check("builtinTools=[ToolSearch]", h.get("builtinTools") == ["ToolSearch"])
    check("permissionMode=default", h.get("permissionMode") == "default")
    print("  " + json.dumps(h.get("lastRateLimit")))


def sse(payload, timeout=300):
    req = urllib.request.Request(
        BASE + "/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    events = []
    with urllib.request.urlopen(req, timeout=timeout) as r:
        for raw in r:
            line = raw.decode().strip()
            if not line.startswith("data: "):
                continue
            body = line[6:]
            if body == "[DONE]":
                events.append("[DONE]")
                continue
            events.append(json.loads(body))
    return events


def t7_stream_text():
    print("\n[T7] Streaming (SSE) — text")
    ev = sse({"model": MODEL, "stream": True,
              "messages": [{"role": "user", "content": "Reply with exactly the word PONG."}]})
    check("stream ends with [DONE]", bool(ev) and ev[-1] == "[DONE]")
    text = "".join(e["choices"][0]["delta"].get("content") or ""
                   for e in ev if isinstance(e, dict))
    check("text comes through", "PONG" in text, repr(text)[:80])
    fins = [e["choices"][0]["finish_reason"] for e in ev if isinstance(e, dict)]
    check("finish_reason=stop in the stream", "stop" in fins, str(fins))


def t8_stream_tools():
    print("\n[T8] Streaming (SSE) — tool_calls with name preservation")
    ev = sse({"model": MODEL, "stream": True, "tools": TOOLS,
              "messages": [{"role": "user", "content": "Run 'uname -s' on the demo host."}]})
    names, fins = [], []
    for e in ev:
        if not isinstance(e, dict):
            continue
        d = e["choices"][0]["delta"]
        for tc in d.get("tool_calls") or []:
            names.append(tc["function"]["name"])
        fins.append(e["choices"][0]["finish_reason"])
    check("tool_call in the stream", len(names) >= 1, str(names))
    check("original name preserved in SSE too",
          bool(names) and names[0] == "mcp_demo-server_run_command", str(names))
    check("finish_reason=tool_calls", "tool_calls" in fins, str(fins))


if __name__ == "__main__":
    print(f"claude-max-bridge verification against {BASE} (model alias: {MODEL})")
    t1_text()
    _, tc = t2_toolcall()
    t3_roundtrip(tc)
    t4_large_system_prompt()
    t5_badmodel()
    t7_stream_text()
    t8_stream_tools()
    t6_health()
    print(f"\n===== {len(PASS)} PASS, {len(FAIL)} FAIL =====")
    if FAIL:
        for f in FAIL:
            print("  FAIL:", f)
        sys.exit(1)
