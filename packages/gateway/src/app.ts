import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { query, transaction } from '@tollgate/db';
import {
  createLogger,
  loadConfig,
  openAIError,
  priceTokens,
  TollgateError,
  type ChatCompletionRequest,
  type UsageFact,
} from '@tollgate/shared';
import { authenticate, redis, type Principal } from './auth.js';
import { estimateTokens, loadCatalog, type Catalog } from './catalog.js';
import { correctTokens, rateLimit } from './limits.js';
import {
  admitReservationBudget,
  finalizeRequest,
  rejectPendingReservation,
  spoolUsage,
} from './metering.js';
import { inFlight, latency, registry, requests, tokens, ttft } from './metrics.js';
import { normalizeProviderResponse, providerRequest } from './providers.js';
import { recordProviderResult, routeBindings } from './routing.js';
import { parseChatCompletion, parseEmbedding } from './validation.js';

const config = loadConfig();
const forwardedFaultHeaders = [
  'x-tollgate-fault',
  'x-tollgate-ttft-ms',
  'x-tollgate-token-delay-ms',
  'x-tollgate-fail-after-tokens',
];

interface StartedRequest {
  requestId: string;
  reservationId: string;
  storesIdempotencyResponse: boolean;
}

async function beginRequest(
  principal: Principal,
  catalog: Catalog,
  stream: boolean,
  idempotencyKey: string | undefined,
  reservedMicros: bigint,
): Promise<StartedRequest | { replay: unknown }> {
  const requestId = randomUUID();
  const reservationId = randomUUID();
  try {
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO requests(id,org_id,team_id,api_key_id,model_id,pricing_id,idempotency_key,idempotency_expires_at,stream) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          requestId,
          principal.orgId,
          principal.teamId,
          principal.apiKeyId,
          catalog.modelId,
          catalog.pricingId,
          idempotencyKey ?? null,
          idempotencyKey
            ? new Date(Date.now() + config.IDEMPOTENCY_RETENTION_HOURS * 3_600_000)
            : null,
          stream,
        ],
      );
      await client.query(
        `INSERT INTO reservations(id,org_id,team_id,request_id,amount_micros) VALUES($1,$2,$3,$4,$5)`,
        [reservationId, principal.orgId, principal.teamId, requestId, reservedMicros.toString()],
      );
      await client.query('UPDATE requests SET reservation_id=$2 WHERE id=$1', [
        requestId,
        reservationId,
      ]);
    });
  } catch (error: unknown) {
    if ((error as { code?: string }).code === '23505' && idempotencyKey)
      throw new TollgateError(
        409,
        'idempotency_in_progress',
        'A request with this Idempotency-Key already exists',
      );
    throw error;
  }
  return { requestId, reservationId, storesIdempotencyResponse: idempotencyKey !== undefined };
}

async function replayFor(orgId: string, idempotencyKey: string | undefined) {
  if (!idempotencyKey) return undefined;
  await query(
    `UPDATE requests SET idempotency_key=NULL,idempotency_response=NULL,idempotency_expires_at=NULL WHERE org_id=$1 AND idempotency_key=$2 AND status<>'in_progress' AND idempotency_expires_at<=now()`,
    [orgId, idempotencyKey],
  );
  const existing = await query<Record<string, unknown>>(
    'SELECT status,idempotency_response FROM requests WHERE org_id=$1 AND idempotency_key=$2',
    [orgId, idempotencyKey],
  );
  if (!existing.rowCount) return undefined;
  const row = existing.rows[0]!;
  if (row.status === 'succeeded' && row.idempotency_response) return row.idempotency_response;
  throw new TollgateError(
    409,
    'idempotency_in_progress',
    'A request with this Idempotency-Key already exists',
  );
}

function usageFromResponse(
  body: Record<string, unknown>,
  fallbackInput: number,
  fallbackOutput: number,
) {
  const usage = body.usage as Record<string, unknown> | undefined;
  const details = usage?.prompt_tokens_details as Record<string, unknown> | undefined;
  return {
    inputTokens: Number(usage?.prompt_tokens ?? fallbackInput),
    outputTokens: Number(usage?.completion_tokens ?? fallbackOutput),
    cachedInputTokens: Number(details?.cached_tokens ?? 0),
    source: usage ? ('provider' as const) : ('estimated' as const),
    providerRaw: usage ?? null,
  };
}

