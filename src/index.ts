#!/usr/bin/env node
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { loadConfig, isLoopback, type BridgeConfig } from './config.js';
import { setLogLevel, log } from './logger.js';
import { verifyAuthAtStartup, AuthError } from './auth.js';
import { buildToolMapping } from './toolmap.js';
import { buildDiscoveryHint } from './hint.js';
import { runClaude, BridgeRunError, type RunResult } from './run.js';
import {
  flattenMessages,
  buildCompletion,
  sseChunk,
  sseToolCallsChunk,
  type ChatCompletionRequest,
} from './openai.js';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const configPath =
  argValue('--config') ??
  process.env.CMB_CONFIG ??
  new URL('../bridge.config.json5', import.meta.url).pathname;

let cfg: BridgeConfig;
try {
  cfg = loadConfig(configPath);
} catch (e) {
  process.stderr.write(`claude-max-bridge: ${(e as Error).message}\n`);
  process.exit(2);
}

setLogLevel(cfg.logging?.level ?? 'info');

try {
  verifyAuthAtStartup(cfg);
} catch (e) {
  const err = e as AuthError;
  log.error(`refusing to start: ${err.message}`);
  if (err.hint) log.error(err.hint);
  process.exit(3);
}

if (cfg.server.authToken === false) {
  log.warn(
    'server.authToken=false — this endpoint is UNAUTHENTICATED. Any local process, ' +
      'and any web page you visit (via a CORS-safelisted text/plain POST), can spend ' +
      'your subscription quota through it. Set server.authToken to a shared secret.',
  );
}
if (!isLoopback(cfg.server.host)) {
  log.warn(
    `server.host=${cfg.server.host} is not a loopback address — the bridge is reachable ` +
      'off this machine. Make sure that is what you intended.',
  );
}

log.info('claude-max-bridge starting', {
  config: configPath,
  claude: cfg.claude.path,
  builtinTools: cfg.toolLoop.builtinTools,
  permissionMode: cfg.toolLoop.permissionMode,
  toolLoopOwner: cfg.toolLoop.owner,
  models: Object.keys(cfg.models),
});

/** Health state, so failures are visible without grepping logs. */
const health = {
  lastError: null as string | null,
  lastErrorAt: null as string | null,
  lastOkAt: null as string | null,
  lastApiKeySource: null as string | null,
  lastRateLimit: null as unknown,
  overageSeen: false,
  requests: 0,
  authFailures: 0,
  authRejections: 0,
};

/**
 * Constant-time comparison of the presented bearer token against the configured
 * one. Length is compared first because timingSafeEqual throws on a mismatch.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Returns null when the request is authorised, or an error message when it is not.
 *
 * Accepts `Authorization: Bearer <token>` (what OpenAI-compatible clients already
 * send as their API key) and a bare `Authorization: <token>` for convenience.
 */
function checkAuth(req: http.IncomingMessage): string | null {
  if (cfg.server.authToken === false) return null;

  const header = req.headers.authorization;
  if (!header) {
    return (
      'missing Authorization header. This bridge requires a shared secret: send it as ' +
      '"Authorization: Bearer <token>". In an OpenAI-compatible client, put the token ' +
      'in the API-key field. The expected value is server.authToken in your bridge config.'
    );
  }

  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : header.trim();
  if (!presented) {
    return 'Authorization header is present but empty.';
  }
  if (!tokenMatches(presented, cfg.server.authToken)) {
    return (
      'invalid token. The value must match server.authToken in your bridge config ' +
      '(not your Anthropic key — the bridge never accepts one over HTTP).'
    );
  }
  return null;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
}

function errorBody(message: string, type: string, hint?: string) {
  return { error: { message: hint ? `${message} — ${hint}` : message, type, code: type } };
}

function readBody(req: http.IncomingMessage, max: number): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        rejectPromise(new BridgeRunError('request body too large', 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', rejectPromise);
  });
}

function resolveModel(name: string | undefined): string {
  const key = (name ?? '').trim();
  const mapped = cfg.models[key];
  if (!mapped) {
    throw new BridgeRunError(
      `unknown model "${key}". Configured: ${Object.keys(cfg.models).join(', ')}`,
      400,
    );
  }
  return mapped;
}

