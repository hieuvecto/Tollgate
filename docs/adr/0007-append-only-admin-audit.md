# ADR 0007: Commit admin audit records with sensitive mutations

**Status:** accepted

Money- and access-affecting control-plane mutations append an actor audit record in the same PostgreSQL transaction as the change. The record identifies the organization, authenticated user, action, target, control-plane request, and a structured non-secret change summary. This covers API-key creation and revocation, provider-credential rotation and revocation, budget changes, and routing policy or quota changes.

An append-only trigger rejects updates and deletes. Tenant reads are always filtered by the authenticated organization and limited to owner, admin, and billing-viewer roles. Provider audit metadata contains only its one-way fingerprint and envelope key version; API-key metadata contains only the already-public display prefix. Credential plaintext, hashes, ciphertext, and wrapped data keys are excluded from the audit payload.

The table is an operational control audit, not an accounting ledger. It does not replace immutable usage facts, ledger entries, or an external database audit stream. Production environments that require independent custody should export inserts to their security archive.
