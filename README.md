# Tollgate

An OpenAI-compatible LLM gateway built to be correct about money: append-only usage ledger, idempotent request handling, reserve/settle budgets, and reconciliation that proves the ledger matches provider-reported usage. It runs locally with a scriptable mock provider for failure testing.

## What this is—and is not

Tollgate is a local-first portfolio implementation of the difficult accounting path behind an LLM proxy. It supports chat completions and embeddings, streaming, multiple provider formats, scoped keys, budgets, rate limits, reporting, and operational telemetry.

It is not hosted, a payment product, or a feature match for OpenRouter or LiteLLM. It has no signup, Stripe integration, semantic cache, multi-region control plane, Kubernetes, Terraform, or fine-tuning router. No test or CI job uses an external provider key.

## Quickstart

Requirements are Docker with Compose and Make. Host Node is not used by the services.

```sh
git clone <repository-url> tollgate
cd tollgate
make up
make seed
```

`make seed` prints local credentials exactly once. Copy a `gateway team` key:

```sh
export TOLLGATE_API_KEY='<printed tg_live key>'
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $TOLLGATE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"tg-mock","messages":[{"role":"user","content":"hello"}]}'

curl -N http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $TOLLGATE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"tg-mock","stream":true,"messages":[{"role":"user","content":"stream"}]}'
```

Gateway, control plane, Grafana, Prometheus, Alertmanager, and mock provider listen on ports 3000, 3001, 3002, 9090, 19093, and 4010 respectively.

## Architecture

```text
client -> gateway -> provider bindings -> local mock
            |              |
       Redis rate limit  health/failover
            |
       PostgreSQL budget + request + outbox
            |
          worker -> usage facts -> immutable ledger
            |
       reconciliation + reports

control-plane -> policy, keys, pricing, budgets
Prometheus <- gateway/worker <- Grafana
```

The data plane only performs latency-sensitive authentication, admission, routing, streaming, and durable outbox work. The control plane owns policy mutation and reporting. See [the money path](docs/money-path.md) and the checked-in [ADRs](docs/adr/).

## The money path

The central lifecycle is reserve → invoke → record → settle → reconcile. Prices are versioned, selected at request start, and attached to every charge. Usage and ledger rows are protected by append-only database triggers. Outbox delivery is at-least-once; unique constraints make settlement idempotent.

## Deliberate trade-offs

| Decision                    | Optimized for                                       | Gave up                         | Revisit when                                    |
| --------------------------- | --------------------------------------------------- | ------------------------------- | ----------------------------------------------- |
| PostgreSQL outbox           | Auditability and few moving parts                   | Broker throughput               | Sustained settlement volume exceeds DB capacity |
| PostgreSQL budget locks     | Ledger-derived period and team enforcement          | An extra admission query        | Measured DB contention justifies a projection   |
| Redis rate-limit Lua        | Atomic fixed-window RPM/TPM admission               | Cross-region operation          | A real multi-region customer exists             |
| Abort on disconnect         | Stop unwanted provider spend                        | Guaranteed final provider usage | Providers offer reliable cancellation receipts  |
| Reject stream idempotency   | Honest pass-through streaming                       | Stream replay                   | Clients require durable stream resumption       |
| HMAC-SHA-256 API-key hashes | Fast verification of high-entropy generated secrets | Password-grade work factor      | User-chosen low-entropy secrets are accepted    |
| TypeScript data plane       | Iteration speed and shared contracts                | Lowest possible proxy overhead  | Measurements show gateway overhead dominates    |

## What is not negotiable

Plaintext credentials are shown only at creation. Logs redact authorization and prompt paths. Money never uses floating point. Idempotency, outbox consumption, and charges are constrained in the database—not left to application timing. The schema reserves reversal and adjustment entries for future corrections; the current reconciliation command reports findings but does not propose or apply ledger changes.

## Where OpenAI compatibility leaks

Chat and embedding bodies are validated before admission; malformed requests return an OpenAI-shaped `400 invalid_request_error`. Provider responses are normalized to the requested public model name in JSON and SSE so internal binding names do not leak to clients.

The non-streaming Anthropic adapter translates system messages, text and tool-use content blocks, stop reasons, and cached-token fields. Streaming currently translates text deltas and terminal usage only; streamed tool calls, the initial assistant-role delta, cached-input details, and terminal `finish_reason` remain unimplemented. The mapping is necessarily lossy: reasoning blocks have no universal OpenAI representation, system-message placement differs, and provider tokenizer counts can disagree with estimates. Tollgate always prefers provider-reported usage when present.

The generic adapter can target a separately run Ollama, llama-server, or other OpenAI-compatible endpoint by changing the provider binding base URL and model name. No real-model runtime or model download is bundled.

## Known limitations

- Streaming requests reject `Idempotency-Key`; non-streaming successes can replay.
- Non-streaming idempotency keys and replay bodies are retained for 24 hours by default; accounting
  facts are retained independently.
- Provider tokenizer drift can settle above the reserved estimate; no fixed percentage tolerance is claimed.
- TPM is estimate-then-correct and may drift for the duration of a request plus settlement lag.
- RPM and TPM use fixed one-minute buckets, so callers can burst across a bucket boundary.
- Organization, team, and key rate counters currently share one policy limit; independently configured
  hierarchical limits are not implemented.
