# claude-max-bridge

An OpenAI-compatible HTTP endpoint in front of **your own local Claude Code
installation** — with tool-calls that actually work.

It runs the official `claude` binary as a subprocess in its documented headless
mode (`claude -p --output-format stream-json`) and translates between that and
the OpenAI Chat Completions format. Your client keeps its own agent loop, its
own tools, its own memory — and Claude does the thinking.

```
your agent ──tools[]──▶ bridge :8766 ──spawn──▶ claude -p --tools ToolSearch
                                                  │  dummy MCP server
                                                  │  declares schemas, runs nothing
           ◀── tool_calls ──                      │
your agent executes them with its own MCP client
           ──tool_result──▶ bridge ──▶ claude (new process, full history resent)
```

`claude` talks straight to `api.anthropic.com`. **`ANTHROPIC_BASE_URL` is never
set.** The HTTP hop sits between your client and the bridge, not between
`claude` and Anthropic.

> 📄 **[Read the writeup: *Driving Claude Code from your own agent — what actually
> works*](WRITEUP.md)** — the measured findings behind this code, including why
> the common advice about `claude -p` and tool calls is wrong. If you only read
> one thing here, read that.

---

## Read this before you use it

This section is not boilerplate. Please read it.

### What this is

A local adapter around the official `claude` CLI. It:

- spawns the real, unmodified `claude` binary you installed yourself;
- uses its **documented** headless flags (`-p`, `--output-format stream-json`,
  `--mcp-config`, `--tools`, `--append-system-prompt`);
- authenticates the way Claude Code itself authenticates, with a token you
  created yourself via `claude setup-token`.

### What this is **not**

**No spoofing. No forged headers. No bypass. Not a way to avoid paying, and not
something to run for other people.**

Concretely, it does **not** spoof a client identity, forge `user-agent` or other
headers, replay Claude Code's request signatures, or bypass any server-side
validation. There is a whole category of project that does exactly that —
talking to `/v1/messages` directly while pretending to be the CLI. This is not
one of them, and the difference matters: everything Anthropic's servers see here
comes from Anthropic's own binary, doing what its own documented flags tell it
to do.

It is also not a billing trick. If you are shipping a product, buy API credits —
that is what they are for, and it is much cheaper than losing your account.

### The terms question — read it yourself, don't take my word for it

Anthropic's Claude Code
[legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance)
says, verbatim:

> **OAuth authentication** is intended exclusively for purchasers of Claude
> Free, Pro, Max, Team, and Enterprise subscription plans and is designed to
> support ordinary use of Claude Code and other native Anthropic applications.

> **Developers** building products or services that interact with Claude's
> capabilities, including those using the Agent SDK, should use API key
> authentication through Claude Console or a supported cloud provider. Anthropic
> does not permit third-party developers to offer Claude.ai login or to route
> requests through Free, Pro, or Max plan credentials **on behalf of their
> users**.

The same page also states that advertised Pro/Max limits "assume ordinary,
individual usage of Claude Code and the Agent SDK", and that Anthropic
"reserves the right to take measures to enforce these restrictions and may do so
without prior notice."

Here is an honest reading, and the reasoning is yours to accept or reject:

- The prohibition that is spelled out is aimed at **third-party developers
  routing other people's requests** through Pro/Max credentials — offering
  Claude.ai login in a product, acting as a middleman for users.
- Running this on your own machine, with your own subscription, for your own
  use, is a different situation from that. It is also plainly not what
  "ordinary use of Claude Code" is describing.
