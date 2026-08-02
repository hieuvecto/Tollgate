import { describe, expect, it } from 'vitest';
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
    const translated = providerRequest(anthropic, '/v1/chat/completions', {
      model: 'public',
      messages: [
        { role: 'system', content: 'safe' },
        { role: 'user', content: 'hello' },
      ],
    });
    expect(translated.url).toBe('http://mock/v1/messages');
    expect(translated.body).toMatchObject({
      system: 'safe',
      messages: [{ role: 'user', content: 'hello' }],
    });
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
});
