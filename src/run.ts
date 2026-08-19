import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import type { BridgeConfig } from './config.js';
import { buildArgs } from './args.js';
import { readToken, buildChildEnv, looksLikeAuthFailure, AuthError, RENEW_HINT } from './auth.js';
import { toClientToolName, type ExposedTool } from './toolmap.js';
import { log } from './logger.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DUMMY_MCP = join(HERE, 'mcp-dummy.js');

export interface CapturedToolCall {
  id: string;
  name: string; // client's original tool name
  argumentsJson: string;
}

export interface RunResult {
  kind: 'text' | 'tool_calls';
  text: string;
  toolCalls: CapturedToolCall[];
  usage: { promptTokens: number; completionTokens: number };
  /** From the stream-json init event. "none" means no API key — subscription auth. */
  apiKeySource: string | null;
  exposedBuiltinTools: string[] | null;
  sessionId: string | null;
  /** Model id echoed by claude in system/init — the ground truth for what answered. */
  resolvedModel: string | null;
  /** From the stream-json rate_limit_event. The authoritative quota signal. */
  rateLimit: RateLimitInfo | null;
}

/**
 * Emitted by claude as `{"type":"rate_limit_event","rate_limit_info":{...}}`.
 * This is the only machine-readable proof of which billing lane a call used.
 *   isUsingOverage=false  -> the call came out of the included subscription quota
 *   status!=="allowed"    -> quota exhausted; the client should fail over
 */
export interface RateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  overageStatus?: string;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
}

export class BridgeRunError extends Error {
  readonly status: number;
  readonly hint?: string;
  constructor(message: string, status: number, hint?: string) {
    super(message);
    this.name = 'BridgeRunError';
    this.status = status;
    this.hint = hint;
  }
}

export interface RunInput {
  model: string;
  systemPrompt?: string;
  prompt: string;
  tools: ExposedTool[];
  reverseToolMap: Record<string, string>;
  effort?: string;
  onTextDelta?: (delta: string) => void;
}

