// Verifier-owned OpenAI-compatible provider used in two modes:
//  - scripted: deterministic replies that exercise server-side enforcement and
//    failure handling. This establishes adapter/enforcement behaviour only,
//    never live inference (TEST_PROMPT verification contract).
//  - passthrough: forwards to the real Crusoe endpoint with the verifier's own
//    key, so live missions are observed independently of production telemetry
//    (ACCEPTANCE_CONTRACT section 6: OPENAI_BASE_URL may point at a verifier
//    pass-through proxy). The key never reaches the app or any log.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ToolCallSpec {
  name: string;
  args: unknown;
  /** Send the arguments as this raw string instead of JSON.stringify(args). */
  rawArguments?: string;
}
export interface UsageSpec {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
}
export type ProviderReply =
  | { type: 'content'; text: string; usage?: UsageSpec; delayMs?: number }
  | { type: 'tool_calls'; calls: ToolCallSpec[]; usage?: UsageSpec; delayMs?: number }
  | { type: 'refusal'; text: string }
  | { type: 'http'; status: number; body?: unknown; retryAfter?: number }
  | { type: 'hang'; ms?: number }
  | { type: 'reset' }
  | { type: 'passthrough' };

export interface ProviderCall {
  /** 1-based sequence over every chat completion received. */
  n: number;
  /** `worker` when tools are offered, otherwise `structured` (planner and others). */
  kind: 'worker' | 'structured';
  body: Record<string, any>;
  /** Concatenated text of every message (for markers); never persisted. */
  text: string;
  /** Number of `tool` role messages in the conversation. */
  toolResults: number;
  /** Parsed `tool` message contents (JSON when parseable). */
  toolMessages: unknown[];
  toolNames: string[];
  stream: boolean;
}
export interface RecordedCall {
  n: number;
  at: number;
  kind: ProviderCall['kind'];
  body: Record<string, any>;
  text: string;
  reply: ProviderReply['type'];
  status: number;
}
export type ProviderScript = (call: ProviderCall) => ProviderReply | Promise<ProviderReply>;

export interface ProviderOptions {
  port: number;
  model: string;
  script?: ProviderScript;
  /** passthrough target, e.g. https://api.inference.crusoecloud.com/v1 */
  upstream?: { baseUrl: string; apiKey: string };
}

function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
  return '';
}
function parseMaybe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface Provider {
  readonly url: string;
  readonly host: string;
  readonly calls: RecordedCall[];
  setScript(script: ProviderScript): void;
  /** Hold the next matching reply until released (deterministic mid-attempt interleaving). */
  gate(match: (call: ProviderCall) => boolean): { arrived: Promise<ProviderCall>; release(): void };
  close(): Promise<void>;
}

