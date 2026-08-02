# Open questions

- Provider invoice APIs differ substantially; production adapters need provider-specific pagination and authentication.
- Hedged requests remain intentionally unimplemented until discarded-provider cost can be attributed fairly.
- A real user should determine whether stream idempotency warrants durable SSE chunk storage.
- Production provider credentials are organization-owned and envelope-encrypted. A production KMS adapter,
  automated key-version rewrapping, and customer-managed KEK hierarchy remain deployment decisions.
- Tenant-owned provider catalogs and global operator-managed catalogs have different authorization and
  pricing semantics; the current implementation exposes only a global catalog.
