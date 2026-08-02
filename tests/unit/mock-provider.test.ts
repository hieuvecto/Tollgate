import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMockProvider } from '../../services/mock-provider/src/app.js';

describe('fault-injectable mock provider', () => {
  const app = buildMockProvider();
  beforeEach(async () => {
    await app.ready();
  });
  afterEach(async () => {
    await app.inject({ method: 'DELETE', url: '/invoice' });
  });

  it('returns OpenAI-compatible content and usage', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'mock', messages: [{ role: 'user', content: 'hello' }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: 'chat.completion',
      usage: { completion_tokens: 3 },
    });
  });

  it.each([
    ['pre_500', 500],
    ['rate_limit', 429],
  ])('injects %s', async (fault, status) => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-tollgate-fault': fault },
      payload: { model: 'mock', messages: [] },
    });
    expect(response.statusCode).toBe(status);
  });

  it('can omit or intentionally distort provider usage', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-tollgate-fault': 'missing_usage' },
      payload: { model: 'mock', messages: [] },
    });
    const wrong = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-tollgate-fault': 'wrong_usage' },
      payload: { model: 'mock', messages: [] },
    });
    expect(missing.json()).not.toHaveProperty('usage');
    expect(wrong.json()).toMatchObject({ usage: { completion_tokens: 5 } });
  });
});