async function providerFetch(
  catalog: Catalog,
  path: string,
  request: FastifyRequest,
  body: Record<string, unknown>,
  requestId: string,
  signal: AbortSignal,
) {
  let last: Response | undefined;
  for (const [attempt, binding] of routeBindings(catalog).entries()) {
    const began = performance.now();
    await query('UPDATE requests SET attempt_count=attempt_count+1 WHERE id=$1', [requestId]);
    const translated = providerRequest(binding, path, body);
    const headers = new Headers({
      'content-type': 'application/json',
      'x-tollgate-request-id': requestId,
      ...translated.headers,
    });
    for (const name of forwardedFaultHeaders)
      if (attempt === 0 && request.headers[name]) headers.set(name, String(request.headers[name]));
    let rawResponse: Response;
    try {
      rawResponse = await fetch(translated.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(translated.body),
        signal,
      });
    } catch {
      await recordProviderResult(binding.bindingId, false);
      if (signal.aborted)
        throw new TollgateError(
          504,
          'provider_timeout',
          'Provider timed out before the first byte',
        );
      continue;
    }
    const response = await normalizeProviderResponse(binding, rawResponse, catalog.publicName);
    last = response;
    if (response.status === 429 || response.status >= 500) {
      await recordProviderResult(binding.bindingId, false);
      continue;
    }
    await recordProviderResult(binding.bindingId, true, Math.round(performance.now() - began));
    return { response, binding };
  }
  throw new TollgateError(
    last?.status ?? 503,
    'provider_unavailable',
    'All provider bindings failed before the first byte',
  );
}

async function handleNonStream(
  request: FastifyRequest,
  reply: FastifyReply,
  principal: Principal,
  catalog: Catalog,
  body: ChatCompletionRequest,
  started: StartedRequest,
  inputEstimate: number,
  rateBucket: number,
  tokenEstimate: number,
) {
  const began = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.TTFT_TIMEOUT_MS);
  try {
    const { response, binding } = await providerFetch(
      catalog,
      '/v1/chat/completions',
      request,
      { ...body, stream: false },
      started.requestId,
      controller.signal,
    );
    clearTimeout(timer);
    if (!response.ok)
      throw new TollgateError(response.status, 'provider_error', 'Provider request failed');
    const responseBody = (await response.json()) as Record<string, unknown>;
    ttft.observe(
      { model: catalog.publicName, provider: binding.providerId },
      (performance.now() - began) / 1000,
    );
    const usage = usageFromResponse(
      responseBody,
      inputEstimate,
      estimateTokens(responseBody.choices),
    );
    const fact: UsageFact = {
      requestId: started.requestId,
      orgId: principal.orgId,
      teamId: principal.teamId,
      apiKeyId: principal.apiKeyId,
      modelId: catalog.modelId,
      pricingId: catalog.pricingId,
      ...usage,
    };
    await finalizeWithPolicy(
      principal,
      fact,
      'succeeded',
      binding.providerId,
      {
        firstTokenMs: Math.round(performance.now() - began),
        totalMs: Math.round(performance.now() - began),
      },
      started.storesIdempotencyResponse ? responseBody : undefined,
    );
    await correctTokens(
      principal.orgId,
      principal.teamId,
      principal.apiKeyId,
      rateBucket,
      usage.inputTokens + usage.outputTokens - tokenEstimate,
    ).catch((error: unknown) => request.log.warn({ err: error }, 'TPM correction failed'));
    tokens.inc(
      { model: catalog.publicName, direction: 'input', source: usage.source },
      usage.inputTokens,
    );
    tokens.inc(
      { model: catalog.publicName, direction: 'output', source: usage.source },
      usage.outputTokens,
    );
    reply.header('x-tollgate-request-id', started.requestId);
    return responseBody;
  } finally {
    clearTimeout(timer);
  }
}

async function finalizeWithPolicy(
  principal: Principal,
  fact: UsageFact,
  status: 'succeeded' | 'failed' | 'client_aborted',
  providerId: string,
  timings: { firstTokenMs?: number; totalMs: number },
  response?: unknown,
) {
  try {
    await finalizeRequest(fact, status, providerId, timings, response);
  } catch (error) {
    if (principal.meteringFailure === 'fail_closed') throw error;
    await spoolUsage(fact, status);
  }
}

