# ADR 0002: Append-only accounting

**Status:** accepted

Usage and ledger facts cannot be updated or deleted, enforced by database triggers. Any correction workflow must append a reversal or adjustment rather than mutate an existing fact. The schema enforces reversal references, but the current implementation only reports reconciliation findings and does not yet insert corrections. This increases future query complexity but preserves an auditable history and prevents price changes from rewriting past charges.