async function handleChatCompletions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const raw = await readBody(req, cfg.limits.maxRequestBodyBytes);
  let body: ChatCompletionRequest;
  try {
    body = JSON.parse(raw);
  } catch {
    json(res, 400, errorBody('invalid JSON body', 'invalid_request_error'));
    return;
  }

  const model = resolveModel(body.model);
  const flat = flattenMessages(body.messages ?? []);
  const { exposed, reverse } = buildToolMapping(body.tools as never);

  const hint = buildDiscoveryHint(cfg, exposed);
  const systemPrompt = hint ? (flat.systemPrompt ? `${flat.systemPrompt}\n\n${hint}` : hint) : flat.systemPrompt;
  const prompt = flat.prompt;

  if (systemPrompt.length > cfg.systemPrompt.warnOverChars) {
    log.warn('system prompt exceeds warnOverChars', {
      chars: systemPrompt.length,
      threshold: cfg.systemPrompt.warnOverChars,
      note: 'see README: billing-classifier caveat',
    });
  }

  health.requests += 1;
  const streaming = body.stream === true;
  const id = `chatcmpl-${Date.now().toString(36)}`;

  if (!streaming) {
    const r = await runClaude(cfg, {
      model,
      systemPrompt: systemPrompt || undefined,
      prompt,
      tools: exposed,
      reverseToolMap: reverse,
      effort: body.reasoning_effort,
    });
    health.lastOkAt = new Date().toISOString();
    health.lastApiKeySource = r.apiKeySource;
    health.lastRateLimit = r.rateLimit;
    if (r.rateLimit?.isUsingOverage === true) health.overageSeen = true;
    json(res, 200, buildCompletion(cfg, body.model ?? model, r));
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(sseChunk(body.model ?? model, id, { role: 'assistant', content: '' }, null));

  let r: RunResult;
  try {
    r = await runClaude(cfg, {
      model,
      systemPrompt: systemPrompt || undefined,
      prompt,
      tools: exposed,
      reverseToolMap: reverse,
      effort: body.reasoning_effort,
      onTextDelta: (d) => res.write(sseChunk(body.model ?? model, id, { content: d }, null)),
    });
  } catch (e) {
    // Stream already open: surface the error inside the stream, then close.
    const msg = e instanceof AuthError ? `${e.message} — ${e.hint}` : (e as Error).message;
    res.write(`data: ${JSON.stringify({ error: { message: msg, type: 'bridge_error' } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    recordError(e as Error);
    return;
  }

  health.lastOkAt = new Date().toISOString();
  health.lastApiKeySource = r.apiKeySource;
  health.lastRateLimit = r.rateLimit;
  if (r.rateLimit?.isUsingOverage === true) health.overageSeen = true;

  if (r.kind === 'tool_calls') {
    res.write(sseToolCallsChunk(body.model ?? model, id, r.toolCalls));
    res.write(sseChunk(body.model ?? model, id, {}, 'tool_calls'));
  } else {
    res.write(sseChunk(body.model ?? model, id, {}, 'stop'));
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

function recordError(e: Error): void {
  health.lastError = e.message;
  health.lastErrorAt = new Date().toISOString();
  if (e instanceof AuthError) health.authFailures += 1;
}

const server = http.createServer((req, res) => {
  const url = (req.url ?? '').split('?')[0];

  if (req.method === 'GET' && url === '/health') {
    json(res, 200, {
      status: health.authFailures > 0 && !health.lastOkAt ? 'degraded' : 'ok',
      toolLoopOwner: cfg.toolLoop.owner,
      builtinTools: cfg.toolLoop.builtinTools,
      permissionMode: cfg.toolLoop.permissionMode,
      // Deliberately not the path — that discloses the local username. /health is
      // intentionally readable without a token so it stays usable for monitoring.
      tokenFileConfigured: Boolean(cfg.auth.tokenFile),
      authRequired: cfg.server.authToken !== false,
      ...health,
    });
    return;
  }

  // /health is deliberately open (monitoring); everything under /v1 is gated.
  if (url.startsWith('/v1/')) {
    const problem = checkAuth(req);
    if (problem) {
      health.authRejections += 1;
      log.warn('rejected unauthenticated request', { url, method: req.method });
      json(res, 401, errorBody(problem, 'authentication_error'));
      return;
    }
  }

  if (req.method === 'GET' && url === '/v1/models') {
    json(res, 200, {
      object: 'list',
      data: Object.keys(cfg.models).map((id) => ({
        id,
        object: 'model',
        owned_by: 'claude-max-bridge',
        _claude_model: cfg.models[id],
      })),
    });
    return;
  }

  if (req.method === 'POST' && url === '/v1/chat/completions') {
    handleChatCompletions(req, res).catch((e: Error) => {
      recordError(e);
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
        return;
      }
      if (e instanceof AuthError) {
        log.error(`auth failure: ${e.message}`);
        log.error(e.hint);
        json(res, 502, errorBody(e.message, 'authentication_error', e.hint));
        return;
      }
      if (e instanceof BridgeRunError) {
        log.error(`run failure (${e.status}): ${e.message}`);
        json(res, e.status, errorBody(e.message, 'bridge_error', e.hint));
        return;
      }
      log.error(`unexpected failure: ${e.message}`);
      json(res, 500, errorBody(e.message, 'internal_error'));
    });
    return;
  }

  json(res, 404, errorBody(`no route for ${req.method} ${url}`, 'not_found'));
});

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    log.error(
      `port ${cfg.server.port} is already in use on ${cfg.server.host}. ` +
        `Another bridge instance is probably running — check: lsof -nP -iTCP:${cfg.server.port} -sTCP:LISTEN`,
    );
    process.exit(4);
  }
  log.error(`server error: ${e.message}`);
  process.exit(5);
});

server.listen(cfg.server.port, cfg.server.host, () => {
  log.info(`listening on http://${cfg.server.host}:${cfg.server.port}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info(`${sig} — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
