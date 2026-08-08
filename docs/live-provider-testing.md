# Testing Tollgate against real provider keys

Status: strategy document. Nothing in this file changes the default test suite, which stays
hermetic per `AGENTS.md` ("Tests require no provider key or network egress").

## 1. Verdict

**Yes — the repository can be driven against real OpenAI, Anthropic, and other
OpenAI-compatible provider keys, but no wiring for it ships today.** The data plane already
contains everything needed to authenticate to a real upstream:

- provider `kind` values `openai`, `anthropic`, `openai_compatible` are legal in the schema
  (`packages/db/migrations/001_initial.sql:24`);
- credential headers are already dialect-aware — `x-api-key` for Anthropic, `Authorization:
Bearer` for everything else (`packages/gateway/src/providers.ts:143-147`);
- the Anthropic adapter targets `${baseUrl}/v1/messages` with `anthropic-version: 2023-06-01`
  and translates requests and SSE both ways (`packages/gateway/src/providers.ts:160-172`,
  `174-384`);
- BYOK credentials are stored per `(org, provider)` under envelope encryption and are decrypted
  only in the gateway request path (`packages/control-plane/src/app.ts:328-385`,
  `packages/gateway/src/catalog.ts:59-99`).

What is missing is entirely **configuration and harness**, not capability:

1. no provider/model/binding/pricing rows for real providers, and no API to create them —
   the catalog is operator-owned and mutable only through seed data or migrations
   (`docs/open-questions.md`);
2. no `PROVIDER_CREDENTIAL_KEK` by default, without which any credential-bearing binding
   fails closed with `503 credential_decryption_unavailable`;
3. no opt-in live test suite, and CI has no provider secrets (`.github/workflows/ci.yml`);
4. several defaults (a 5 s TTFT deadline, an always-injected `max_tokens`) are tuned for the
   local mock and will break or distort real calls.

Sections 3–9 turn that into a concrete plan.

## 2. What already works (verified)

| Capability                                       | Evidence                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI-compatible pass-through with bearer auth  | `providers.ts:148-154`; probe produced `POST https://api.openai.com/v1/chat/completions` with `authorization: Bearer …` and the body passed through verbatim plus the binding's `model`                                                                                                        |
| Anthropic request translation                    | probe produced `POST https://api.anthropic.com/v1/messages`, headers `anthropic-version` + `x-api-key`, system messages hoisted to `system`, OpenAI tool defs rewritten to `input_schema`                                                                                                      |
| Anthropic SSE → OpenAI SSE                       | probe fed a realistic Anthropic stream (`event:` lines, `ping`, `content_block_*`, `message_delta`, `message_stop`) and got well-formed OpenAI chunks: assistant role first, content deltas, terminal `finish_reason`, final `usage` with `prompt_tokens_details.cached_tokens`, then `[DONE]` |
| Provider-reported usage preferred over estimates | `gateway/src/app.ts:122-136` (`source: 'provider'` whenever `usage` is present); `stream_options.include_usage` is injected for streaming (`app.ts:321`)                                                                                                                                       |
| Public model name never leaks binding names      | `providers.ts:95-136`, `181-191`                                                                                                                                                                                                                                                               |
| Credentials never enter Redis                    | `catalog.ts:17-21`, `112-123`; cached bindings that require a credential are dropped on the fallback path (`catalog.ts:142-157`)                                                                                                                                                               |
| Credential rotation/revocation is audited        | `control-plane/src/app.ts:373-382`, `399-408`; `admin_audit_log` rejects UPDATE/DELETE                                                                                                                                                                                                         |
| Logs redact `authorization` and `x-api-key`      | `packages/shared/src/logger.ts`                                                                                                                                                                                                                                                                |
| Hermetic suite is green without any key          | `pnpm test:unit` → 18 passed, 7 files                                                                                                                                                                                                                                                          |

## 3. Blockers and sharp edges before a live run