export async function runClaude(cfg: BridgeConfig, input: RunInput): Promise<RunResult> {
  const token = readToken(cfg); // throws AuthError; re-read every spawn
  mkdirSync(cfg.workspace.cwd, { recursive: true });

  const tempDir = mkdtempSync(join(tmpdir(), 'claude-max-bridge-'));
  let mcpConfigPath: string | undefined;
  const childEnv = buildChildEnv(cfg, token);

  if (input.tools.length > 0) {
    const toolDefsPath = join(tempDir, 'tools.json');
    writeFileSync(toolDefsPath, JSON.stringify(input.tools), { mode: 0o600 });
    mcpConfigPath = join(tempDir, 'mcp.json');
    writeFileSync(
      mcpConfigPath,
      JSON.stringify(
        {
          mcpServers: {
            [cfg.toolLoop.mcpServerName]: {
              command: process.execPath,
              args: [DUMMY_MCP],
              env: { CMB_TOOL_DEFINITIONS_FILE: toolDefsPath },
            },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }

  const args = buildArgs(cfg, {
    model: input.model,
    systemPrompt: input.systemPrompt,
    mcpConfigPath,
    effort: input.effort,
  });

  const started = Date.now();
  log.info('spawning claude', {
    model: input.model,
    tools: input.tools.length,
    builtinTools: cfg.toolLoop.builtinTools,
    systemPromptChars: input.systemPrompt?.length ?? 0,
    promptChars: input.prompt.length,
  });

  return await new Promise<RunResult>((resolvePromise, rejectPromise) => {
    const child = spawn(cfg.claude.path, args, {
      cwd: cfg.workspace.cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const result: RunResult = {
      kind: 'text',
      text: '',
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0 },
      apiKeySource: null,
      exposedBuiltinTools: null,
      sessionId: null,
      resolvedModel: null,
      rateLimit: null,
    };

    let settled = false;
    let stdoutBuf = '';
    let stderrBuf = '';
    let rawBytes = 0;
    let lines = 0;

    const cleanup = () => {
      clearTimeout(timer);
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    };

    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      log.info('run finished', {
        kind: r.kind,
        toolCalls: r.toolCalls.length,
        apiKeySource: r.apiKeySource,
        ms: Date.now() - started,
      });
      resolvePromise(r);
    };

    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      rejectPromise(e);
    };

    const timer = setTimeout(() => {
      fail(new BridgeRunError(`claude did not finish within ${cfg.limits.requestTimeoutMs} ms`, 504));
    }, cfg.limits.requestTimeoutMs);

    child.on('error', (err) => {
      fail(new BridgeRunError(`failed to spawn ${cfg.claude.path}: ${err.message}`, 502));
    });

    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (d: string) => {
      stderrBuf += d;
      if (stderrBuf.length > 64_000) stderrBuf = stderrBuf.slice(-64_000);
    });

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      rawBytes += chunk.length;
      if (rawBytes > cfg.limits.maxTurnRawBytes) {
        fail(new BridgeRunError('claude output exceeded limits.maxTurnRawBytes', 502));
        return;
      }
      stdoutBuf += chunk;
      let idx: number;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        lines += 1;
        if (lines > cfg.limits.maxTurnLines) {
          fail(new BridgeRunError('claude output exceeded limits.maxTurnLines', 502));
          return;
        }
        if (line) handleLine(line);
      }
    });

    child.on('close', (code) => {
      if (settled) return;
      const combined = `${stderrBuf}\n${stdoutBuf}`;
      if (looksLikeAuthFailure(combined)) {
        fail(
          new AuthError(
            `claude rejected the subscription OAuth token (exit ${code}). ${firstLine(stderrBuf)}`,
            RENEW_HINT,
          ),
        );
        return;
      }
      if (code !== 0 && !result.text && result.toolCalls.length === 0) {
        fail(new BridgeRunError(`claude exited ${code}: ${firstLine(stderrBuf) || 'no output'}`, 502));
        return;
      }
      finish(result);
    });

    function handleLine(line: string): void {
      // Once we have settled (typically on a captured tool_use), stop parsing.
      // Without this, the dummy MCP server's placeholder response comes back,
      // the model summarises it, and that text leaks into the already-resolved
      // result — and, when streaming, gets written after res.end().
      if (settled) return;

      let evt: Record<string, any>;
      try {
        evt = JSON.parse(line);
      } catch {
        return;
      }

      switch (evt.type) {
        case 'system': {
          if (evt.subtype === 'init') {
            result.apiKeySource = evt.apiKeySource ?? null;
            result.exposedBuiltinTools = Array.isArray(evt.tools) ? evt.tools : null;
            result.sessionId = evt.session_id ?? null;
            result.resolvedModel = evt.model ?? null;
            // Loud, because this is the whole point of the bridge.
            if (result.apiKeySource && result.apiKeySource !== 'none') {
              log.warn('claude reports an API key source — this may bill to API credits, not the subscription', {
                apiKeySource: result.apiKeySource,
              });
            }
            const leaked = (result.exposedBuiltinTools ?? []).filter(
              (t) => !cfg.toolLoop.builtinTools.includes(t),
            );
            if (leaked.length) {
              log.warn('native tools are exposed beyond toolLoop.builtinTools', { leaked });
            }
          }
          return;
        }

        case 'assistant': {
          // Claude Code surfaces API failures as a synthetic assistant message
          // (model:"<synthetic>", is_api_error_message:true). Never let that
          // become the assistant's reply — the client must fail over instead.
          if (evt.is_api_error_message === true || evt.message?.model === '<synthetic>') {
            log.warn('synthetic API-error message from claude — not treating it as a reply', {
              error: evt.error,
            });
            return;
          }
          // Capture usage here too: when we stop at tool_use we never reach the
          // `result` event, and a client that budgets context off token counts
          // would otherwise see zeros on every tool round-trip.
          const au = evt.message?.usage;
          if (au) {
            result.usage.promptTokens =
              (au.input_tokens ?? 0) +
              (au.cache_read_input_tokens ?? 0) +
              (au.cache_creation_input_tokens ?? 0);
            result.usage.completionTokens = au.output_tokens ?? 0;
          }
          const content = evt.message?.content ?? [];
          const calls: CapturedToolCall[] = [];
          for (const block of content) {
            if (block?.type === 'text' && typeof block.text === 'string') {
              result.text += block.text;
              input.onTextDelta?.(block.text);
            } else if (block?.type === 'tool_use') {
              const clientName = toClientToolName(
                String(block.name ?? ''),
                cfg.toolLoop.mcpServerName,
                input.reverseToolMap,
              );
              if (clientName) {
                calls.push({
                  id: String(block.id ?? `call_${calls.length}`),
                  name: clientName,
                  argumentsJson: JSON.stringify(block.input ?? {}),
                });
              } else {
                // A built-in tool. Should be impossible with --tools ToolSearch,
                // except ToolSearch itself, which is Claude's own discovery step.
                if (block.name !== 'ToolSearch') {
                  log.warn('claude attempted a non-client tool — ignoring', { tool: block.name });
                }
              }
            }
          }
          if (calls.length > 0) {
            result.kind = 'tool_calls';
            result.toolCalls = calls;
            // Stop here: the client owns execution.
            finish(result);
          }
          return;
        }

        case 'rate_limit_event': {
          const info = (evt.rate_limit_info ?? {}) as RateLimitInfo;
          result.rateLimit = info;
          if (info.isUsingOverage === true) {
            log.error('BILLED AS OVERAGE — this call did NOT come out of the subscription quota', {
              rateLimitType: info.rateLimitType,
              overageStatus: info.overageStatus,
            });
          } else {
            log.debug('quota', {
              status: info.status,
              type: info.rateLimitType,
              isUsingOverage: info.isUsingOverage,
              resetsAt: info.resetsAt,
            });
          }
          if (info.status && info.status !== 'allowed') {
            log.warn('subscription quota not in "allowed" state', {
              status: info.status,
              resetsAt: info.resetsAt,
              overageDisabledReason: info.overageDisabledReason,
            });
          }
          return;
        }

        case 'result': {
          // Claude Code exits 0 even when the API call failed. The failure is
          // structured: is_error, api_error_status, terminal_reason. Without
          // this the client would treat "Failed to authenticate. API Error:
          // 401 ..." as a valid reply from the model and never fail over.
          const finalText = typeof evt.result === 'string' ? evt.result : '';
          const apiStatus = typeof evt.api_error_status === 'number' ? evt.api_error_status : null;
          const hadRealOutput = Boolean(result.text) || result.toolCalls.length > 0;

          if (!hadRealOutput && (evt.is_error === true || apiStatus !== null)) {
            const detail = finalText.trim().slice(0, 300) || evt.terminal_reason || 'unknown';
            if (apiStatus === 401 || apiStatus === 403 || looksLikeAuthFailure(finalText)) {
              fail(new AuthError(`claude could not authenticate (HTTP ${apiStatus}): ${detail}`, RENEW_HINT));
              return;
            }
            if (apiStatus === 429) {
              fail(
                new BridgeRunError(
                  `subscription quota exhausted or rate limited (HTTP 429): ${detail}`,
                  429,
                  'The client should fail over to its fallback provider until the quota window resets.',
                ),
              );
              return;
            }
            fail(new BridgeRunError(`claude reported an error: ${detail}`, 502));
            return;
          }

          const u = evt.usage ?? {};
          result.usage.promptTokens =
            (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          result.usage.completionTokens = u.output_tokens ?? 0;
          if (typeof evt.result === 'string' && !result.text) result.text = evt.result;

          if (cfg.systemPrompt.detectOverage) {
            const hay = `${evt.result ?? ''} ${evt.api_error_status ?? ''} ${stderrBuf}`.toLowerCase();
            for (const p of cfg.systemPrompt.overagePatterns) {
              if (hay.includes(p.toLowerCase())) {
                log.error('OVERAGE SIGNATURE DETECTED — request was likely billed outside the subscription', {
                  pattern: p,
                  systemPromptChars: input.systemPrompt?.length ?? 0,
                });
              }
            }
          }
          finish(result);
          return;
        }

        default:
          return;
      }
    }

    child.stdin.write(input.prompt);
    child.stdin.end();
  });
}

function firstLine(s: string): string {
  return (s || '').split('\n').find((l) => l.trim())?.trim().slice(0, 300) ?? '';
}
