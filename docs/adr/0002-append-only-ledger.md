# ADR 0002: Append-only accounting

**Status:** accepted

Usage and ledger facts cannot be updated or deleted, enforced by database triggers. Corrections append reversals referencing the original entry. This increases query complexity but preserves an auditable history and prevents price changes from rewriting past charges.
