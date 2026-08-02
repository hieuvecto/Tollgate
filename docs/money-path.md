# The money path

Tollgate treats usage and money as accounting facts, not mutable request metadata. A request reserves a conservative maximum before provider admission. Its final provider usage—or an explicitly marked estimate—is appended to the outbox, settled exactly once into `usage_events` and `ledger_entries`, then releases the unused reservation.

## Invariants

1. Money is integer micro-USD in PostgreSQL `bigint` and TypeScript `bigint`; JSON uses decimal strings.
2. Usage and ledger rows are append-only. PostgreSQL triggers reject updates and deletes.
3. Every charge references its request and the exact price version selected at request start.
4. Every reservation becomes settled or released; the reaper exposes overdue reservations.
5. Outbox dedupe keys and unique charge constraints make replay safe.
6. One organization/idempotency key invokes and charges at most once.
7. Plaintext API keys never enter storage, logs, metrics, errors, or fixtures.
8. Prompt logging defaults to `none`.
9. Every request becomes terminal or reconciliation reports it.

## Reserve and settle

For hard budgets, Tollgate estimates prompt tokens and adds the requested output maximum. If the caller omits `max_tokens`, the configured model cap is inserted into the upstream request. A single Redis Lua operation compares spent plus concurrent reservations with the limit. Provider tokenizer drift can make actual cost exceed a reservation; the supported hard-limit tolerance is 1% and reconciliation calls out larger discrepancies. Soft budgets admit traffic and report overage.

RPM and TPM use atomic Redis admission. A rejected admission does not mutate any scope's counters. TPM debits an estimate before the call and returns the fixed-window bucket identifier; authoritative usage corrects that same bucket even when the request completes after a minute boundary. A post-flight Redis failure leaves the conservative estimate in place until the bucket expires rather than changing an already-completed provider response.

## Failure behavior

The default `fail_closed` policy rejects traffic if it cannot create durable request/outbox state. An explicitly configured `fail_open` organization may spool final usage into Redis AOF when PostgreSQL finalization fails. A client disconnect aborts the upstream request; observed tokens become an estimated usage fact if the provider never emitted final usage.

The worker never edits an accounting fact. Corrections are new reversal or adjustment entries. Reconciliation proposes adjustments but never applies them automatically.