- **It is a grey area.** I am not a lawyer and this is not legal advice. If
  your usage matters to you — commercially, or because you would rather not
  lose your account — read the terms yourself, and
  [ask Anthropic](https://www.anthropic.com/contact-sales) if in doubt.
- **Do not run this as a service for other people.** That is the thing the
  terms explicitly prohibit. If you are building a product, use an API key.

This is not a way to avoid paying for what you use. It is a way to let your own
tooling drive your own Claude Code installation. If you need Claude in something
you ship, buy API credits — that is what they are for, and it is cheaper than
losing your account.

### It can break at any time

Claude Code's flags, its stream-json event shapes, its tool-exposure behaviour
and Anthropic's server-side policy can all change without notice, and this
bridge will stop working when they do. Several findings documented below were
already true only for one specific version. Do not put this on a critical path
without a fallback provider. Mine has one.

---

## Requirements

- A paid Claude subscription (Pro or Max). This does not work on the free tier.
- Claude Code installed and working — verified against **2.1.220**.
- Node.js 20+.
- macOS. Nothing in the code is macOS-specific except the example launchd agent,
  so it should run on Linux unchanged — but that is untested, so treat Linux as
  unverified rather than supported. Reports welcome.

## Install

```bash
git clone https://github.com/<you>/claude-max-bridge.git
cd claude-max-bridge
npm install && npm run build

cp bridge.config.example.json5 bridge.config.json5
$EDITOR bridge.config.json5     # set claude.path — `which claude`
```

## Authenticate

```bash
claude setup-token
```

This is interactive, requires a browser, and prints a long-lived token starting
with `sk-ant-oat01-`. Write it to the file named in `auth.tokenFile`:

```bash
mkdir -p ~/.config/claude-max-bridge
printf '%s' 'sk-ant-oat01-...' > ~/.config/claude-max-bridge/oauth-token
chmod 600 ~/.config/claude-max-bridge/oauth-token
```

The bridge re-reads this file on **every** spawn and never caches it, so
rotating the token takes effect without a restart. It refuses to start if the
file is missing, empty, or contains an `sk-ant-api...` key — the latter would
bill to API credits, which is the opposite of the point.

`claude auth login` (populating the OS keychain) also works, but the bridge is
built around the token file.

## Run

```bash
node dist/index.js --config ./bridge.config.json5

curl -s http://127.0.0.1:8766/health | python3 -m json.tool
python3 verify.py
```

Point any OpenAI-compatible client at `http://127.0.0.1:8766/v1`, putting your
`server.authToken` in the client's API-key field. Everything under `/v1` requires
it; `/health` stays open so monitoring keeps working.

### Why there is a token at all

An unauthenticated endpoint on localhost is **not** private. `text/plain` is a
CORS-safelisted content type, so any web page you visit can `fetch()` a localhost
port without a preflight. It cannot read the response cross-origin — so this is
not data exfiltration — but it *is* unauthenticated spending of your subscription
quota by any website, on a project whose entire point is quota.

So `server.authToken` is a **required** config key with no default. Set it to a
shared secret of at least 16 characters, or to the literal `false` if you have
read the above and want to run without it on a loopback bind you trust. A config
that omits the key is rejected at startup rather than silently running open.

The bridge also refuses to start on a non-loopback `server.host` when
`authToken` is `false`, and warns loudly on any non-loopback bind.

For running it as a background service, see
[`examples/com.example.claude-max-bridge.plist`](examples/com.example.claude-max-bridge.plist).

---

## The non-obvious findings

This is the actual content of the project. Everything below was measured, not
assumed. All version-specific claims are against **Claude Code 2.1.220** on
**2026-08-19** — verify them yourself before relying on them.

### 1. `--tools ToolSearch` is the recipe. Nothing else works.

| Flags | Outcome |
|---|---|
| `--allowedTools 'mcp__x__*'` | ❌ All 26 built-in tools stay exposed. `--allowedTools` is a *permission* allowlist, not an availability filter. |
| `--tools ''` | ❌ `TOOLS EXPOSED: []` — this also kills the MCP tools. The MCP server never connects. |
| **`--tools 'ToolSearch'`** | ✅ `TOOLS EXPOSED: ['ToolSearch']`, MCP tools reachable, and `ToolSearch "select:Bash"` → *"No matching deferred tools found"*. |

MCP tools are **deferred** in 2.1.x: their schemas are not in the model's
context, and the model has to look them up with `ToolSearch`. That is exactly
what you want at 170 tools — but it means **ToolSearch must survive** or the MCP
tools become unreachable.

`--safe-mode` is not an alternative: it disables MCP too.

The bridge logs a warning if `system/init` reports more tools than
`toolLoop.builtinTools`, and echoes `_bridge.exposedBuiltinTools` on every
**non-streaming** response so you can check from the outside. SSE chunks carry no
`_bridge` block; use `/health` or a non-streaming call to verify.

### 2. The client's tools are injected as a dummy MCP server

The bridge writes a temporary `mcp.json` pointing at
[`src/mcp-dummy.ts`](src/mcp-dummy.ts) — a zero-dependency JSON-RPC server that
declares your tool schemas and **executes nothing**. It answers `tools/call`
with a placeholder.

The bridge watches the `claude` stream for a `tool_use` block, converts it to an
OpenAI `tool_calls` payload, and hands it back to your client. Your client
executes the tool with its own MCP client and sends the result back as a normal
`role: "tool"` message on the next request.

Tool definitions reach the dummy server through a **file**
(`CMB_TOOL_DEFINITIONS_FILE`), not an env var: ~200 tools serialise to ~100 kB,
an uncomfortable share of `ARG_MAX` (1 MB on macOS, shared by argv *and* env) —
and a file also keeps your schemas out of `ps auxe`.

### 3. Stop consuming the stream once you have captured a `tool_use`

If you keep reading the stream after the model has emitted `tool_use`, the dummy
MCP server's placeholder response comes back, the model dutifully summarises it,
and *that* — "the result will arrive in a follow-up request" — leaks to your
client as the assistant's answer.

The bridge calls `finish()` the moment it captures a tool_use block, tears the
process down, and refuses to parse any further events (`if (settled) return;` at
the top of the line handler — SIGTERM alone does not win that race reliably).
See the `assistant` case in [`src/run.ts`](src/run.ts).

### 4. Model IDs are exact, and wrong ones 404

| `--model` | Result |
|---|---|
| `claude-sonnet-5` | ✅ works, 1M context by default |
| `claude-opus-5` | ✅ works, 1M context |
| `sonnet-5`, `opus-5` | ❌ HTTP 404 |
| `claude-sonnet-5-<date>` | ❌ HTTP 404 |

The bridge maps client-facing aliases to these in `models` and returns **HTTP
400** for an unknown alias rather than silently substituting a model.

### 5. The 1M context window comes from the model choice, not a setting

Measured on a Max plan via `system/init` and `modelUsage.contextWindow`:

| `--model` | Context | On the subscription |
|---|---|---|
| `claude-sonnet-4-6` | 200 000 | ✅ |
| `claude-sonnet-4-6[1m]` | – | ❌ HTTP 429 *"Usage credits required for 1M context"* |
| `claude-opus-4-6` | 200 000 | ✅ |
| `claude-opus-4-6[1m]` | 1 000 000 | ✅ |
| **`claude-sonnet-5`** | **1 000 000** | ✅ default — no beta flag, no `[1m]` suffix |
| `claude-opus-5` | 1 000 000 | ✅ |

Two ways to request 1M that do **not** work under subscription OAuth:

- `--betas context-1m-2025-08-07` → *"Custom betas are only available for API key
  users. Ignoring provided betas."* The call returns **200 OK** and the context
  is still 200 000. That is the trap: a 200 does not mean 1M is on.
- `ANTHROPIC_BETAS=context-1m-2025-08-07` → the beta goes through and the API
  answers **HTTP 429 "Usage credits required for 1M context"**.

Verified end to end on `claude-sonnet-5`: **427 491 prompt tokens**,
`status: allowed`, `isUsingOverage: false`, needle found in the middle of a
1.1 MB document, 8.7 s.

### 6. Watch `rate_limit_event`, not the dollar price

`claude` emits this in its stream-json — the only machine-readable signal for
which billing lane a call landed in:

```json
{"type":"rate_limit_event","rate_limit_info":{
  "status":"allowed","rateLimitType":"five_hour",
  "overageStatus":"rejected","overageDisabledReason":"out_of_credits",
  "isUsingOverage":false,"resetsAt":1787176800}}
```

- `isUsingOverage: false` ⇒ the call came out of the included subscription quota.
- `apiKeySource: "none"` in the init event ⇒ no API key is in play.
- `status != "allowed"` ⇒ quota exhausted; your client should fail over.

Both are surfaced in `_bridge` on non-streaming responses and in `/health`, and
the bridge logs `ERROR` if `isUsingOverage` ever turns `true`. (Streaming
responses carry no `_bridge` block — poll `/health` instead.)

**Tokenizer note.** Models from 4.7 onward use a new tokenizer. On an identical
200 025-character input: `claude-sonnet-4-6` → 68 230 tokens;
`claude-sonnet-5` → 91 832 tokens (**+34.6 %**); `claude-opus-5` → 86 466
(+26.7 %). On an API price basis Sonnet 5's lower per-token rate nets out to
roughly 10 % cheaper, not 33 %. On a *subscription* the dollar price is
irrelevant and it is token consumption that counts against the five-hour window
— so Sonnet 5 may well consume *more* of your quota per conversation despite the
lower list price. That is not observable from outside; treat it as an open
question and watch `rate_limit_event`.

**System prompt size.** A claim circulates that more than ~4500 characters of
app-specific instructions flips calls into the overage lane. That bisection was
done against *spoofed direct calls* to `/v1/messages`, not against the real
binary. Measured here with a ~16 kB system prompt via `--append-system-prompt`:
`status: allowed`, `isUsingOverage: false`, no 429. Hence
`systemPrompt.warnOverChars` is a **warning, not a cap**. Measure it yourself and
leave `detectOverage` on.

### 7. Context leakage: give it an empty working directory

Without a dedicated empty `workspace.cwd`, `claude` picks up `~/.claude/CLAUDE.md`
and whatever project files are lying around and folds them into the system
prompt. Observed during development: the model started quoting personal
infrastructure rules in a test that had nothing to do with them.
`--setting-sources ""` alone is not enough — you need both.

### 8. Hyphens in tool names are normalised, so strip them yourself

MCP allows `-` in tool names, but Claude Code normalises `-` to `_` somewhere in
the deferred-tool path, so a hyphenated name can come back different from how it
went out — silently breaking the reverse lookup and handing your client a tool
name it does not have.

The bridge sanitises to `[A-Za-z0-9_]` on the way out and keeps a reverse map, so
your client's original names — hyphens and all — come back unchanged. Regression
tested in `verify.py` T2 and T8.

### 9. `claude` exits 0 even when the API call failed

The failure arrives as a **synthetic assistant message** (`model: "<synthetic>"`,
`is_api_error_message: true`) and as structured fields on the `result` event
(`is_error`, `api_error_status`, `terminal_reason`). Without handling this, your
user gets *"Failed to authenticate. API Error: 401 ..."* as the assistant's reply
instead of a failover.

| Condition | HTTP out | Intended client behaviour |
|---|---|---|
| Token invalid/expired | **502** `authentication_error` + renewal hint | fail over |
| Quota exhausted (429) | **429** with hint | fail over |
| Unknown model | **400** | no silent model substitution |
| Timeout | **504** | fail over |
| Token file missing or holds `sk-ant-api…` | refuses to start (exit 3) | caught at deploy, not in production |

### 10. The model needs to be told the tools exist

Without an explicit discovery hint, the model concluded in roughly **2 out of 3
runs** (on `claude-haiku-4-5`) that the tools simply were not available, and
answered in prose instead of calling `ToolSearch`. `toolLoop.injectDiscoveryHint`
adds a short factual note; see [`src/hint.ts`](src/hint.ts).

---

## Configuration

Everything lives in `bridge.config.json5`. No environment variable changes
behaviour — deliberately, so that a reader six months from now finds everything
in one place. Start from `bridge.config.example.json5`, which documents every
key inline.

The choices that matter:

| Key | Why |
|---|---|
| `server.authToken` | Required. See "Why there is a token at all". |
| `toolLoop.builtinTools: ["ToolSearch"]` | Finding 1. Don't change it without running `verify.py`. |
| `toolLoop.permissionMode: "default"` | `bypassPermissions` is refused by `config.ts`. |
| `toolLoop.strictMcpConfig: true` | Blocks `~/.claude.json` and project-local `.mcp.json`. |
| `auth.clearEnv` | Scrubs metered-billing vectors out of the child process. |
| `workspace.cwd` | Empty directory — finding 7. |
| `session.mode: "stateless"` | The client owns history; the two sides can't diverge. |

## Endpoints

| Method | Path | Auth | |
|---|---|---|---|
| POST | `/v1/chat/completions` | required | streaming and non-streaming |
| GET | `/v1/models` | required | configured aliases |
| GET | `/health` | open | auth posture, latest quota info, error counters |

`/health` deliberately reports `tokenFileConfigured: true/false` rather than the
path, which would disclose your local username.

## Not implemented

- **`toolLoop.owner: "claude"`** — a harness mode where Claude runs real MCP
  servers and owns the loop itself. More efficient (one session, native caching)
  but your client's guardrails, memory and compaction do not participate.
  `config.ts` refuses to start with that value rather than pretending.
- **`session.mode: "resume"`** — would save tokens via `--session-id`/`--resume`
  between tool rounds, but introduces the risk of the client's history and
  Claude's diverging. Measure the token cost before building it.
- **Prompt-injection hardening.** The transcript flattener in `src/openai.ts`
  builds the prompt with plain `User:` / `Assistant:` / `<tool_result>` framing
  and does not escape content. A tool result — i.e. data your client fetched from
  somewhere, possibly attacker-controlled — that contains `</tool_result>` or a
  forged turn marker can inject turn boundaries. Treat tool output as untrusted
  and sanitise it on the client side.
- **Images.** `image_url` blocks are replaced with a placeholder.
- **`/v1/messages`** (Anthropic format). OpenAI Chat Completions only.

## Layout

```
bridge.config.example.json5   all configuration, documented inline
src/config.ts                 loading + fail-closed validation
src/auth.ts                   token, env scrubbing, failure patterns
src/args.ts                   argv for claude — commented choice by choice
src/mcp-dummy.ts              dummy MCP, zero deps, never executes anything
src/run.ts                    spawn + stream-json parsing + tool_use capture
src/openai.ts                 OpenAI protocol in/out
src/index.ts                  HTTP server
verify.py                     end-to-end tests against a live bridge
examples/                     launchd agent example
```

## Author

Reza Sabaro — [LinkedIn](https://se.linkedin.com/in/reza-s-58288b26) ·
[GitHub](https://github.com/rz4bz4)

Issues and pull requests welcome, particularly for the gaps listed under "Not
implemented" and for a first-class auth check on the HTTP layer.

## License

[MIT](LICENSE).

Not affiliated with, endorsed by, or supported by Anthropic. "Claude" is
Anthropic's trademark. Use at your own risk, on your own account, under terms you
have read yourself.
