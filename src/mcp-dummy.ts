/**
 * Dummy MCP server.
 *
 * Runs as a child of the `claude` process, speaking newline-delimited
 * JSON-RPC over stdio. It declares the client's tool schemas so the model can
 * choose one — and returns a placeholder for every call.
 *
 * IT NEVER EXECUTES ANYTHING. That is the whole point: the client owns the
 * tool loop. The bridge watches the claude stream for `tool_use`, terminates
 * the run, and hands the call back to the client as an OpenAI tool_call.
 *
 * Zero dependencies on purpose — this is the security boundary, and it should
 * be readable end to end in one sitting.
 *
 * Tool definitions arrive via CMB_TOOL_DEFINITIONS_FILE (a JSON file path).
 * A file, not an env var: a large tool set (~200 tools) serialises to ~100 kB,
 * which is an
 * uncomfortable share of ARG_MAX (1 MB on macOS, shared by argv AND env), and
 * a file also keeps the schemas out of `ps auxe`.
 */

import { readFileSync } from 'node:fs';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const PROTOCOL_VERSION = '2024-11-05';

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function main(): void {
  const file = process.env.CMB_TOOL_DEFINITIONS_FILE;
  if (!file) {
    process.stderr.write('claude-max-bridge dummy MCP: CMB_TOOL_DEFINITIONS_FILE not set\n');
    process.exit(1);
  }

  let tools: ToolDef[];
  try {
    tools = JSON.parse(readFileSync(file, 'utf-8')) as ToolDef[];
  } catch (e) {
    process.stderr.write(`claude-max-bridge dummy MCP: cannot read ${file}: ${String(e)}\n`);
    process.exit(1);
    return;
  }

  let buf = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) handle(line, tools);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

function handle(line: string, tools: ToolDef[]): void {
  let req: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method } = req;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'claude-max-bridge-dummy', version: '1.0.0' },
        },
      });
      return;

    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools } });
      return;

    case 'tools/call': {
      const params = (req.params ?? {}) as { name?: string; arguments?: unknown };
      // Placeholder only. The bridge has already seen the tool_use event and
      // is tearing this process down; this response exists so the model never
      // hangs waiting if the teardown loses the race.
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'delegated',
                message:
                  'Tool execution is owned by the client, not by this runtime. ' +
                  'The result will arrive in a follow-up request.',
                tool: params.name ?? null,
              }),
            },
          ],
          isError: false,
        },
      });
      return;
    }

    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} });
      return;

    default:
      if (isNotification) return; // notifications/initialized etc.
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `method not found: ${method}` },
      });
  }
}

main();
