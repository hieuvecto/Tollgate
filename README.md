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

Gateway, control plane, Grafana, Prometheus, and mock provider listen on ports 3000, 3001, 3002, 9090, and 4010 respectively.

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

Plaintext credentials are shown only at creation. Logs redact authorization and prompt paths. Money never uses floating point. Idempotency, outbox consumption, and charges are constrained in the database—not left to application timing. Accounting corrections are reversals rather than edits.

## Where OpenAI compatibility leaks

The Anthropic adapter translates system messages, content blocks, tool use, stop reasons, cached-token fields, and SSE events. The mapping is necessarily lossy: reasoning blocks have no universal OpenAI representation; system-message placement differs; stop reasons are broader than OpenAI's; cached-token definitions are provider-specific; and provider tokenizer counts can disagree with estimates. Tollgate always prefers provider-reported usage when present.

The generic adapter can target a separately run Ollama, llama-server, or other OpenAI-compatible endpoint by changing the provider binding base URL and model name. No real-model runtime or model download is bundled.

## Known limitations

- Streaming requests reject `Idempotency-Key`; non-streaming successes can replay.
- Provider tokenizer drift can settle above the reserved estimate; no fixed percentage tolerance is claimed.
- TPM is estimate-then-correct and may drift for the duration of a request plus settlement lag.
- RPM and TPM use fixed one-minute buckets, so callers can burst across a bucket boundary.
- If post-flight TPM correction cannot reach Redis, the conservative estimate remains until the
  bucket expires; the completed provider response is not converted into a gateway error.
- Missing terminal usage is explicitly estimated and requires reconciliation.
- Admission always requires PostgreSQL so idempotency and budgets remain durable. After provider invocation,
  fail-open may spool final usage to Redis AOF during a brief finalization outage; it is not a substitute for
  a replicated accounting store.
- Provider cost and public price are modeled separately only at the routing boundary; production pricing needs contractual provider tiers.

## Operations and tests

```sh
make test       # lint, strict typecheck, unit/integration tests
make chaos      # fault matrix against local services
make reconcile  # compare recent ledger facts with mock invoice
TOLLGATE_API_KEY="$TOLLGATE_API_KEY" make load
```

Fault injection uses `X-Tollgate-Fault`: `pre_500`, `midstream_500`, `rate_limit`, `hang`, `missing_usage`, or `wrong_usage`. Delay headers control TTFT and inter-token timing.

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