async function handleStream(
  request: FastifyRequest,
  reply: FastifyReply,
  principal: Principal,
  catalog: Catalog,
  body: ChatCompletionRequest,
  started: StartedRequest,
  inputEstimate: number,
  rateBucket: number,
  tokenEstimate: number,
) {
  const began = performance.now();
  const controller = new AbortController();
  let firstTokenMs: number | undefined;
  let providerId = catalog.bindings[0]!.providerId;
  let outputText = '';
  let finalUsage: ReturnType<typeof usageFromResponse> | undefined;
  let status: 'succeeded' | 'failed' | 'client_aborted' = 'succeeded';
  const ttftTimer = setTimeout(() => controller.abort(), config.TTFT_TIMEOUT_MS);
  const totalTimer = setTimeout(() => controller.abort(), config.TOTAL_STREAM_TIMEOUT_MS);
  const closed = () => {
    if (!reply.raw.writableEnded) {
      status = 'client_aborted';
      controller.abort();
    }
  };
  reply.raw.once('close', closed);
  try {
    const selected = await providerFetch(
      catalog,
      '/v1/chat/completions',
      request,
      { ...body, stream: true, stream_options: { include_usage: true } },
      started.requestId,
      controller.signal,
    );
    providerId = selected.binding.providerId;
    if (!selected.response.ok || !selected.response.body)
      throw new TollgateError(selected.response.status, 'provider_error', 'Provider stream failed');
    clearTimeout(ttftTimer);
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-tollgate-request-id': started.requestId,
    });
    const reader = selected.response.body.getReader();
    const decoder = new TextDecoder();
    let parseBuffer = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      firstTokenMs ??= Math.round(performance.now() - began);
      if (!reply.raw.write(chunk.value))
        await once(reply.raw, 'drain', { signal: controller.signal });
      parseBuffer += decoder.decode(chunk.value, { stream: true });
      const events = parseBuffer.split('\n\n');
      parseBuffer = events.pop() ?? '';
      for (const event of events) {
        const data = event
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice(6);
        if (!data || data === '[DONE]') continue;
        const parsed = JSON.parse(data) as Record<string, unknown>;
        if (parsed.error) status = 'failed';
        const choices = parsed.choices as Array<{ delta?: { content?: string } }> | undefined;
        outputText += choices?.[0]?.delta?.content ?? '';
        if (parsed.usage)
          finalUsage = usageFromResponse(parsed, inputEstimate, estimateTokens(outputText));
      }
    }
    reply.raw.end();
  } catch (error) {
    status = reply.raw.destroyed ? 'client_aborted' : 'failed';
    if (!reply.raw.headersSent) throw error;
    if (!reply.raw.writableEnded) {
      reply.raw.write(
        `data: ${JSON.stringify({ error: { message: 'Stream terminated', type: 'tollgate_error', code: 'stream_error' } })}\n\n`,
      );
      reply.raw.end();
    }
  } finally {
    clearTimeout(ttftTimer);
    clearTimeout(totalTimer);
    reply.raw.off('close', closed);
    const usage = finalUsage ?? {
      inputTokens: inputEstimate,
      outputTokens: estimateTokens(outputText),
      cachedInputTokens: 0,
      source: 'estimated' as const,
      providerRaw: null,
    };
    const fact: UsageFact = {
      requestId: started.requestId,
      orgId: principal.orgId,
      teamId: principal.teamId,
      apiKeyId: principal.apiKeyId,
      modelId: catalog.modelId,
      pricingId: catalog.pricingId,
      ...usage,
    };
    await finalizeWithPolicy(principal, fact, status, providerId, {
      ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
      totalMs: Math.round(performance.now() - began),
    });
    await correctTokens(
      principal.orgId,
      principal.teamId,
      principal.apiKeyId,
      rateBucket,
      usage.inputTokens + usage.outputTokens - tokenEstimate,
    ).catch((error: unknown) => request.log.warn({ err: error }, 'TPM correction failed'));
  }
}

