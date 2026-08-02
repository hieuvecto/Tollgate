import type { ChatCompletionRequest } from '@tollgate/shared';

export interface ProviderBinding {
  bindingId?: string;
  providerId: string;
  kind: string;
  baseUrl: string;
  providerModel: string;
  priority: number;
  weight?: number;
  ewmaTtftMs?: number | null;
  breakerState?: string;
  inputCostPerMtok?: bigint;
  outputCostPerMtok?: bigint;
  credential?: string;
  credentialRequired?: boolean;
}

function responseHeaders(response: Response): Headers {
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return headers;
}

function normalizeCompatibleStream(response: Response, publicModel: string): Response {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  const transformEvent = (event: string) =>
    event
      .split('\n')
      .map((line) => {
        if (!line.startsWith('data: ') || line.slice(6) === '[DONE]') return line;
        try {
          const payload = JSON.parse(line.slice(6)) as Record<string, unknown>;
          if ('model' in payload) payload.model = publicModel;
          return `data: ${JSON.stringify(payload)}`;
        } catch {
          return line;
        }
      })
      .join('\n');
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = response.body!.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const event of events)
          controller.enqueue(encoder.encode(`${transformEvent(event)}\n\n`));
      }
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(transformEvent(buffer)));
      controller.close();
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response),
  });
}

export function providerRequest(
  binding: ProviderBinding,
  path: string,
  body: Record<string, unknown>,
) {
  const credentialHeaders = binding.credential
    ? binding.kind === 'anthropic'
      ? { 'x-api-key': binding.credential }
      : { authorization: `Bearer ${binding.credential}` }
    : {};
  if (binding.kind !== 'anthropic' || path !== '/v1/chat/completions') {
    return {
      url: `${binding.baseUrl}${path}`,
      body: { ...body, model: binding.providerModel },
      headers: credentialHeaders,
    };
  }
  const chat = body as unknown as ChatCompletionRequest;
  const system = chat.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n');
  return {
    url: `${binding.baseUrl}/v1/messages`,
    headers: { 'anthropic-version': '2023-06-01', ...credentialHeaders },
    body: {
      model: binding.providerModel,
      max_tokens: chat.max_tokens ?? 512,
      stream: chat.stream ?? false,
      ...(system ? { system } : {}),
      messages: chat.messages.filter((message) => message.role !== 'system'),
      ...(chat.tools ? { tools: chat.tools } : {}),
    },
  };
}

export async function normalizeProviderResponse(
  binding: ProviderBinding,
  response: Response,
  publicModel: string,
): Promise<Response> {
  if (!response.ok) return response;
  if (!response.body) return response;
  if (binding.kind !== 'anthropic') {
    if (response.headers.get('content-type')?.includes('text/event-stream'))
      return normalizeCompatibleStream(response, publicModel);
    const raw = (await response.json()) as Record<string, unknown>;
    return new Response(JSON.stringify({ ...raw, model: publicModel }), {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders(response),
    });
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const raw = (await response.json()) as Record<string, unknown>;
    const content = raw.content as Array<Record<string, unknown>> | undefined;
    const text =
      content
        ?.filter((item) => item.type === 'text')
        .map((item) => (typeof item.text === 'string' ? item.text : ''))
        .join('') ?? '';
    const tools = content
      ?.filter((item) => item.type === 'tool_use')
      .map((item) => ({
        id: item.id,
        type: 'function',
        function: { name: item.name, arguments: JSON.stringify(item.input ?? {}) },
      }));
    const usage = raw.usage as Record<string, unknown> | undefined;
    return Response.json(
      {
        id: raw.id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: publicModel,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: text || null,
              ...(tools?.length ? { tool_calls: tools } : {}),
            },
            finish_reason: raw.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
          },
        ],
        usage: {
          prompt_tokens: Number(usage?.input_tokens ?? 0),
          completion_tokens: Number(usage?.output_tokens ?? 0),
          total_tokens: Number(usage?.input_tokens ?? 0) + Number(usage?.output_tokens ?? 0),
          prompt_tokens_details: { cached_tokens: Number(usage?.cache_read_input_tokens ?? 0) },
        },
      },
      { status: response.status },
    );
  }
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let messageId = 'anthropic';
  let inputTokens = 0;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = response.body!.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const event of events) {
          const line = event.split('\n').find((item) => item.startsWith('data: '));
          if (!line) continue;
          const value = JSON.parse(line.slice(6)) as Record<string, unknown>;
          const type = typeof value.type === 'string' ? value.type : '';
          if (type === 'message_start') {
            const message = value.message as Record<string, unknown>;
            messageId = typeof message.id === 'string' ? message.id : messageId;
            inputTokens = Number(
              (message.usage as Record<string, unknown> | undefined)?.input_tokens ?? 0,
            );
          } else if (type === 'content_block_delta') {
            const delta = value.delta as Record<string, unknown>;
            const payload = {
              id: messageId,
              object: 'chat.completion.chunk',
              model: publicModel,
              choices: [{ index: 0, delta: { content: delta.text ?? '' }, finish_reason: null }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
          } else if (type === 'message_delta') {
            const usage = value.usage as Record<string, unknown> | undefined;
            const outputTokens = Number(usage?.output_tokens ?? 0);
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ id: messageId, object: 'chat.completion.chunk', model: publicModel, choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } })}\n\n`,
              ),
            );
          } else if (type === 'message_stop')
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        }
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: response.status,
    headers: { 'content-type': 'text/event-stream' },
  });
}