Each item is something a live run hits; `Action` is what to do about it.

### B1 — No API for the provider/model/binding/pricing catalog

`GET /admin/providers` and `GET /admin/models` are read-only; there is no create endpoint. The
gateway resolves a public model name to bindings purely from `models`, `model_pricing`,
`provider_bindings`, `providers` (`catalog.ts:37-50`).
**Action:** insert live catalog rows with SQL (section 4, step 3) or add a `seed-live.ts`
(section 9, C1). Do not repurpose the seeded `tg-*` models — `make seed` truncates them and
re-points `providers.base_url` at `MOCK_PROVIDER_URL`.

### B2 — `PROVIDER_CREDENTIAL_KEK` is optional but required for BYOK

Unset by default (`packages/shared/src/config.ts:13`); Compose passes it through from the host
(`docker-compose.yml`, `PROVIDER_CREDENTIAL_KEK: ${PROVIDER_CREDENTIAL_KEK:-}`). Without it the
control plane returns `503 credential_encryption_unavailable` on store, and the gateway returns
`503 credential_decryption_unavailable` on use.
**Action:** generate a base64 32-byte key once per environment and export it before `make up`.
It must be identical for the control plane and the gateway or decryption fails.

### B3 — API-key scopes gate the model name

Seeded keys are scoped to `['tg-mock','tg-anthropic','tg-compatible']`
(`packages/db/src/seed.ts:50`); anything else is `403 scope_denied` (`app.ts:476-481`).
**Action:** mint a new key through `POST /admin/api-keys` with the live model names in `scopes`.

### B4 — `TTFT_TIMEOUT_MS` is an end-to-end deadline for non-streaming calls

Default 5000 ms. In `handleNonStream` the abort timer is cleared only after `providerFetch`
resolves (`app.ts:206-217`), and for a buffered (non-streaming) provider response the headers
arrive only once generation is finished. **Verified**: a 1.5 s buffered upstream against a 1 s
timer aborts before headers. Real completions routinely exceed 5 s, producing
`504 provider_timeout` — _after_ the provider has already been paid.
**Action:** for live runs export `TTFT_TIMEOUT_MS=60000` (and raise
`TOTAL_STREAM_TIMEOUT_MS=300000` for long streams). Treat the shared timer as a real design
finding, not a test-harness annoyance: a non-streaming timeout currently finalizes the request
with 0/0 tokens (`app.ts:546-563`) while the money was spent upstream.

### B5 — `max_tokens` is always injected

The gateway sets `max_tokens = body.max_tokens ?? catalog.defaultMaxOutput` on every chat call
(`app.ts:489`, `520`). OpenAI's reasoning families (`o*`, `gpt-5*`) reject `max_tokens` and
require `max_completion_tokens`.
**Action:** for the first live pass bind non-reasoning chat models (`gpt-4o-mini`,
`gpt-4.1-mini`). If reasoning models matter, add the parameter mapping first (section 9, C3).
Confirm current parameter names against OpenAI's docs before writing the binding.

### B6 — The Anthropic adapter is intentionally lossy on sampling params

The Anthropic body is constructed field-by-field, so passthrough fields are dropped. **Verified**:
`temperature: 0.2` and `stream_options` present in the client request do not reach
`api.anthropic.com`.
**Action:** do not assert on `temperature`/`top_p`/`top_k`/`stop` behaviour through the
Anthropic path, and document it as expected rather than filing it as a bug.

### B7 — Anthropic mid-stream `error` events are swallowed

`normalizeProviderResponse` switches on known event types only. **Verified**: a stream of
`message_start` → `text_delta` → `error` yields the partial OpenAI chunks with **no**
`finish_reason`, no `[DONE]`, and no error chunk. Because the gateway detects stream failure by
looking for `parsed.error` in the translated stream (`app.ts:357`), the request is recorded
`succeeded` with `source: 'estimated'` usage. The OpenAI-compatible path does not have this
asymmetry — error chunks pass through and flip the status to `failed`.
**Action:** treat an Anthropic `overloaded_error` mid-stream as a known gap. Live tests should
assert the reconciliation finding (`estimated_usage`) rather than a `failed` status; fixing it
is section 9, C4.