export function buildGateway() {
  const principals = new WeakMap<FastifyRequest, Principal>();
  const authenticateRequest = async (request: FastifyRequest) => {
    principals.set(request, await authenticate(request));
  };
  const principalFor = (request: FastifyRequest): Principal => {
    const principal = principals.get(request);
    if (!principal) throw new Error('Authenticated principal missing from request context');
    return principal;
  };
  const app = Fastify({
    loggerInstance: createLogger(),
    requestIdHeader: 'x-request-id',
    disableRequestLogging: true,
  });
  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    const known =
      error instanceof TollgateError
        ? error
        : new TollgateError(500, 'internal_error', 'Internal gateway error');
    if (known.retryAfterSeconds) reply.header('retry-after', known.retryAfterSeconds);
    void reply.code(known.status).send(openAIError(known));
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/metrics', async (_request, reply) =>
    reply.type(registry.contentType).send(await registry.metrics()),
  );
  app.get('/v1/models', { preHandler: authenticateRequest }, async () => {
    const result = await query<{ id: string; public_name: string; created_at: Date }>(
      'SELECT id,public_name,now() created_at FROM models ORDER BY public_name',
    );
    return {
      object: 'list',
      data: result.rows.map((row) => ({
        id: row.public_name,
        object: 'model',
        created: Math.floor(row.created_at.getTime() / 1000),
        owned_by: 'tollgate',
      })),
    };
  });
  app.post<{ Body: unknown }>(
    '/v1/chat/completions',
    { preHandler: authenticateRequest },
    async (request, reply) => {
      const chatBody = parseChatCompletion(request.body);
      inFlight.inc();
      const stop = latency.startTimer({ model: chatBody.model });
      try {
        const principal = principalFor(request);
        if (chatBody.stream && request.headers['idempotency-key'])
          throw new TollgateError(
            400,
            'stream_idempotency_unsupported',
            'Idempotency-Key is not supported for streaming requests',
          );
        if (
          !principal.scopes.models?.includes(chatBody.model) ||
          !principal.scopes.endpoints?.includes('chat')
        )
          throw new TollgateError(403, 'scope_denied', 'API key scope does not allow this request');
        const idempotencyKey = request.headers['idempotency-key']
          ? String(request.headers['idempotency-key'])
          : undefined;
        const replay = await replayFor(principal.orgId, idempotencyKey);
        if (replay) return replay;
        const catalog = await loadCatalog(principal.orgId, chatBody.model);
        const inputEstimate = estimateTokens(chatBody.messages);
        const maxOutput = chatBody.max_tokens ?? catalog.defaultMaxOutput;
        const reserved = priceTokens(
          inputEstimate,
          maxOutput,
          0,
          catalog.inputPrice,
          catalog.outputPrice,
          catalog.cachedPrice,
        );
        const tokenEstimate = inputEstimate + maxOutput;
        const rate = await rateLimit(
          principal.orgId,
          principal.teamId,
          principal.apiKeyId,
          catalog.rpm,
          catalog.tpm,
          tokenEstimate,
        );
        reply.headers({
          'x-ratelimit-limit': rate.limit,
          'x-ratelimit-remaining': rate.remaining,
          'x-ratelimit-reset': Math.ceil(rate.resetMs / 1000),
        });
        const begun = await beginRequest(
          principal,
          catalog,
          Boolean(chatBody.stream),
          idempotencyKey,
          reserved,
        );
        if ('replay' in begun) return begun.replay;
        try {
          await admitReservationBudget(begun.reservationId);
        } catch (error) {
          await rejectPendingReservation(begun.reservationId, begun.requestId).catch(
            () => undefined,
          );
          throw error;
        }
        const body = { ...chatBody, max_tokens: maxOutput };
        let result: unknown;
        try {
          result = body.stream
            ? await handleStream(
                request,
                reply,
                principal,
                catalog,
                body,
                begun,
                inputEstimate,
                rate.bucket,
                tokenEstimate,
              )
            : await handleNonStream(
                request,
                reply,
                principal,
                catalog,
                body,
                begun,
                inputEstimate,
                rate.bucket,
                tokenEstimate,
              );
        } catch (error) {
          const fact: UsageFact = {
            requestId: begun.requestId,
            orgId: principal.orgId,
            teamId: principal.teamId,
            apiKeyId: principal.apiKeyId,
            modelId: catalog.modelId,
            pricingId: catalog.pricingId,
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            source: 'estimated',
            providerRaw: null,
          };
          await finalizeWithPolicy(principal, fact, 'failed', catalog.bindings[0]!.providerId, {
            totalMs: 0,
          });
          throw error;
        }
        requests.inc({ model: catalog.publicName, provider: 'selected', status: 'success' });
        return result;
      } finally {
        inFlight.dec();
        stop();
      }
    },
  );
  app.post<{ Body: unknown }>(
    '/v1/embeddings',
    { preHandler: authenticateRequest },
    async (request, reply) => {
      const embeddingBody = parseEmbedding(request.body);
      const principal = principalFor(request);
      const model = embeddingBody.model;
      if (
        !principal.scopes.models?.includes(model) ||
        !principal.scopes.endpoints?.includes('embeddings')
      )
        throw new TollgateError(403, 'scope_denied', 'API key scope does not allow this request');
      const idempotencyKey = request.headers['idempotency-key']
        ? String(request.headers['idempotency-key'])
        : undefined;
      const replay = await replayFor(principal.orgId, idempotencyKey);
      if (replay) return replay;
      const catalog = await loadCatalog(principal.orgId, model);
      const inputEstimate = estimateTokens(embeddingBody.input);
      const reserved = priceTokens(
        inputEstimate,
        0,
        0,
        catalog.inputPrice,
        catalog.outputPrice,
        catalog.cachedPrice,
      );
      const rate = await rateLimit(
        principal.orgId,
        principal.teamId,
        principal.apiKeyId,
        catalog.rpm,
        catalog.tpm,
        inputEstimate,
      );
      reply.headers({
        'x-ratelimit-limit': rate.limit,
        'x-ratelimit-remaining': rate.remaining,
        'x-ratelimit-reset': Math.ceil(rate.resetMs / 1000),
      });
      const begun = await beginRequest(principal, catalog, false, idempotencyKey, reserved);
      if ('replay' in begun) return begun.replay;
      try {
        await admitReservationBudget(begun.reservationId);
      } catch (error) {
        await rejectPendingReservation(begun.reservationId, begun.requestId).catch(() => undefined);
        throw error;
      }
      const controller = new AbortController();
      try {
        const selected = await providerFetch(
          catalog,
          '/v1/embeddings',
          request,
          embeddingBody,
          begun.requestId,
          controller.signal,
        );
        if (!selected.response.ok)
          throw new TollgateError(
            selected.response.status,
            'provider_error',
            'Provider request failed',
          );
        const responseBody = (await selected.response.json()) as Record<string, unknown>;
        const providerUsage = responseBody.usage as Record<string, unknown> | undefined;
        const inputTokens = Number(providerUsage?.prompt_tokens ?? inputEstimate);
        const fact: UsageFact = {
          requestId: begun.requestId,
          orgId: principal.orgId,
          teamId: principal.teamId,
          apiKeyId: principal.apiKeyId,
          modelId: catalog.modelId,
          pricingId: catalog.pricingId,
          inputTokens,
          outputTokens: 0,
          cachedInputTokens: 0,
          source: providerUsage ? 'provider' : 'estimated',
          providerRaw: providerUsage ?? null,
        };
        await finalizeWithPolicy(
          principal,
          fact,
          'succeeded',
          selected.binding.providerId,
          { totalMs: 0 },
          begun.storesIdempotencyResponse ? responseBody : undefined,
        );
        await correctTokens(
          principal.orgId,
          principal.teamId,
          principal.apiKeyId,
          rate.bucket,
          inputTokens - inputEstimate,
        ).catch((error: unknown) => request.log.warn({ err: error }, 'TPM correction failed'));
        reply.header('x-tollgate-request-id', begun.requestId);
        return responseBody;
      } catch (error) {
        const fact: UsageFact = {
          requestId: begun.requestId,
          orgId: principal.orgId,
          teamId: principal.teamId,
          apiKeyId: principal.apiKeyId,
          modelId: catalog.modelId,
          pricingId: catalog.pricingId,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          source: 'estimated',
          providerRaw: null,
        };
        await finalizeWithPolicy(principal, fact, 'failed', catalog.bindings[0]!.providerId, {
          totalMs: 0,
        });
        throw error;
      }
    },
  );
  app.addHook('onClose', async () => {
    await redis.quit();
  });
  return app;
}
