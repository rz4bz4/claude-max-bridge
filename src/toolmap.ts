/**
 * Tool-name mapping between the client's names and MCP-legal names.
 *
 * Clients often use names like `mcp_some-server_do_thing`. MCP tool names must
 * match /^[A-Za-z0-9_-]{1,64}$/ and Claude Code additionally prefixes them as
 * `mcp__<server>__<tool>`, so we normalise and keep a reverse map. The bridge is
 * deliberately agnostic about the client's naming convention — whatever comes
 * in, comes back out unchanged.
 */

export interface OpenAiTool {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ExposedTool {
  name: string; // MCP-legal name
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolMapping {
  exposed: ExposedTool[];
  /** MCP-legal name -> original client name */
  reverse: Record<string, string>;
}

// Deliberately excludes '-'. MCP itself allows hyphens, but Claude Code
// normalises '-' to '_' somewhere in the deferred-tool (ToolSearch) path, so a
// hyphenated exposed name can come back different from how it went out — which
// silently breaks the reverse lookup and hands the client a tool name it does
// not have. Forcing underscores on the way out removes the ambiguity.
const LEGAL = /[^A-Za-z0-9_]/g;

function sanitize(name: string): string {
  let s = name.replace(LEGAL, '_');
  if (s.length > 64) s = s.slice(0, 64);
  if (!s) s = 'tool';
  return s;
}

export function buildToolMapping(tools: OpenAiTool[] | undefined): ToolMapping {
  const exposed: ExposedTool[] = [];
  const reverse: Record<string, string> = {};
  const used = new Set<string>();

  for (const t of tools ?? []) {
    const fn = t?.function;
    const original = fn?.name;
    if (!original) continue;

    let mcpName = sanitize(original);
    if (used.has(mcpName)) {
      let i = 2;
      while (used.has(`${mcpName.slice(0, 60)}_${i}`)) i += 1;
      mcpName = `${mcpName.slice(0, 60)}_${i}`;
    }
    used.add(mcpName);
    reverse[mcpName] = original;

    const schema = (fn.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>;
    exposed.push({
      name: mcpName,
      description: fn.description ?? '',
      inputSchema: schema,
    });
  }

  return { exposed, reverse };
}

/** Strip `mcp__<server>__` and map back to the client's original tool name. */
export function toClientToolName(
  claudeToolName: string,
  mcpServerName: string,
  reverse: Record<string, string>,
): string | null {
  const prefix = `mcp__${mcpServerName}__`;
  if (!claudeToolName.startsWith(prefix)) return null;
  const stripped = claudeToolName.slice(prefix.length);
  // Belt and braces: exact key first, then the '-'->'_' normalised key, in case
  // a future Claude Code version round-trips the name differently again.
  return reverse[stripped] ?? reverse[stripped.replace(/-/g, '_')] ?? stripped;
}