### B8 — Embeddings only work on OpenAI-shaped bindings

For `path === '/v1/embeddings'` the Anthropic branch is skipped, so an `anthropic`-kind binding
gets `POST https://api.anthropic.com/v1/embeddings` (**verified** URL) → 404 → `provider_error`.
**Action:** bind embeddings models to OpenAI/compatible providers only.

### B9 — Reconciliation has no real-provider invoice source

`reconcile-once.ts:6-12` fetches the mock's `/invoice`; on failure it silently falls back to
internal invariants only. Real provider usage/cost APIs differ per vendor and are explicitly out
of scope (`docs/open-questions.md`).
**Action:** live reconciliation checks internal invariants (missing/estimated usage, aborted
streams, retries, orphaned reservations). For a genuine three-way tie-out, snapshot each live
call's provider-reported usage from the response and feed it to `reconcile()` as the invoice
array — that is the honest live equivalent, and it is cheap to build (section 9, C5).

### B10 — Failover retries cost real money

`providerFetch` walks every binding for the model and retries on network error, `429`, and `5xx`
(`app.ts:147-191`). With two live bindings on one model, one rate-limit response can mean paying
two providers for one client request.
**Action:** during cost-sensitive tests bind exactly one provider per live public model. Add a
second binding only for a deliberate failover test, and prefer pairing one live provider with
the local mock as the fallback.

### B11 — A Postgres blip drops credential-bearing bindings

On the Redis fallback path bindings with `credentialRequired` are filtered out and, if none
remain, the request fails `503 provider_unavailable` (`catalog.ts:142-157`). This is deliberate —
plaintext credentials are never cached.
**Action:** expected behaviour; assert it rather than report it.

### B12 — Fault injection is meaningless upstream

`X-Tollgate-Fault`, `X-Tollgate-Ttft-Ms`, `X-Tollgate-Token-Delay-Ms`,
`X-Tollgate-Fail-After-Tokens` are forwarded to the provider on the first attempt only
(`app.ts:24-29`, `156-158`); real providers ignore them.
**Action:** keep `tests/chaos` and the whole fault matrix on the mock provider. Live tests cover
happy paths, accounting, and real error codes (401/429), not injected faults.

### B13 — `.dockerignore` does not exclude secrets

`.gitignore` excludes `.env`, but `.dockerignore` lists only `node_modules`, `dist`, `.git`,
`coverage`. A local `.env` holding real provider keys is therefore inside the Docker build
context.
**Action:** add `.env`, `.env.*`, `*.pem`, `*.key` to `.dockerignore` before putting real keys in
a `.env` beside the Dockerfile (section 9, C2). Prefer `export`-ed shell variables or a secret
manager over a file on disk.

### B14 — Budget caps are denominated in the _public_ price

Admission reserves `priceTokens(inputEstimate, maxOutput, …)` using `model_pricing`, not the
binding's `input_cost_per_mtok` (`app.ts:490-497`, `metering.ts:36-64`). A budget only bounds
real spend if the public price is at least the provider's price.
**Action:** set `model_pricing` for live models at or above the real provider rate (section 4
uses provider rates exactly, which makes the budget a true cap).

### B15 — Token estimates diverge from real tokenizers

`estimateTokens` is `JSON.stringify(value).length / 4` (`catalog.ts:168`). Reserved amounts, TPM
admission, and the post-flight correction are all estimate-then-correct.
**Action:** this is the most interesting thing a live run measures. Record
`estimate vs provider-reported` per call; it is a real number the mock cannot produce.

## 4. Setup runbook

