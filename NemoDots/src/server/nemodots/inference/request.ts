import { z } from 'zod';
import type { ChatMessage, ChatRequest } from '../contracts/index.js';
import { InferenceError } from './types.js';

// Request shaping for OpenAI-compatible chat completions on Crusoe.
// Facts encoded here (CRUSOE_SMOKE_PRE.md, LEAD_NOTES.md):
//  - reasoning is ON by default on Nemotron, so reasoning_effort is always
//    sent and defaults to "none"; opting in requires max_tokens >= 1024 or the
//    whole budget can be spent on reasoning (content null, finish "length");
//  - tool_choice is only ever "auto" ("required" 500s on Lightning, loops on
//    Super), and is only sent together with tools;
//  - the system prompt is one string at the head of the conversation;
//  - tool continuation needs the assistant message carrying tool_calls before
//    each role:"tool" message.

export const MIN_REASONING_MAX_TOKENS = 1024;

export interface ChatBody {
  model: string;
  messages: unknown[];
  stream: boolean;
  stream_options?: { include_usage: true };
  tools?: unknown[];
  tool_choice?: 'auto';
  reasoning_effort: 'none' | 'low' | 'medium' | 'high';
  max_tokens?: number;
  response_format?: {
    type: 'json_schema';
    json_schema: {
      name: string;
      strict: true;
      schema: Record<string, unknown>;
    };
  };
}

function invalid(message: string): never {
  throw new InferenceError(message, 'invalid_request');
}

function shapeMessages(messages: ChatMessage[]): unknown[] {
  if (messages.length === 0) invalid('messages must not be empty');
  const [first, ...rest] = messages;
  if (first.role !== 'system')
    invalid('the first message must be the single system message');
  if (rest.some((m) => m.role === 'system'))
    invalid(
      'exactly one system message is allowed (CONTRACTS: single system string)',
    );
  const emitted = new Set<string>();
  const shaped: unknown[] = [{ role: 'system', content: first.content }];
  for (const message of rest) {
    switch (message.role) {
      case 'user':
        shaped.push({ role: 'user', content: message.content });
        break;
      case 'assistant': {
        for (const call of message.toolCalls) {
          if (emitted.has(call.toolCallId))
            invalid(`duplicate tool call id ${call.toolCallId}`);
          emitted.add(call.toolCallId);
        }
        shaped.push(
          message.toolCalls.length === 0
            ? { role: 'assistant', content: message.content ?? '' }
            : {
                role: 'assistant',
                content: message.content,
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.toolCallId,
                  type: 'function',
                  function: { name: call.name, arguments: call.arguments },
                })),
              },
        );
        break;
      }
      case 'tool':
        if (!emitted.has(message.toolCallId))
          invalid(
            `tool message answers ${message.toolCallId}, which no earlier assistant message emitted`,
          );
        shaped.push({
          role: 'tool',
          tool_call_id: message.toolCallId,
          content: message.content,
        });
        break;
    }
  }
  return shaped;
}

/** The exact JSON body sent to POST {base}/chat/completions. */
export function buildChatBody(req: ChatRequest): ChatBody {
  if (!req.model) invalid('model is required');
  const effort = req.reasoningEffort ?? 'none';
  if (
    effort !== 'none' &&
    req.maxTokens !== null &&
    req.maxTokens < MIN_REASONING_MAX_TOKENS
  )
    invalid(
      `reasoning_effort "${effort}" needs max_tokens >= ${MIN_REASONING_MAX_TOKENS} (or none)`,
    );
  if (
    req.maxTokens !== null &&
    (!Number.isInteger(req.maxTokens) || req.maxTokens < 1)
  )
    invalid('max_tokens must be a positive integer');
  const body: ChatBody = {
    model: req.model,
    messages: shapeMessages(req.messages),
    stream: req.stream,
    reasoning_effort: effort,
  };
  if (req.stream) body.stream_options = { include_usage: true };
  if (req.tools.length > 0) {
    body.tools = req.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
    body.tool_choice = 'auto';
  }
  if (req.maxTokens !== null) body.max_tokens = req.maxTokens;
  if (req.responseFormat)
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: req.responseFormat.name,
        strict: true,
        schema: req.responseFormat.schema,
      },
    };
  // Re-order to the documented key order regardless of insertion above.
  const order: (keyof ChatBody)[] = [
    'model',
    'messages',
    'stream',
    'stream_options',
    'tools',
    'tool_choice',
    'reasoning_effort',
    'max_tokens',
    'response_format',
  ];
  const ordered: Record<string, unknown> = {};
  for (const key of order) if (key in body) ordered[key] = body[key];
  return ordered as unknown as ChatBody;
}

export type StrictSchemaResult =
  { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * Validates model output against the strict response_format schema. The model
 * is asked for strict structured output, but the server never trusts it.
 */
export function validateStrictOutput(
  schema: Record<string, unknown>,
  content: string | null,
): StrictSchemaResult {
  if (content === null || content.trim() === '')
    return { ok: false, reason: 'empty content' };
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return { ok: false, reason: 'content is not JSON' };
  }
  let validator: z.ZodType;
  try {
    validator = z.fromJSONSchema(schema as never) as z.ZodType;
  } catch {
    return { ok: false, reason: 'response schema is not supported' };
  }
  const parsed = validator.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: 'content does not match the schema' };
}
