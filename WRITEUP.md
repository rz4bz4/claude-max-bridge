# Driving Claude Code from your own agent: what actually works

*What I learned wiring an OpenAI-compatible endpoint onto the official `claude`
binary — including the part everyone gets wrong about tool calls.*

By **Reza Sabaro** — [LinkedIn](https://se.linkedin.com/in/reza-s-58288b26) ·
[GitHub](https://github.com/rz4bz4)

---

There is a recurring request in agent frameworks: *let me point this thing at my
Claude subscription instead of an API key.* The usual answers are bad. Either
you spoof Claude Code's identity against `/v1/messages` — forging headers,
replaying request signatures — which is both against Anthropic's terms and, as
of early 2026, actively enforced at the API layer. Or you shell out to `claude -p`
and discover that you have lost structured tool calls, which for an agent is the
whole ballgame.

There is a third option that works, stays inside documented behaviour, and keeps
real tool calls. It took a fair amount of measurement to find, and most of what I
learned contradicts what is currently written down in the community threads. This
is that writeup.

The code is at **[github.com/rz4bz4/claude-max-bridge](https://github.com/rz4bz4/claude-max-bridge)**,
MIT. But the repo is the footnote. The findings below are the point.

**What this is:** a local adapter that spawns the official, unmodified `claude`
binary in its documented headless mode and translates between that and the
OpenAI Chat Completions format. No spoofing, no forged headers, no
`ANTHROPIC_BASE_URL` redirection. Everything Anthropic's servers see comes from
Anthropic's own client.

**What this is not:** a way to avoid paying for what you use, or a way to serve
other people's requests off your subscription. More on that at the end, because
it matters and I would rather put it in your head than in a footer.

All version-specific claims below were measured against **Claude Code 2.1.220**
on **2026-08-19**. Anthropic changes this surface without notice; verify before
you rely on any of it.

---

## 1. Isolating the built-in tools: `--tools ToolSearch`, and nothing else

If your client owns the agent loop, you do not want Claude running `Bash` and
`Read` and `Write` behind your back. You want it to *decide* on a tool and hand
the decision back to you.

The obvious approaches both fail:

| Flags | What actually happens |
|---|---|
| `--allowedTools 'mcp__x__*'` | ❌ All 26 built-ins remain exposed. `--allowedTools` is a **permission** allowlist, not an availability filter. It governs what may run, not what the model can see. |
| `--tools ''` | ❌ `TOOLS EXPOSED: []` — and this kills the MCP tools too. The MCP server never even connects. |
| **`--tools 'ToolSearch'`** | ✅ `TOOLS EXPOSED: ['ToolSearch']`, MCP tools reachable, and `ToolSearch "select:Bash"` returns *"No matching deferred tools found."* |

The reason `--tools ''` is too much is that **MCP tools are deferred** in Claude
Code 2.1.x. Their schemas are not loaded into the model's context; the model
discovers them by calling `ToolSearch`. That is a sensible design at 170 tools —
but it means ToolSearch is load-bearing. Remove it and your MCP tools become
unreachable, which looks identical to "the bridge is broken."

`--safe-mode` is not an alternative either: it disables MCP as well.

Two things worth doing on top of this: read the `system/init` event and compare
its `tools` array against what you asked for, and surface that comparison to
your client. If a future version starts leaking built-ins back in, you want to
find out from a log line rather than from a surprising `Bash` invocation.

## 2. The part everyone gets wrong: you *can* get structured tool calls

The prevailing wisdom in the Hermes threads — and in more than one shipped
adapter — is this:

> Tool calls come embedded in text, not as JSON-RPC. `claude -p` does not return
> structured tool calls. The adapter must inject tool definitions into the system
> prompt and regex-extract responses.

This is not true, and building on it costs you reliability for no reason. Prompt
injection of tool schemas plus regex extraction gives you malformed JSON,
hallucinated tool names, and a failure mode that degrades silently.

**The trick is to inject your client's tools as a dummy MCP server.**

Write a temporary `mcp.json` pointing at a tiny stdio JSON-RPC server of your
own. That server implements exactly three methods — `initialize`, `tools/list`,
`tools/call` — and `tools/list` returns your client's tool schemas verbatim.
`tools/call` returns a placeholder and **executes nothing**.

Now the model sees real MCP tools. It emits a real, structured `tool_use` block
in the stream-json output, with a proper `id`, `name`, and parsed `input` object.
You lift it straight out of the stream and hand it to your client as an OpenAI
`tool_calls` payload. Your client executes it with its own MCP client, its own
permissions, its own guardrails, and sends the result back as a normal
`role: "tool"` message on the next request.

No regex. No prompt-injected schemas. No hallucinated tool names — the model is
choosing from a list the runtime gave it.

The dummy server is about 130 lines with zero dependencies. That is deliberate:
it is the security boundary of the whole design, and it should be readable end to
end in one sitting.

One implementation detail that bit me: pass the tool definitions to the dummy
server through a **file path in an env var**, not through the env var itself.
Around 200 tools serialise to roughly 100 kB, which is an uncomfortable share of
`ARG_MAX` (1 MB on macOS, shared between argv *and* env). A file also keeps your
tool schemas out of `ps auxe`.

## 3. Stop consuming the stream the instant you capture a `tool_use`

This one produces the most confusing bug in the whole project, so it is worth
stating plainly.

When the model emits `tool_use`, Claude Code does not stop. It calls the tool —
which is your dummy server — gets the placeholder back, and the model dutifully
writes a sentence summarising it. If you are still reading the stream, *that
sentence* becomes the assistant's reply to your user:

> "The result will arrive in a follow-up request."

The user sees that instead of an answer. It is not a crash, nothing logs an
error, and it looks like the model got confused.

The fix is to tear down the moment you capture the tool_use block and refuse to
parse anything further. Note that killing the child process is **not** sufficient
on its own — SIGTERM does not reliably win the race against data already buffered
in your stdout handler. You need an explicit `if (settled) return;` guard at the
top of your line parser. I shipped this bug, found it in review, and it is the
single most likely thing to be wrong in someone else's implementation.

## 4. The 1M context window is a model choice, not a flag

This cost me an afternoon because a wrong answer here returns **HTTP 200**.

Measured on a Max plan, reading `contextWindow` out of `system/init`:

| `--model` | Context | On the subscription |
|---|---|---|
| `claude-sonnet-4-6` | 200 000 | ✅ |
| `claude-sonnet-4-6[1m]` | – | ❌ 429 *"Usage credits required for 1M context"* |
| `claude-opus-4-6` | 200 000 | ✅ |
| `claude-opus-4-6[1m]` | 1 000 000 | ✅ |
| **`claude-sonnet-5`** | **1 000 000** | ✅ default — no beta flag, no `[1m]` suffix |
| `claude-opus-5` | 1 000 000 | ✅ |

So on Sonnet 5 you get the million-token window as standard, while on Sonnet 4.6
the same window requires usage credits. If you have been assuming the context
size follows from a setting in your agent framework — it does not. Your
framework's declared `context_length` is a downstream declaration and changes
nothing.

Two ways to ask for 1M that do **not** work under subscription OAuth:

- `--betas context-1m-2025-08-07` → *"Custom betas are only available for API key
  users. Ignoring provided betas."* The call returns **200 OK** and your context
  is still 200 000. This is the trap. A 200 does not mean the beta took.
- `ANTHROPIC_BETAS=context-1m-2025-08-07` → the beta goes through and you get
  **HTTP 429 "Usage credits required for 1M context"**, with
  `rate_limit_info: {"status":"rejected","overageDisabledReason":"out_of_credits"}`.

Verified end to end on `claude-sonnet-5`: 427 491 prompt tokens, `status: allowed`,
`isUsingOverage: false`, needle found mid-document in a 1.1 MB input, 8.7 s.

Also: model IDs are exact. `claude-sonnet-5` and `claude-opus-5` work.
`sonnet-5`, `opus-5`, and dated suffixes like `claude-sonnet-5-<date>` all 404.
Map aliases explicitly and return a hard 400 on an unknown one rather than
silently substituting a model — silent substitution is how you end up debugging
quality regressions that are really routing bugs.

## 5. The tokenizer changed, and it changes the arithmetic

Models from 4.7 onward use a new tokenizer. On an identical 200 025-character
input:

| Model | Tokens | vs 4.6 |
|---|---|---|
| claude-sonnet-4-6 | 68 230 | – |
| claude-sonnet-5 | 91 832 | **+34.6 %** |
| claude-opus-4-6 | 68 228 | – |
| claude-opus-5 | 86 466 | +26.7 % |

On API pricing, Sonnet 5's lower per-token rate ($2/$10 per MTok vs $3/$15) nets
out to roughly **10 % cheaper**, not 33 %, once you account for ~35 % more tokens
per unit of text.

On a *subscription* the dollar price is irrelevant — what counts against the
five-hour window is token consumption. Which means Sonnet 5 may consume **more**
of your quota per conversation despite the lower list price. I cannot confirm
that from outside; the quota accounting is not exposed at that granularity.
Treat it as an open question and watch `rate_limit_event` rather than assuming
the cheaper model is cheaper for you.

## 6. Read `rate_limit_event` — it is the only honest billing signal

Claude Code emits this in stream-json, and it is the only machine-readable answer
to "which lane did that call bill to":

```json
{"type":"rate_limit_event","rate_limit_info":{
  "status":"allowed","rateLimitType":"five_hour",
  "overageStatus":"rejected","overageDisabledReason":"out_of_credits",
  "isUsingOverage":false,"resetsAt":1787176800}}
```

- `isUsingOverage: false` ⇒ the call came out of the included subscription quota.
- `apiKeySource: "none"` in the init event ⇒ no API key is in play at all.
- `status != "allowed"` ⇒ quota exhausted; your client should fail over.

Surface both to your client and log loudly if `isUsingOverage` ever flips true.

**On the 4500-character system-prompt claim.** There is a widely-cited theory
that more than ~4–4.5 kB of app-specific instructions trips Anthropic's billing
classifier and flips requests into the overage lane. That bisection was performed
against **spoofed direct calls** to `/v1/messages` carrying a
`user-agent: claude-cli/...` header — not against the real binary. I could not
reproduce it through the actual CLI: a ~16 kB system prompt via
`--append-system-prompt` gave `status: allowed`, `isUsingOverage: false`, no 429.

I am not claiming the original report was wrong about what it measured. I am
saying the finding does not transfer to the subprocess approach, and if you have
been truncating your agent's persona to 4500 characters on that basis, you should
re-measure on your own account before accepting the cost.

## 7. Two smaller things that will waste your afternoon

**Give it an empty working directory.** Otherwise `claude` picks up
`~/.claude/CLAUDE.md` and whatever project files are lying around and folds them
into the system prompt. I found this when a model started quoting my personal
infrastructure conventions in a test that had nothing to do with them.
`--setting-sources ""` alone is not enough — you need both that and a dedicated
empty `cwd`.

**Strip hyphens from tool names before exposing them.** MCP permits `-` in tool
names, but Claude Code normalises `-` to `_` somewhere in the deferred-tool path.
So a hyphenated name can come back differently than it went out, silently
breaking your reverse lookup and handing your client a tool name it does not
have. Sanitise to `[A-Za-z0-9_]` on the way out, keep a reverse map, and give the
client back its original strings.

**And: `claude` exits 0 even when the API call failed.** The failure arrives as a
synthetic assistant message (`model: "<synthetic>"`, `is_api_error_message: true`)
and as structured fields on the `result` event. If you do not detect this, your
user gets *"Failed to authenticate. API Error: 401 ..."* as the assistant's reply
instead of a failover. Map it to a real HTTP status — 502 on auth, 429 on quota,
504 on timeout — so your client can do something about it.

---

## The part I would rather you read than skip

Anthropic's [Claude Code legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance)
says, verbatim:

> **OAuth authentication** is intended exclusively for purchasers of Claude Free,
> Pro, Max, Team, and Enterprise subscription plans and is designed to support
> ordinary use of Claude Code and other native Anthropic applications.

> **Developers** building products or services that interact with Claude's
> capabilities, including those using the Agent SDK, should use API key
> authentication through Claude Console or a supported cloud provider. Anthropic
> does not permit third-party developers to offer Claude.ai login or to route
> requests through Free, Pro, or Max plan credentials **on behalf of their users**.

The same page states that advertised Pro/Max limits "assume ordinary, individual
usage", and that Anthropic "reserves the right to take measures to enforce these
restrictions and may do so without prior notice." That enforcement is not
hypothetical — subscription tokens used outside Claude Code have been rejected at
the API layer since early 2026, and at least one high-profile third-party tool
author had their account terminated.

Here is my honest reading, which you are free to reject:

- The prohibition that is actually spelled out targets **third-party developers
  routing other people's requests** through Pro/Max credentials. Offering
  Claude.ai login in a product. Acting as a middleman.
- Running an adapter on your own machine, against your own subscription, for your
  own use, is a different situation from that — and it is also plainly not what
  "ordinary use of Claude Code" is describing.
- **It is a grey area.** I am not a lawyer. If this matters to you commercially,
  or if you would rather not lose your account, read the terms yourself and ask
  Anthropic.
- **Do not run this as a service for other people.** That is the thing the terms
  explicitly prohibit.

I want to be clear about what this is for, because the framing in this corner of
the ecosystem tends to drift toward "how to avoid paying." That is not the pitch.
If you are shipping a product, buy API credits — that is what they are for, and
it is considerably cheaper than losing your account. The pitch is narrower and
more boring: **your own tooling, driving your own Claude Code installation, on
your own machine.**

And it can break at any time. The flags, the stream-json event shapes, the
tool-exposure behaviour, and the server-side policy can all change without
notice. Several findings above were already true only for one specific version.
Do not put this on a critical path without a fallback provider.

---

*Code: [github.com/rz4bz4/claude-max-bridge](https://github.com/rz4bz4/claude-max-bridge) (MIT).
Written by [Reza Sabaro](https://se.linkedin.com/in/reza-s-58288b26).
Not affiliated with, endorsed by, or supported by Anthropic. "Claude" is
Anthropic's trademark.*