Run from a clean checkout. Steps 1–2 are one-time per environment.

**Step 1 — generate the KEK and export the live overrides.**

```sh
export PROVIDER_CREDENTIAL_KEK="$(openssl rand -base64 32)"   # exactly 32 bytes decoded
export TTFT_TIMEOUT_MS=60000            # see B4
export TOTAL_STREAM_TIMEOUT_MS=300000
export OPENAI_API_KEY='sk-…'            # never committed, never echoed
export ANTHROPIC_API_KEY='sk-ant-…'
make up && make seed
```

`make seed` prints the seeded credentials once. Keep the `control-plane owner` token
(`tg_admin_…`) — the remaining steps use it as `$TG_ADMIN`.

**Step 2 — confirm encryption is live.**

```sh
curl -s localhost:3001/admin/providers -H "Authorization: Bearer $TG_ADMIN" | jq
```

**Step 3 — insert the live catalog.** Prices below are micros per million tokens
(`1_000_000` micros = \$1.00/MTok; `packages/shared/src/money.ts`). Anthropic rates are current
as of 2026-06; **verify both vendors' current published prices before relying on the numbers**.

```sql
-- providers: base_url is the API root, with no /v1 suffix
INSERT INTO providers(name, kind, base_url) VALUES
  ('openai-live',    'openai',    'https://api.openai.com'),
  ('anthropic-live', 'anthropic', 'https://api.anthropic.com');

-- public models. Small default_max_output_tokens bounds spend per request (see §7).
INSERT INTO models(public_name, context_window, default_max_output_tokens) VALUES
  ('live-openai-chat',     128000, 64),
  ('live-anthropic-chat',  200000, 64),
  ('live-openai-embed',      8191,  1);

-- public price = provider price, so budgets are a true spend cap (B14)
INSERT INTO model_pricing(model_id, input_per_mtok, output_per_mtok, cached_input_per_mtok, effective_from)
SELECT id,  150000,   600000,    75000, '2020-01-01' FROM models WHERE public_name = 'live-openai-chat'     -- gpt-4o-mini
UNION ALL
SELECT id, 1000000,  5000000,   100000, '2020-01-01' FROM models WHERE public_name = 'live-anthropic-chat'  -- claude-haiku-4-5
UNION ALL
SELECT id,   20000,        0,        0, '2020-01-01' FROM models WHERE public_name = 'live-openai-embed';   -- text-embedding-3-small

-- exactly one binding per live model (B10)
INSERT INTO provider_bindings(model_id, provider_id, provider_model_name, priority, input_cost_per_mtok, output_cost_per_mtok)
SELECT m.id, p.id, 'gpt-4o-mini', 1, 150000, 600000
  FROM models m, providers p WHERE m.public_name='live-openai-chat'    AND p.name='openai-live'
UNION ALL
SELECT m.id, p.id, 'claude-haiku-4-5', 1, 1000000, 5000000
  FROM models m, providers p WHERE m.public_name='live-anthropic-chat' AND p.name='anthropic-live'
UNION ALL
SELECT m.id, p.id, 'text-embedding-3-small', 1, 20000, 0
  FROM models m, providers p WHERE m.public_name='live-openai-embed'   AND p.name='openai-live';
```

Apply with `docker compose exec -T postgres psql -U tollgate -d tollgate < live-catalog.sql`.

**Step 4 — store the provider credentials through the control plane.** This is the only
supported path; there is no environment variable that injects a provider key into the gateway,
and that is by design.

