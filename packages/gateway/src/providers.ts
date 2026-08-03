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

function normalizeStopReason(reason: unknown): string {
  if (reason === 'tool_use') return 'tool_calls';
  if (reason === 'max_tokens') return 'length';
  if (reason === 'refusal') return 'content_filter';
  return 'stop';
}

function anthropicTools(tools: unknown[] | undefined): unknown[] | undefined {
  if (!tools) return undefined;
  return tools.map((tool) => {
    if (!tool || typeof tool !== 'object') return tool;
    const value = tool as Record<string, unknown>;
    if ('input_schema' in value) return value;
    const fn = value.function as Record<string, unknown> | undefined;
    if (!fn) return value;
    return {
      name: fn.name,
      ...(fn.description === undefined ? {} : { description: fn.description }),
      input_schema: fn.parameters ?? { type: 'object', properties: {} },
    };
  });
}

function anthropicMessages(messages: ChatCompletionRequest['messages']): unknown[] {
  return messages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      const value = message as typeof message & { tool_call_id?: string };
      if (message.role === 'tool') {
        return {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: value.tool_call_id,
              content: message.content ?? '',
            },
          ],
        };
      }
      if (message.role === 'assistant' && message.tool_calls?.length) {
        const content: unknown[] = [];
        if (typeof message.content === 'string' && message.content) {
          content.push({ type: 'text', text: message.content });
        }
        for (const call of message.tool_calls) {
          if (!call || typeof call !== 'object') continue;
          const toolCall = call as Record<string, unknown>;
          const fn = toolCall.function as Record<string, unknown> | undefined;
          let input: unknown = {};
          if (typeof fn?.arguments === 'string') {
            try {
              input = JSON.parse(fn.arguments) as unknown;
            } catch {
              input = { value: fn.arguments };
            }
          }
          content.push({
            type: 'tool_use',
            id: toolCall.id,
            name: fn?.name,
            input,
          });
        }
        return { role: 'assistant', content };
      }
      return { role: message.role, content: message.content ?? '' };
    });
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
        for (const event of events) {
          controller.enqueue(encoder.encode(`${transformEvent(event)}\n\n`));
        }
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
      messages: anthropicMessages(chat.messages),
      ...(chat.tools ? { tools: anthropicTools(chat.tools) } : {}),
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
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      return normalizeCompatibleStream(response, publicModel);
    }
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
            finish_reason: normalizeStopReason(raw.stop_reason),
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
  let cachedInputTokens = 0;
  let emittedFinish = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (choices: unknown[], usage?: Record<string, unknown>) => {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              id: messageId,
              object: 'chat.completion.chunk',
              model: publicModel,
              choices,
              ...(usage ? { usage } : {}),
            })}\n\n`,
          ),
        );
      };
      const processEvent = (event: string) => {
        const line = event.split('\n').find((item) => item.startsWith('data: '));
        if (!line) return;
        const value = JSON.parse(line.slice(6)) as Record<string, unknown>;
        const type = typeof value.type === 'string' ? value.type : '';
        if (type === 'message_start') {
          const message = value.message as Record<string, unknown>;
          const usage = message.usage as Record<string, unknown> | undefined;
          messageId = typeof message.id === 'string' ? message.id : messageId;
          inputTokens = Number(usage?.input_tokens ?? 0);
          cachedInputTokens = Number(usage?.cache_read_input_tokens ?? 0);
          enqueue([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]);
          return;
        }
        if (type === 'content_block_start') {
          const block = value.content_block as Record<string, unknown> | undefined;
          if (block?.type === 'tool_use') {
            const initialInput = block.input as Record<string, unknown> | undefined;
            enqueue([
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: Number(value.index ?? 0),
                      id: block.id,
                      type: 'function',
                      function: {
                        name: block.name,
                        arguments:
                          initialInput && Object.keys(initialInput).length
                            ? JSON.stringify(initialInput)
                            : '',
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ]);
          } else if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
            enqueue([{ index: 0, delta: { content: block.text }, finish_reason: null }]);
          }
          return;
        }
        if (type === 'content_block_delta') {
          const delta = value.delta as Record<string, unknown>;
          if (delta.type === 'input_json_delta') {
            enqueue([
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: Number(value.index ?? 0),
                      function: {
                        arguments: typeof delta.partial_json === 'string' ? delta.partial_json : '',
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ]);
          } else if (delta.type === 'text_delta' || typeof delta.text === 'string') {
            enqueue([
              {
                index: 0,
                delta: { content: typeof delta.text === 'string' ? delta.text : '' },
                finish_reason: null,
              },
            ]);
          }
          return;
        }
        if (type === 'message_delta') {
          const usage = value.usage as Record<string, unknown> | undefined;
          const delta = value.delta as Record<string, unknown> | undefined;
          const outputTokens = Number(usage?.output_tokens ?? 0);
          enqueue(
            [
              {
                index: 0,
                delta: {},
                finish_reason: normalizeStopReason(delta?.stop_reason),
              },
            ],
            {
              prompt_tokens: inputTokens,
              completion_tokens: outputTokens,
              total_tokens: inputTokens + outputTokens,
              prompt_tokens_details: { cached_tokens: cachedInputTokens },
            },
          );
          emittedFinish = true;
          return;
        }
        if (type === 'message_stop') {
          if (!emittedFinish) {
            enqueue([{ index: 0, delta: {}, finish_reason: 'stop' }], {
              prompt_tokens: inputTokens,
              completion_tokens: 0,
              total_tokens: inputTokens,
              prompt_tokens_details: { cached_tokens: cachedInputTokens },
            });
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        }
      };
      const reader = response.body!.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const event of events) processEvent(event);
      }
      buffer += decoder.decode();
      if (buffer.trim()) processEvent(buffer);
      controller.close();
    },
  });
  return new Response(stream, {
    status: response.status,
    headers: responseHeaders(response),
  });
}
