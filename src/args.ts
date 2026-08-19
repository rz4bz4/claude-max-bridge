import type { BridgeConfig } from './config.js';

export interface ArgsInput {
  model: string; // already mapped to a claude model id
  systemPrompt?: string;
  mcpConfigPath?: string; // set when tools were supplied
  effort?: string;
}

/**
 * Build the argv for one `claude` run.
 *
 * Deliberate choices, each verified against Claude Code 2.1.220 on 2026-08-19:
 *
 *  --tools <builtinTools>      The ONLY reliable way to keep Claude's native
 *                              tools out. `--allowedTools` is a permission
 *                              allowlist, not an availability filter: with it
 *                              alone, all 26 built-ins stay exposed.
 *                              `--tools ""` goes too far and kills MCP tools
 *                              as well, so ToolSearch must remain.
 *  --strict-mcp-config         Ignore ~/.claude.json and project .mcp.json.
 *  --permission-mode default   Never bypassPermissions.
 *  --no-session-persistence    Stateless; the client owns history.
 *  (no --dangerously-skip-permissions, no ANTHROPIC_BASE_URL)
 */
export function buildArgs(cfg: BridgeConfig, input: ArgsInput): string[] {
  const args: string[] = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--setting-sources',
    cfg.toolLoop.settingSources, // "" = none; keeps ~/.claude/CLAUDE.md out
    '--permission-mode',
    cfg.toolLoop.permissionMode,
    '--model',
    input.model,
  ];

  // Built-in tool surface. Empty array => text-only.
  args.push('--tools', cfg.toolLoop.builtinTools.join(','));

  if (input.mcpConfigPath) {
    if (cfg.toolLoop.strictMcpConfig) args.push('--strict-mcp-config');
    args.push('--mcp-config', input.mcpConfigPath);

    const allowed = [`mcp__${cfg.toolLoop.mcpServerName}__*`, ...cfg.toolLoop.builtinTools];
    args.push('--allowedTools', allowed.join(' '));
  } else {
    // No tools requested: hard-isolate MCP so nothing can be reached.
    if (cfg.toolLoop.strictMcpConfig) args.push('--strict-mcp-config');
    args.push('--mcp-config', JSON.stringify({ mcpServers: {} }));
  }

  if (input.systemPrompt) {
    args.push(
      cfg.systemPrompt.mode === 'replace' ? '--system-prompt' : '--append-system-prompt',
      input.systemPrompt,
    );
  }

  if (input.effort) args.push('--effort', input.effort);

  return args;
}
