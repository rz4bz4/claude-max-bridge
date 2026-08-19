import { readFileSync, existsSync, statSync } from 'node:fs';
import type { BridgeConfig } from './config.js';
import { log } from './logger.js';

export class AuthError extends Error {
  readonly hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.name = 'AuthError';
    this.hint = hint;
  }
}

const RENEW_HINT =
  'Renew with: claude setup-token  (interactive, requires a Claude subscription), ' +
  'then write the sk-ant-oat01-... value to the tokenFile with mode 0600. ' +
  'Alternative: claude auth login, which repopulates the macOS keychain instead.';

/**
 * Read the OAuth token from disk. Called on EVERY spawn, never cached, so a
 * rotated token takes effect without restarting the bridge.
 */
export function readToken(cfg: BridgeConfig): string {
  const file = cfg.auth.tokenFile;

  if (!existsSync(file)) {
    throw new AuthError(`OAuth token file not found: ${file}`, RENEW_HINT);
  }

  const st = statSync(file);
  const mode = st.mode & 0o777;
  if (mode & 0o077) {
    log.warn('token file is group/world readable — tighten it', {
      file,
      mode: mode.toString(8),
      fix: `chmod 600 ${file}`,
    });
  }

  const token = readFileSync(file, 'utf-8').trim();

  if (!token) {
    throw new AuthError(`OAuth token file is empty: ${file}`, RENEW_HINT);
  }
  if (!token.startsWith('sk-ant-oat')) {
    if (token.startsWith('sk-ant-api')) {
      throw new AuthError(
        `tokenFile contains a metered API key (sk-ant-api...), not a subscription OAuth token. ` +
          `Refusing: this would bill to API credits instead of the subscription.`,
        RENEW_HINT,
      );
    }
    throw new AuthError(
      `tokenFile does not contain a subscription OAuth token (expected sk-ant-oat...): ${file}`,
      RENEW_HINT,
    );
  }
  return token;
}

/**
 * Scrubbed unconditionally, regardless of what auth.clearEnv says.
 *
 * These are the variables that can silently redirect the call to another
 * endpoint or another billing lane. The config can add to this list; it cannot
 * remove from it. Otherwise "ANTHROPIC_BASE_URL is never set" would be a
 * property of one example config rather than a property of the bridge.
 */
const ALWAYS_CLEAR = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_UNIX_SOCKET',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_VERTEX',
] as const;

function matchesPattern(name: string, pattern: string): boolean {
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

/**
 * Build the child environment.
 *
 * Two guarantees:
 *  1. Every name in auth.clearEnv is removed, so the child cannot fall back to
 *     a metered key, Bedrock/Vertex, or a redirected endpoint.
 *  2. ANTHROPIC_BASE_URL and friends are scrubbed unconditionally via
 *     ALWAYS_CLEAR, so this holds even if someone trims auth.clearEnv.
 *     `claude` talks straight to Anthropic.
 */
export function buildChildEnv(cfg: BridgeConfig, token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const stripped: string[] = [];

  for (const [k, v] of Object.entries(process.env)) {
    if (ALWAYS_CLEAR.includes(k as (typeof ALWAYS_CLEAR)[number])) {
      stripped.push(k);
      continue;
    }
    if (cfg.auth.clearEnv.some((p) => matchesPattern(k, p))) {
      stripped.push(k);
      continue;
    }
    env[k] = v;
  }

  env.CLAUDE_CODE_OAUTH_TOKEN = token;

  if (stripped.length) {
    log.debug('scrubbed env vars before spawn', { names: stripped });
  }
  return env;
}

/** Startup fail-closed check. Throws AuthError if the bridge cannot guarantee subscription billing. */
export function verifyAuthAtStartup(cfg: BridgeConfig): void {
  if (cfg.auth.allowMeteredKey) {
    log.warn('auth.allowMeteredKey=true — metered billing is NOT prevented. This is not the intended mode.');
    return;
  }
  readToken(cfg); // throws with a renewal hint if unusable
  log.info('auth ok: subscription OAuth token present', { tokenFile: cfg.auth.tokenFile });
}

/** Recognise auth failures in claude output so we return a clean 502 instead of hanging. */
export function looksLikeAuthFailure(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes('failed to authenticate') ||
    t.includes('oauth access token is invalid') ||
    t.includes('oauth token is invalid') ||
    t.includes('invalid api key') ||
    t.includes('authentication_error') ||
    t.includes('oauth token has expired') ||
    t.includes('oauth authentication is currently not supported') ||
    t.includes('please run /login') ||
    t.includes('login expired') ||
    t.includes('not logged in') ||
    t.includes('unauthorized') ||
    /\b401\b/.test(t)
  );
}

export { RENEW_HINT };
