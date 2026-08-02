import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const count = (value: unknown): number => JSON.stringify(value).split(/\s+/).length;

export interface InvoiceItem {
  requestId: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export function buildMockProvider() {
  const invoice: InvoiceItem[] = [];
  const app = Fastify({ logger: false });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/invoice', async () => ({ data: invoice }));
  app.delete('/invoice', async () => {
    invoice.length = 0;
    return { ok: true };
  });

  app.post<{ Body: Record<string, unknown> }>('/v1/embeddings', async (request) => {
    const inputTokens = count(request.body.input);
    return {
      object: 'list',
      model: request.body.model,
      data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
      usage: { prompt_tokens: inputTokens, total_tokens: inputTokens },
    };
  });

  app.post<{ Body: Record<string, unknown> }>('/v1/chat/completions', async (request, reply) => {
    const fault = String(request.headers['x-tollgate-fault'] ?? 'none');
    const ttft = Number(request.headers['x-tollgate-ttft-ms'] ?? 0);
    const delay = Number(request.headers['x-tollgate-token-delay-ms'] ?? 0);
    const midstreamAfter = Number(request.headers['x-tollgate-fail-after-tokens'] ?? 2);
    const id = `chatcmpl_${randomUUID()}`;
    if (fault === 'rate_limit')
      return reply
        .header('retry-after', '1')
        .code(429)
        .send({ error: { message: 'injected rate limit' } });
    if (fault === 'pre_500')
      return reply.code(500).send({ error: { message: 'injected pre-token failure' } });
    if (fault === 'hang') return await new Promise(() => undefined);
    await sleep(ttft);
    const content = 'Tollgate mock response';
    const usage = {
      prompt_tokens: count(request.body.messages),
      completion_tokens: 3,
      total_tokens: count(request.body.messages) + 3,
      prompt_tokens_details: { cached_tokens: 1 },
    };
    const requestId = String(request.headers['x-tollgate-request-id'] ?? id);
    invoice.push({
      requestId,
      inputTokens: usage.prompt_tokens,
      outputTokens: fault === 'wrong_usage' ? 5 : 3,
      cachedInputTokens: 1,
    });
    if (!request.body.stream) {
      const response: Record<string, unknown> = {
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: request.body.model,
        choices: [
          {
            index: 0,
            message: request.body.tools
              ? {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_mock',
                      type: 'function',
                      function: { name: 'mock_tool', arguments: '{}' },
                    },
                  ],
                }
              : { role: 'assistant', content },
            finish_reason: request.body.tools ? 'tool_calls' : 'stop',
          },
        ],
      };
      if (fault !== 'missing_usage')
        response.usage =
          fault === 'wrong_usage'
            ? { ...usage, completion_tokens: 5, total_tokens: usage.prompt_tokens + 5 }
            : usage;
      return response;
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const tokens = ['Tollgate', ' mock', ' response'];
    for (const [index, token] of tokens.entries()) {
      if (fault === 'midstream_500' && index === midstreamAfter) {
        reply.raw.write(
          `data: ${JSON.stringify({ error: { message: 'injected mid-stream failure', code: 'provider_error' } })}\n\n`,
        );
        reply.raw.end();
        return;
      }
      reply.raw.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: request.body.model, choices: [{ index: 0, delta: { content: token }, finish_reason: null }] })}\n\n`,
      );
      await sleep(delay);
    }
    if (fault !== 'missing_usage')
      reply.raw.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: request.body.model, choices: [], usage })}\n\n`,
      );
    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
  });

  app.post<{ Body: Record<string, unknown> }>('/v1/messages', async (request, reply) => {
    const id = `msg_${randomUUID()}`;
    const usage = {
      input_tokens: count(request.body.messages),
      output_tokens: 3,
      cache_read_input_tokens: 1,
    };
    if (!request.body.stream)
      return {
        id,
        type: 'message',
        role: 'assistant',
        model: request.body.model,
        content: [{ type: 'text', text: 'Tollgate mock response' }],
        stop_reason: 'end_turn',
        usage,
      };
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
    reply.raw.write(
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id, usage: { input_tokens: usage.input_tokens } } })}\n\n`,
    );
    for (const text of ['Tollgate', ' mock', ' response'])
      reply.raw.write(
        `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`,
      );
    reply.raw.write(
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: usage.output_tokens } })}\n\n`,
    );
    reply.raw.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    reply.raw.end();
  });
  return app;
}
