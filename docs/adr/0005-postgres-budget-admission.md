# ADR 0005: Keep budget admission authoritative in PostgreSQL

**Status:** accepted

Budget admission locks all applicable organization and team budget rows and evaluates ledger spend plus pending and active reservations for the request's UTC day or month. Request creation time pins the accounting period. Request creation, reservation insertion, budget evaluation, and the admitted or rejected terminal state commit in one PostgreSQL transaction, so other sessions never observe a pending reservation between two admission transactions. This removes Redis-to-ledger drift, makes process restarts and Redis flushes irrelevant to spend enforcement, and serializes concurrent reservations that share a hard limit.

The cost is another PostgreSQL operation on the request path. Redis remains the atomic fixed-window RPM/TPM store, but it is not a money source of truth. Admission fails closed when PostgreSQL is unavailable; `fail_open` applies only to spooling final usage after a provider has already been invoked.
