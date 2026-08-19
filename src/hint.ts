import type { BridgeConfig } from './config.js';
import type { ExposedTool } from './toolmap.js';

/**
 * Discovery hint appended to the system prompt when tools are present.
 *
 * Why this exists: MCP tools are *deferred* in Claude Code 2.1.x — they are not
 * in the model's context until it calls ToolSearch. Without an explicit hint the
 * model frequently concluded the tools simply did not exist and answered with
 * prose like "that tool is not available to me via Claude Code" instead of
 * looking it up. Measured on claude-haiku-4-5: roughly 2 failures in 3 runs.
 *
 * The hint is deliberately short and factual. It does not tell the model what to
 * do with the tools — only that they exist and how to reach them.
 */
export function buildDiscoveryHint(cfg: BridgeConfig, tools: ExposedTool[]): string {
  if (!cfg.toolLoop.injectDiscoveryHint || tools.length === 0) return '';

  const server = cfg.toolLoop.mcpServerName;
  const lines = [
    '# Available tools',
    '',
    `You have ${tools.length} tools via the MCP server \`${server}\`. They are *deferred*:`,
    'they do not appear in your tool list until you look them up with `ToolSearch`.',
    '',
    'How to use them:',
    `1. Call \`ToolSearch\` with \`select:mcp__${server}__<name>\` for an exact lookup,`,
    '   or with keywords for a fuzzy search.',
    '2. Call the tool directly using its full name.',
    '',
    'These tools DO exist. Never claim they are missing, and never propose a manual',
    'workaround for something a tool already does. If the first search misses, search',
    'again with a different keyword.',
  ];

  if (cfg.toolLoop.injectToolNames) {
    lines.push('', 'Names (without prefix):', tools.map((t) => t.name).join(', '));
  }

  return lines.join('\n');
}
