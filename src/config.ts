import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import JSON5 from 'json5';

export interface BridgeConfig {
  server: { host: string; port: number; authToken: string | false };
  claude: { path: string };
  auth: {
    tokenFile: string;
    clearEnv: string[];
    allowMeteredKey: boolean;
  };
  toolLoop: {
    owner: 'client' | 'claude';
    builtinTools: string[];
    mcpServerName: string;
    permissionMode: string;
    strictMcpConfig: boolean;
    settingSources: string;
    injectDiscoveryHint: boolean;
    injectToolNames: boolean;
  };
  systemPrompt: {
    mode: 'append' | 'replace';
    warnOverChars: number;
    detectOverage: boolean;
    overagePatterns: string[];
  };
  workspace: { cwd: string };
  session: { mode: 'stateless' };
  models: Record<string, string>;
  limits: {
    requestTimeoutMs: number;
    maxTurnRawBytes: number;
    maxTurnLines: number;
    maxRequestBodyBytes: number;
  };
  logging: { level: 'debug' | 'info' | 'warn' | 'error' };
}

/** Loopback addresses the bridge considers safe to bind without a token. */
export function isLoopback(host: string): boolean {
  const h = (host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1' || h.startsWith('127.');
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

/** Fail loudly on anything missing or nonsensical. No silent defaults for safety-relevant fields. */
export function loadConfig(path: string): BridgeConfig {
  const abs = resolve(expandHome(path));
  if (!existsSync(abs)) {
    throw new Error(`config not found: ${abs}`);
  }
  const cfg = JSON5.parse(readFileSync(abs, 'utf-8')) as BridgeConfig;

  const need = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(`config error in ${abs}: ${msg}`);
  };

  need(cfg.server?.port, 'server.port missing');
  need(cfg.server?.host, 'server.host missing');

  // Authentication is an explicit decision, not a default. A config that simply
  // omits the key is rejected rather than quietly running an unauthenticated
  // endpoint that any local process — or any web page, via a CORS-safelisted
  // text/plain POST — can spend your subscription quota through.
  if (!('authToken' in (cfg.server ?? {}))) {
    throw new Error(
      `config error in ${abs}: server.authToken is missing. Set it to a shared ` +
        `secret (>= 16 chars) that clients must send as "Authorization: Bearer <token>", ` +
        `or to false to run without authentication on a loopback bind you trust. ` +
        `Generate one with: openssl rand -hex 32`,
    );
  }
  if (cfg.server.authToken !== false) {
    if (typeof cfg.server.authToken !== 'string' || cfg.server.authToken.trim().length === 0) {
      throw new Error(
        `config error in ${abs}: server.authToken must be a non-empty string or the literal false.`,
      );
    }
    if (cfg.server.authToken.trim().length < 16) {
      throw new Error(
        `config error in ${abs}: server.authToken is too short (${cfg.server.authToken.trim().length} chars, ` +
          `minimum 16). Generate one with: openssl rand -hex 32`,
      );
    }
    cfg.server.authToken = cfg.server.authToken.trim();
  }

  // Binding beyond loopback exposes the subscription to anyone who can reach the
  // port. Without a token that is an open relay for someone else's quota, so it
  // is refused rather than warned about.
  if (!isLoopback(cfg.server.host) && cfg.server.authToken === false) {
    throw new Error(
      `config error in ${abs}: server.host="${cfg.server.host}" is not a loopback address ` +
        `and server.authToken is false. Refusing to expose an unauthenticated bridge. ` +
        `Either bind 127.0.0.1 or set a server.authToken.`,
    );
  }
  need(cfg.claude?.path, 'claude.path missing');
  need(cfg.auth?.tokenFile, 'auth.tokenFile missing');
  need(Array.isArray(cfg.auth?.clearEnv), 'auth.clearEnv must be an array');
  need(cfg.toolLoop?.owner, 'toolLoop.owner missing');
  need(Array.isArray(cfg.toolLoop?.builtinTools), 'toolLoop.builtinTools must be an array');
  need(cfg.toolLoop?.mcpServerName, 'toolLoop.mcpServerName missing');
  need(cfg.workspace?.cwd, 'workspace.cwd missing');
  need(cfg.models && Object.keys(cfg.models).length > 0, 'models must map at least one name');

  if (cfg.toolLoop.owner !== 'client') {
    throw new Error(
      `config error in ${abs}: toolLoop.owner="${cfg.toolLoop.owner}" is not implemented. ` +
        `Only "client" (the client owns the tool loop) is supported. See README.`,
    );
  }
  if (cfg.session?.mode !== 'stateless') {
    throw new Error(
      `config error in ${abs}: session.mode="${cfg.session?.mode}" is not implemented. ` +
        `Only "stateless" is supported. See README.`,
    );
  }
  // Allowlist, not blocklist. A blocklist of one string misses "BypassPermissions",
  // a trailing space, and whatever permissive mode ships next.
  const ALLOWED_PERMISSION_MODES = ['default', 'plan', 'acceptEdits'];
  if (!ALLOWED_PERMISSION_MODES.includes(cfg.toolLoop.permissionMode)) {
    throw new Error(
      `config error in ${abs}: toolLoop.permissionMode="${cfg.toolLoop.permissionMode}" is not allowed. ` +
        `Permitted: ${ALLOWED_PERMISSION_MODES.join(', ')}. ` +
        `The bridge must never grant Claude unrestricted tool permissions.`,
    );
  }

  cfg.claude.path = expandHome(cfg.claude.path);
  cfg.auth.tokenFile = expandHome(cfg.auth.tokenFile);
  cfg.workspace.cwd = expandHome(cfg.workspace.cwd);

  return cfg;
}