```sh
OPENAI_ID=$(curl -s localhost:3001/admin/providers -H "Authorization: Bearer $TG_ADMIN" \
  | jq -r '.data[] | select(.name=="openai-live") .id')
ANTHROPIC_ID=$(curl -s localhost:3001/admin/providers -H "Authorization: Bearer $TG_ADMIN" \
  | jq -r '.data[] | select(.name=="anthropic-live") .id')

curl -s -X PUT "localhost:3001/admin/provider-credentials/$OPENAI_ID" \
  -H "Authorization: Bearer $TG_ADMIN" -H 'Content-Type: application/json' \
  -d "{\"apiKey\":\"$OPENAI_API_KEY\"}"
curl -s -X PUT "localhost:3001/admin/provider-credentials/$ANTHROPIC_ID" \
  -H "Authorization: Bearer $TG_ADMIN" -H 'Content-Type: application/json' \
  -d "{\"apiKey\":\"$ANTHROPIC_API_KEY\"}"
```

Each response returns only `{providerId, fingerprint, status}` — the 16-hex fingerprint is the
handle to assert on later.

**Step 5 — mint a scoped key and a tight budget.**

```sh
LIVE_KEY=$(curl -s -X POST localhost:3001/admin/api-keys \
  -H "Authorization: Bearer $TG_ADMIN" -H 'Content-Type: application/json' \
  -d '{"name":"live-provider-smoke","scopes":{"models":["live-openai-chat","live-anthropic-chat","live-openai-embed"],"endpoints":["chat","embeddings"]}}' \
  | jq -r .key)

# $2.00/day hard stop for the whole org
curl -s -X PUT localhost:3001/admin/budgets \
  -H "Authorization: Bearer $TG_ADMIN" -H 'Content-Type: application/json' \
  -d '{"period":"day","limitMicros":"2000000","hardStop":true}'

# 10 rpm / 20k tpm
curl -s -X PUT localhost:3001/admin/routing-policy \
  -H "Authorization: Bearer $TG_ADMIN" -H 'Content-Type: application/json' \
  -d '{"strategy":"failover_order","rpmLimit":10,"tpmLimit":20000}'
```

The key is scoped to a team-less org key, which means org-level budgets and limits apply.

**Step 6 — smoke.**

```sh
curl -s localhost:3000/v1/chat/completions -H "Authorization: Bearer $LIVE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"live-anthropic-chat","max_tokens":16,"messages":[{"role":"user","content":"reply with the single word ok"}]}' \
  | jq '{model, finish: .choices[0].finish_reason, usage}'
```

Expect `model: "live-anthropic-chat"` (never `claude-haiku-4-5`) and a real `usage` block.
Then repeat with `"stream": true` and with `live-openai-chat`, and once against
`/v1/embeddings` with `live-openai-embed`.

## 5. Test strategy — four layers

The point of layering is that only L1–L3 need money, and they need very little of it. Keep the
default `pnpm test` and CI exactly as they are.

### L0 — Hermetic contract tests against captured real payloads (where most assertions belong)

Run one live call per provider per shape, save the raw upstream bytes as fixtures, and assert
the adapters against those forever. This converts a one-time \$0.01 spend into permanent
regression coverage that needs no network. `tests/unit/providers.test.ts` is already exactly this
shape — extend it with real captures:

- a real OpenAI streaming response including the final `usage`-only chunk (`choices: []`);
- a real Anthropic stream including `ping`, `content_block_start` with a non-empty initial
  `input`, `input_json_delta` tool arguments, and `message_delta` stop reasons;
- a real Anthropic non-streaming tool-use response, asserting the `tool_calls` mapping;
- real 400/401/429 error bodies, asserting the gateway's OpenAI-shaped surface.

Capture with a small throwaway script; redact nothing except that no `authorization`/`x-api-key`
header ever goes into a fixture.

### L1 — Live smoke (opt-in, seconds, a few cents)

New suite `tests/live/`, gated the same way integration tests are gated
(`process.env.RUN_INTEGRATION === '1' ? describe : describe.skip`) but on `RUN_LIVE_PROVIDER=1`,
so it can never run by accident. Five cases, `max_tokens: 16`, one-word prompts:

