import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  normalizeProviderResponse,
  providerRequest,
} from '../../packages/gateway/src/providers.js';

const anthropic = {
  providerId: 'p',
  kind: 'anthropic',
  baseUrl: 'http://mock',
  providerModel: 'claude-mock',
  priority: 1,
};

describe('Anthropic adapter', () => {
  it('moves system messages into the Anthropic system field', () => {
    const credential = randomBytes(24).toString('base64url');
    const translated = providerRequest({ ...anthropic, credential }, '/v1/chat/completions', {
      model: 'public',
      messages: [
        { role: 'system', content: 'safe' },
        { role: 'user', content: 'hello' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup',
            description: 'Look up a city',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ],
    });
    expect(translated.url).toBe('http://mock/v1/messages');
    expect(translated.headers).toMatchObject({ 'x-api-key': credential });
    expect(translated.body).toMatchObject({
      system: 'safe',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [
        {
          name: 'lookup',
          description: 'Look up a city',
          input_schema: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
    });
  });
  it('maps OpenAI tool calls and results into Anthropic message blocks', () => {
    const translated = providerRequest(anthropic, '/v1/chat/completions', {
      model: 'public',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'tool_1',
              type: 'function',
              function: { name: 'lookup', arguments: '{"city":"Paris"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'tool_1', content: 'sunny' },
      ],
    });

    expect(translated.body).toMatchObject({
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool_1',
              name: 'lookup',
              input: { city: 'Paris' },
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'sunny' }],
        },
      ],
    });
  });
  it('uses bearer authentication for OpenAI-compatible providers', () => {
    const credential = randomBytes(24).toString('base64url');
    const translated = providerRequest(
      { ...anthropic, kind: 'openai_compatible', credential },
      '/v1/chat/completions',
      { model: 'public', messages: [] },
    );

    expect(translated.headers).toEqual({ authorization: `Bearer ${credential}` });
  });
  it('normalizes usage and content into an OpenAI completion', async () => {
    const raw = Response.json({
      id: 'msg_1',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 2, output_tokens: 1 },
    });
    const normalized = await normalizeProviderResponse(anthropic, raw, 'public');
    const body = (await normalized.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { total_tokens: number };
    };
    expect(body.choices[0]?.message.content).toBe('hello');
    expect(body.usage.total_tokens).toBe(3);
  });
  it('normalizes streamed role, tool calls, finish reason, and cached usage', async () => {
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'msg_stream',
          usage: { input_tokens: 5, cache_read_input_tokens: 2 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tool_1', name: 'lookup', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"city":"Paris"}' },
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 3 },
      },
      { type: 'message_stop' },
    ];
    const raw = new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    );

    const normalized = await normalizeProviderResponse(anthropic, raw, 'public');
    const stream = await normalized.text();
    expect(stream).toContain('"role":"assistant"');
    expect(stream).toContain('"id":"tool_1"');
    expect(stream).toContain('"name":"lookup"');
    expect(stream).toContain('"arguments":"{\\"city\\":\\"Paris\\"}"');
    expect(stream).toContain('"finish_reason":"tool_calls"');
    expect(stream).toContain('"cached_tokens":2');
    expect(stream).toContain('data: [DONE]');
  });
});
