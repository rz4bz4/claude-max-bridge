import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import JSON5 from 'json5';

export interface BridgeConfig {
  server: { host: string; port: number };
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
  if (cfg.toolLoop.permissionMode === 'bypassPermissions') {
    throw new Error(
      `config error in ${abs}: toolLoop.permissionMode=bypassPermissions is refused by design. ` +
        `The bridge must never grant Claude unrestricted tool permissions.`,
    );
  }

  cfg.claude.path = expandHome(cfg.claude.path);
  cfg.auth.tokenFile = expandHome(cfg.auth.tokenFile);
  cfg.workspace.cwd = expandHome(cfg.workspace.cwd);

  return cfg;
}
