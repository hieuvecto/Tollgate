# The money path

Tollgate treats usage and money as accounting facts, not mutable request metadata. A request reserves a conservative maximum before provider admission. Its final provider usage—or an explicitly marked estimate—is appended to the outbox, settled exactly once into `usage_events` and `ledger_entries`, then releases the unused reservation.

## Invariants

1. Money is integer micro-USD in PostgreSQL `bigint` and TypeScript `bigint`; JSON uses decimal strings.
2. Usage and ledger rows are append-only. PostgreSQL triggers reject updates and deletes.
3. Every charge references its request and the exact price version selected at request start.
4. Every reservation becomes settled or released; the reaper exposes overdue reservations.
5. Outbox dedupe keys and unique charge constraints make replay safe.
6. Within the configured retention window, one organization/idempotency key invokes and charges at most once.
7. Plaintext API keys never enter storage, logs, metrics, errors, or fixtures.
8. Prompt logging defaults to `none`.
9. Every request becomes terminal or reconciliation reports it.

## Reserve and settle

For hard budgets, Tollgate estimates prompt tokens and adds the requested output maximum. If the caller omits `max_tokens`, the configured model cap is inserted into the upstream request. PostgreSQL locks every applicable organization and team budget row, then compares current-period ledger entries plus pending and active reservations with each limit. Day and month periods are UTC calendar periods pinned to request creation time. The ledger and reservations are authoritative, so Redis flushes and settlement crash windows cannot reset enforcement. Provider tokenizer drift can still make actual cost exceed the reservation; no fixed tolerance is claimed. Soft budgets admit traffic and remain visible in spend reports.

RPM and TPM use atomic Redis admission. A rejected admission does not mutate any scope's counters. TPM debits an estimate before the call and returns the fixed-window bucket identifier; authoritative usage corrects that same bucket even when the request completes after a minute boundary. A post-flight Redis failure leaves the conservative estimate in place until the bucket expires rather than changing an already-completed provider response.

## Idempotency retention

Only successful non-streaming requests carrying `Idempotency-Key` store a replay body. The default retention window is 24 hours and is configurable with `IDEMPOTENCY_RETENTION_HOURS`. After a terminal request expires, the worker clears its key and replay body so the key can begin a new request; usage events, ledger entries, and request accounting metadata remain intact. In-progress keys do not expire automatically and remain reconciliation-visible.

## Failure behavior

Admission rejects traffic if it cannot create durable request and reservation state, regardless of finalization policy. After provider invocation, an explicitly configured `fail_open` organization may spool final usage into Redis AOF when PostgreSQL finalization fails. A client disconnect aborts the upstream request; observed tokens become an estimated usage fact if the provider never emitted final usage.

The worker never edits an accounting fact. The schema requires future corrections to use new reversal or adjustment entries. No correction insertion or approval workflow is implemented yet: reconciliation records findings and leaves `proposed_adjustments` empty.