- If post-flight TPM correction cannot reach Redis, the conservative estimate remains until the
  bucket expires; the completed provider response is not converted into a gateway error.
- Missing terminal usage is explicitly estimated and requires reconciliation.
- Admission always requires PostgreSQL so idempotency and budgets remain durable. After provider invocation,
  fail-open may spool final usage to Redis AOF during a brief finalization outage; it is not a substitute for
  a replicated accounting store.
- Provider cost and public price are modeled separately only at the routing boundary; production pricing needs contractual provider tiers.
- Organization owners can store per-provider BYOK credentials using envelope encryption. Authenticated
  OpenAI-compatible calls use bearer tokens and Anthropic calls use `x-api-key`; the bundled local providers
  remain credential-free. Deployments enabling BYOK must supply a base64-encoded 32-byte
  `PROVIDER_CREDENTIAL_KEK`. External KMS integration and automated key-version rotation are not implemented.
- Providers, models, bindings, and pricing are a global operator catalog rather than tenant-owned resources.
  Tenant credentials can read that catalog but cannot mutate global pricing; local operator changes use seed
  data or forward migrations until a separate platform-admin trust boundary exists.
- Outbox failures retry with bounded exponential backoff. After ten attempts the append-only payload remains
  unprocessed as an inspectable dead letter; automatic replay or discard requires an explicit operator action.

## How this was built

The initial portfolio implementation was assembled agent-natively in one working session. Commits `m0` through `m10` were checkpointed in a short sequence after the working tree had been assembled; their timestamps are not presented as elapsed hand-development time. The history is preserved rather than rewritten.

Subsequent remediation uses the repository's `AGENTS.md` guardrails: money-path work starts with an asserting test, each milestone must pass lint, strict typecheck, formatting, and the relevant local integration suite, and each passing milestone receives its own conventional commit. Tests use the scriptable local provider and require neither a provider credential nor external network access.

## Operations and tests

```sh
make test       # lint, strict typecheck, unit/integration tests
make chaos      # fault matrix against local services
make reconcile  # compare recent ledger facts with mock invoice
TOLLGATE_API_KEY="$TOLLGATE_API_KEY" make load
```

Fault injection uses `X-Tollgate-Fault`: `pre_500`, `midstream_500`, `rate_limit`, `hang`, `missing_usage`, or `wrong_usage`. Delay headers control TTFT and inter-token timing.

Prometheus loads checked-in alerts for API error rate, outbox lag and dead letters, overdue reservations, and open provider breakers. The bundled Alertmanager receiver is deliberately local and has no external paging destination; production deployment must route it to the owning team's incident system.

The service images use package-local compiled JavaScript, install production dependencies only, run as the unprivileged `tollgate` user, and expose HTTP health checks. The Compose stack explicitly uses development configuration for its bundled local pepper. A production process refuses to start with that pepper, so deployments must supply a unique `KEY_PEPPER` through their secret manager.

Provider credentials are organization-scoped and are accepted only through the authenticated control plane. Tollgate creates a random data-encryption key per credential, encrypts the credential with AES-256-GCM, and wraps that data key with `PROVIDER_CREDENTIAL_KEK`. Only ciphertext, authentication metadata, and a one-way fingerprint are stored; plaintext credentials and decrypted catalog entries are excluded from Redis.

## Benchmarks

Run the gateway load profile with `make load`. For the deliberately limited language comparison, start `docker compose --profile benchmark up --build go-baseline` and apply the same direct pass-through workload to ports 3000 and 3010. The Go service is a streaming baseline—not a billing gateway—so its result isolates a lower bound rather than claiming feature parity.

Measured on 2026-08-02 using Docker Desktop on an arm64 Mac, five concurrent local mock streams, 50 requests, and the checked-in k6 script:

| Path                                        | Success |  Average |      p50 |       p95 |       p99 | Observed RSS |
| ------------------------------------------- | ------: | -------: | -------: | --------: | --------: | -----------: |
| Tollgate Node gateway, full accounting path |   50/50 | 53.32 ms | 46.21 ms | 106.19 ms | 113.19 ms |      167 MiB |
| Minimal Go streaming proxy                  |   50/50 | 15.27 ms | 13.36 ms |  31.46 ms |  32.44 ms | 3.2 MiB idle |

The gateway event-loop lag sample was 10.1 ms. A separate delayed-stream sample moved gateway RSS from 166.3 to 167.0 MiB with five active streams—about 0.14 MiB per stream, but too small a sample to treat as a capacity bound.

The result does **not** say that equivalent Go billing code is four times faster: the Go baseline performs no authentication, Redis admission, PostgreSQL audit, routing health update, usage capture, or metrics accounting. It quantifies the optimization ceiling. Provider latency still dominates normal traffic, so Tollgate retains Node for shared types and implementation speed; revisit that choice when sustained concurrency makes measured gateway overhead material.

## Roadmap

Before adding features, validate the budget and reconciliation contracts with a real user. Likely next steps are provider invoice pagination, approved adjustment workflows, durable streaming replay if demanded, and measured real-model tokenizer drift. Hedging and multi-region coordination remain deferred until their cost-accounting semantics are justified.