| Case                                   | Asserts                                                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| OpenAI non-streaming chat              | 200; `model` is the public name; `usage.prompt_tokens > 0`; `usage_events.source = 'provider'`                  |
| OpenAI streaming chat                  | terminal `finish_reason`; a final chunk carrying `usage`; `[DONE]`; settled from provider counts, not estimates |
| Anthropic non-streaming chat           | `finish_reason` mapped from `stop_reason`; `prompt_tokens_details.cached_tokens` present                        |
| Anthropic streaming chat with one tool | indexed `tool_calls` deltas reassemble into valid JSON arguments                                                |
| OpenAI embeddings                      | `data[0].embedding` length; `usage.prompt_tokens` recorded                                                      |

Every case additionally asserts the invariants that only a live key can prove: no provider key
appears in gateway logs, in Redis (`KEYS catalog:*` payloads), or in any API response body; and
`provider_credentials` still stores only ciphertext plus the fingerprint.

### L2 — Live accounting and drift (the reason to do this at all)

For each L1 call, after `settleBatch` drains the outbox, assert the money path end to end with
real token counts (SQL in section 6): one `usage_events` row with `source='provider'`, exactly
one `charge` ledger entry equal to `priceTokens(provider tokens…)`, the reservation released, and
`provider_raw` holding the vendor's own usage object. Then record the estimate-vs-actual delta —
this is the measurement `docs/open-questions.md` and the "tokenizer drift" limitation in the
README are currently unquantified about. A short table of observed drift per provider and shape
is a genuinely valuable artifact.

Also worth one live pass: `Idempotency-Key` replay on a non-streaming call, asserting the second
request returns the stored body and creates **no** second charge and no second provider call.

### L3 — Live failure semantics (no injected faults; real ones)

- **Bad credential** — rotate the stored credential to a syntactically valid but wrong key,
  assert the upstream 401 surfaces as an OpenAI-shaped error and that the failed request is
  finalized rather than left `in_progress`; rotate back and assert a new fingerprint plus two
  `provider_credential.rotate` rows in `admin_audit_log`.
- **Revocation** — `DELETE /admin/provider-credentials/:id`, then assert the next request is
  `503` (the binding requires a credential that no longer exists) and that the audit trail
  records `provider_credential.revoke`.
- **Budget hard stop** — set `limitMicros` below one request's reservation and assert `402
budget_exceeded` **and** that no provider call was made (`requests.attempt_count = 0`). This is
  the cheapest high-value live test: it proves admission blocks spend before egress.
- **Rate limit** — drive above `rpmLimit` and assert `429` with `retry-after`, again with no
  upstream call.
- **Real provider 429** — optional; hard to trigger deliberately and not worth burning quota.

### Do not run live

The chaos matrix (B12), `make load` / k6 and `pnpm benchmark:local` (they issue 50+ streaming
requests — on a real provider that is real money and a rate-limit incident, and the published
benchmark numbers are only meaningful against the mock anyway), and anything asserting Anthropic
sampling-parameter behaviour (B6).

## 6. Post-call assertions

```sql
-- money path for one request id
SELECT r.status, r.attempt_count, r.stream, r.first_token_ms, r.total_ms,
       u.source, u.input_tokens, u.output_tokens, u.cached_input_tokens,
       u.provider_raw,
       l.kind, l.amount_micros,
       res.status AS reservation_status, res.amount_micros AS reserved_micros
  FROM requests r
  LEFT JOIN usage_events u ON u.request_id = r.id
  LEFT JOIN ledger_entries l ON l.request_id = r.id
  LEFT JOIN reservations res ON res.request_id = r.id
 WHERE r.id = :request_id;
