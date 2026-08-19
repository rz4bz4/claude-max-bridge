import type { BridgeConfig } from './config.js';
import type { CapturedToolCall, RunResult } from './run.js';

export interface OpenAiMessage {
  role: string;
  content?: unknown;
  name?: string;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model?: string;
  messages?: OpenAiMessage[];
  tools?: unknown[];
  stream?: boolean;
  reasoning_effort?: string;
  [k: string]: unknown;
}

/** Flatten possibly-multipart OpenAI content into plain text. */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text' && typeof part.text === 'string') return part.text;
        if (part?.type === 'input_text' && typeof part.text === 'string') return part.text;
        if (part?.type === 'image_url') return '[image omitted — bridge does not pass images]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content == null) return '';
  return String(content);
}

export interface FlattenedRequest {
  systemPrompt: string;
  prompt: string;
}

/**
 * Split the OpenAI conversation into (system prompt, transcript).
 *
 * The bridge is stateless: the entire conversation goes into the prompt on
 * every request, because the client — not Claude — owns history. That keeps
 * the two sides from ever disagreeing about what was said.
 */
export function flattenMessages(messages: OpenAiMessage[]): FlattenedRequest {
  const systemParts: string[] = [];
  const turns: string[] = [];

  for (const m of messages) {
    const role = (m.role || '').toLowerCase();
    const text = contentToText(m.content);

    if (role === 'system' || role === 'developer') {
      if (text.trim()) systemParts.push(text);
      continue;
    }

    if (role === 'tool') {
      const label = m.name || m.tool_call_id || 'tool';
      turns.push(`<tool_result tool="${label}">\n${text}\n</tool_result>`);
      continue;
    }

    if (role === 'assistant') {
      const bits: string[] = [];
      if (text.trim()) bits.push(text);
      for (const tc of m.tool_calls ?? []) {
        const fname = tc.function?.name ?? 'unknown';
        const fargs = tc.function?.arguments ?? '{}';
        bits.push(`<tool_call name="${fname}">${fargs}</tool_call>`);
      }
      if (bits.length) turns.push(`Assistant: ${bits.join('\n')}`);
      continue;
    }

    // user and anything else
    if (text.trim()) turns.push(`User: ${text}`);
  }

  return {
    systemPrompt: systemParts.join('\n\n'),
    prompt: turns.join('\n\n'),
  };
}

function toolCallsPayload(calls: CapturedToolCall[]) {
  return calls.map((c, i) => ({
    index: i,
    id: c.id,
    type: 'function' as const,
    function: { name: c.name, arguments: c.argumentsJson },
  }));
}

export function buildCompletion(cfg: BridgeConfig, model: string, r: RunResult) {
  const isTools = r.kind === 'tool_calls' && r.toolCalls.length > 0;
  return {
    id: `chatcmpl-${r.sessionId ?? Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: isTools ? (r.text || null) : r.text,
          ...(isTools ? { tool_calls: toolCallsPayload(r.toolCalls) } : {}),
        },
        finish_reason: isTools ? 'tool_calls' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: r.usage.promptTokens,
      completion_tokens: r.usage.completionTokens,
      total_tokens: r.usage.promptTokens + r.usage.completionTokens,
    },
    // Bridge-specific diagnostics. Harmless to clients that ignore unknown keys,
    // and the fastest way to confirm subscription billing from the outside.
    _bridge: {
      apiKeySource: r.apiKeySource,
      exposedBuiltinTools: r.exposedBuiltinTools,
      resolvedModel: r.resolvedModel,
      rateLimit: r.rateLimit,
    },
  };
}

export function sseChunk(model: string, id: string, delta: Record<string, unknown>, finish: string | null) {
  return (
    'data: ' +
    JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    }) +
    '\n\n'
  );
}

export function sseToolCallsChunk(model: string, id: string, calls: CapturedToolCall[]) {
  return sseChunk(model, id, { tool_calls: toolCallsPayload(calls) }, null);
}
