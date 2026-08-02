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
    });
    expect(translated.url).toBe('http://mock/v1/messages');
    expect(translated.headers).toMatchObject({ 'x-api-key': credential });
    expect(translated.body).toMatchObject({
      system: 'safe',
      messages: [{ role: 'user', content: 'hello' }],
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
});