export async function startProvider(options: ProviderOptions): Promise<Provider> {
  const calls: RecordedCall[] = [];
  let script: ProviderScript =
    options.script ?? (() => (options.upstream ? { type: 'passthrough' } : { type: 'http', status: 503 }));
  const gates: {
    match: (call: ProviderCall) => boolean;
    arrived: (call: ProviderCall) => void;
    released: Promise<void>;
    used: boolean;
  }[] = [];
  const sockets = new Set<import('node:net').Socket>();
  let sequence = 0;

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const path = (req.url ?? '').split('?')[0];
    try {
      if (req.method === 'GET' && path.endsWith('/models')) {
        if (options.upstream && !options.script) return await forward(req, res, raw, path);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: options.model, object: 'model', owned_by: 'verifier' }] }));
        return;
      }
      if (req.method === 'POST' && path.endsWith('/chat/completions')) {
        const body = JSON.parse(raw) as Record<string, any>;
        sequence += 1;
        const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
        const toolMessages = messages
          .filter((message) => message?.role === 'tool')
          .map((message) => parseMaybe(messageText(message)));
        const call: ProviderCall = {
          n: sequence,
          kind: Array.isArray(body.tools) && body.tools.length ? 'worker' : 'structured',
          body,
          text: messages.map(messageText).join('\n'),
          toolResults: toolMessages.length,
          toolMessages,
          toolNames: (body.tools ?? []).map((tool: any) => tool?.function?.name ?? tool?.name).filter(Boolean),
          stream: body.stream === true,
        };
        const gate = gates.find((entry) => !entry.used && entry.match(call));
        if (gate) {
          gate.used = true;
          gate.arrived(call);
          await gate.released;
        }
        const reply = await script(call);
        const record: RecordedCall = {
          n: call.n,
          at: Date.now(),
          kind: call.kind,
          body,
          text: call.text,
          reply: reply.type,
          status: 200,
        };
        calls.push(record);
        await respond(call, reply, req, res, raw, record);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `provider stub failure: ${(error as Error).message}` }));
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  async function forward(req: http.IncomingMessage, res: http.ServerResponse, raw: string, path: string, record?: RecordedCall) {
    if (!options.upstream) throw new Error('no upstream configured');
    const base = options.upstream.baseUrl.replace(/\/$/, '');
    const suffix = path.replace(/^\/v1/, '');
    const upstream = await fetch(`${base}${suffix}`, {
      method: req.method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.upstream.apiKey}`,
      },
      body: req.method === 'GET' ? undefined : raw,
    });
    if (record) record.status = upstream.status;
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    });
    if (!upstream.body) return void res.end();
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  }

  async function respond(call: ProviderCall, reply: ProviderReply, req: http.IncomingMessage, res: http.ServerResponse, raw: string, record: RecordedCall) {
    switch (reply.type) {
      case 'passthrough':
        return forward(req, res, raw, (req.url ?? '').split('?')[0], record);
      case 'reset':
        record.status = 0;
        return void req.socket.destroy();
      case 'hang': {
        record.status = 0;
        await new Promise((resolve) => setTimeout(resolve, reply.ms ?? 600_000));
        return void req.socket.destroy();
      }
      case 'http': {
        record.status = reply.status;
        res.writeHead(reply.status, {
          'content-type': 'application/json',
          ...(reply.retryAfter ? { 'retry-after': String(reply.retryAfter) } : {}),
        });
        return void res.end(JSON.stringify(reply.body ?? { error: { message: `scripted ${reply.status}`, type: 'scripted' } }));
      }
      case 'refusal':
        return send(call, res, { content: null, refusal: reply.text }, 'content_filter', undefined);
      case 'content':
        if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
        return send(call, res, { content: reply.text }, 'stop', reply.usage);
      case 'tool_calls':
        if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
        return send(
          call,
          res,
          {
            content: null,
            tool_calls: reply.calls.map((spec, i) => ({
              index: i,
              id: `call_${call.n}_${i}`,
              type: 'function',
              function: { name: spec.name, arguments: spec.rawArguments ?? JSON.stringify(spec.args) },
            })),
          },
          'tool_calls',
          reply.usage,
        );
    }
  }

  function send(call: ProviderCall, res: http.ServerResponse, message: Record<string, unknown>, finish: string, usage: UsageSpec | undefined) {
    const usageBody = usage ? { ...usage, total_tokens: usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens } : { prompt_tokens: 400, completion_tokens: 60, total_tokens: 460 };
    const base = { id: `chatcmpl-stub-${call.n}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: options.model };
    if (!call.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ ...base, choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }], usage: usageBody }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const delta = (d: unknown, finishReason: string | null) =>
      `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: d, finish_reason: finishReason }] })}\n\n`;
    res.write(delta({ role: 'assistant' }, null));
    res.write(delta(message, null));
    res.write(delta({}, finish));
    res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [], usage: usageBody })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    host: `127.0.0.1:${address.port}`,
    calls,
    setScript(next) {
      script = next;
    },
    gate(match) {
      let arrive!: (call: ProviderCall) => void;
      let release!: () => void;
      const arrived = new Promise<ProviderCall>((resolve) => (arrive = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      gates.push({ match, arrived: arrive, released, used: false });
      return { arrived, release };
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