```

Expect `source='provider'`, `provider_raw` non-null, exactly one `charge`, `reservation_status`
released/settled, and `amount_micros` equal to `priceTokens` over the provider's counts.

```sql
-- estimate vs provider drift, per model and shape (B15)
SELECT m.public_name, r.stream,
       count(*)                                        AS calls,
       avg(res.amount_micros - l.amount_micros)        AS avg_over_reservation_micros,
       max(res.amount_micros - l.amount_micros)        AS max_over_reservation_micros
  FROM requests r
  JOIN models m           ON m.id = r.model_id
  JOIN reservations res    ON res.request_id = r.id
  JOIN ledger_entries l    ON l.request_id = r.id AND l.kind = 'charge'
 WHERE m.public_name LIKE 'live-%'
 GROUP BY 1, 2;
```

```sql
-- credential storage is ciphertext-only, and the audit trail is complete
SELECT provider_id, secret_fingerprint, status, key_version, created_at, revoked_at
  FROM provider_credentials;
SELECT action, target_type, changes, created_at
  FROM admin_audit_log ORDER BY created_at DESC LIMIT 20;
```

Run `make reconcile` at the end of a live session and assert the findings you expect
(`estimated_usage` only where B7 applies, no `orphaned_reservation`, no `missing_usage`).

## 7. Cost and safety controls

Layer all of these; each one alone is insufficient.

| Control                          | How                                                                                                                  | Effect                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Dedicated provider keys          | Separate project/workspace keys used only for Tollgate testing, with the vendor's own spend cap set (e.g. \$5/month) | Hard ceiling Tollgate cannot exceed even if misconfigured   |
| Org budget with `hardStop: true` | Section 4, step 5                                                                                                    | Admission refuses before egress (`metering.ts:36-64`)       |
| Public price ≥ provider price    | Section 4, step 3                                                                                                    | Makes the budget a true spend cap (B14)                     |
| `default_max_output_tokens = 64` | Section 4, step 3                                                                                                    | Every call is bounded; `max_tokens` is always injected (B5) |
| `rpmLimit` / `tpmLimit` low      | Section 4, step 5                                                                                                    | Caps burst spend and protects vendor quota                  |
| One binding per live model       | Section 4, step 3                                                                                                    | No silent double-spend on failover (B10)                    |
| Separate live org                | Use the `Sandbox` org or create one; never share with mock traffic                                                   | Keeps live ledger rows isolated and reconciliation legible  |
| `prompt_logging = 'none'`        | Default (`001_initial.sql:15`)                                                                                       | Prompts are not persisted                                   |
| Short prompts, `max_tokens: 16`  | Test fixtures                                                                                                        | An entire L1+L2 pass is fractions of a cent                 |
| No live keys in CI               | Keep `.github/workflows/ci.yml` unchanged                                                                            | Fork PRs can never reach a provider                         |

If a live job is ever wanted in CI, make it a separate `workflow_dispatch`-only workflow bound to
a protected GitHub Environment with required reviewers, never `on: [push, pull_request]`, and keep
`AGENTS.md`'s guarantee intact by leaving the default job hermetic.

## 8. Secret-handling checklist

The repository already gives you most of this; the remainder is on the operator.

Already guaranteed by the code:

- provider credentials are accepted only through the authenticated control plane, sealed with a
  per-credential AES-256-GCM data key wrapped by the KEK, and stored as ciphertext + auth
  metadata + a one-way fingerprint (`crypto.ts:58-98`, `006_provider_credentials.sql`);
- AAD binds each ciphertext to `${orgId}:${providerId}`, so a credential row cannot be replayed
  into another org;
- plaintext is never cached, never logged, never returned by any endpoint, and never present in
  the catalog payload written to Redis;
- `authorization` and `x-api-key` request headers are redacted in logs, as are `*.messages`,
  `*.prompt`, and `*.plaintext`.

Operator responsibilities:

- generate a unique `PROVIDER_CREDENTIAL_KEK` per environment; never reuse the development one;
- close the `.dockerignore` gap (B13) before any `.env` holds a real key;
- never `echo`/`jq` a provider key in a shell that is being logged, and never let a test print
  one — assert on the fingerprint (`secretFingerprint`, first 16 hex of SHA-256) instead;
- rotate the provider key at the vendor after any live-testing session that touched a shared
  machine; `PUT /admin/provider-credentials/:providerId` makes rotation a single idempotent call
  with an audit record;
- remember that `KEY_PEPPER` in Compose is the documented development value — a production
  process refuses to start with it, but a live-key test stack is still a machine holding real
  credentials, so treat it accordingly.

## 9. Recommended repository changes to make this first-class

Ordered; each is small and independently shippable. `AGENTS.md`'s "one milestone per checkpoint,
money-path work is test-first" applies, and the default suite must stay hermetic.

- **C1 — `packages/db/src/seed-live.ts`.** Additive (no `TRUNCATE`), inserts the section-4
  catalog from env (`LIVE_OPENAI_MODEL`, `LIVE_ANTHROPIC_MODEL`, prices), creates a dedicated
  org/team/key/budget/routing-policy, and prints the key once. Acceptance: running it twice is
  idempotent and leaves the mock catalog untouched.
- **C2 — `.dockerignore` hardening.** Add `.env`, `.env.*`, `*.pem`, `*.key`. One line of diff,
  removes a real exfiltration path.
- **C3 — Parameter mapping for reasoning-family models.** Map `max_tokens` →
  `max_completion_tokens` for bindings that need it (a per-binding flag or a `kind` variant beats
  string-matching model names). Acceptance: a unit test asserting the translated body per
  binding, plus a documented note in the README's compatibility-leaks section.
- **C4 — Surface Anthropic mid-stream errors.** Translate an Anthropic `error` event into an
  OpenAI-shaped error chunk so `handleStream` marks the request `failed`. Test-first with a
  fixture stream; this is a money-path behaviour change and needs an asserting test and a README
  note.
- **C5 — Live-aware reconciliation input.** Let `reconcile-once.ts` take an invoice from a file
  or from recorded `usage_events.provider_raw` when `MOCK_PROVIDER_URL` is not reachable, instead
  of silently degrading to internal-invariants-only.
- **C6 — `tests/live/` suite + `pnpm test:live`.** Gated on `RUN_LIVE_PROVIDER=1`, implementing
  L1–L3. Must be excluded from `pnpm test` (vitest `include` already scopes to `tests/**/*.test.ts`,
  so gate inside the file the way the integration suites do).
- **C7 — Config for live runs.** Document (or default) higher `TTFT_TIMEOUT_MS` /
  `TOTAL_STREAM_TIMEOUT_MS` for real providers, and consider splitting the non-streaming deadline
  from the TTFT deadline so B4 stops conflating them.
- **C8 — README/ADR update.** The README currently states "No test or CI job uses an external
  provider key." That stays true; add a short pointer to this document so the BYOK path is
  discoverable, and record the L0 fixture-capture convention.

## 10. What was verified in this session, and what was not

Verified by execution in this checkout:

- `pnpm test:unit` — 18 tests, 7 files, green, no network or credentials;
- `providerRequest` output for `kind: 'openai'` and `kind: 'anthropic'` against real base URLs,
  including credential header selection, `anthropic-version`, system hoisting, tool-schema
  rewriting, and the dropping of `temperature`/`stream_options` on the Anthropic path;
- `normalizeProviderResponse` over a realistic Anthropic SSE stream (happy path and mid-stream
  `error`), confirming B7;
- the URL an `anthropic`-kind binding would use for `/v1/embeddings`, confirming B8;
- that an abort timer shorter than a buffered upstream's latency aborts before response headers,
  confirming B4's mechanism.

Not verified (no credentials and no Docker in this environment): any actual call to
`api.openai.com` or `api.anthropic.com`; end-to-end reserve→settle→reconcile against real token
counts; and current published per-token prices for either vendor. Confirm prices and OpenAI
parameter requirements against vendor documentation before the first live run.
