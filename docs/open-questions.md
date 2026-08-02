# Open questions

- Provider invoice APIs differ substantially; production adapters need provider-specific pagination and authentication.
- Hedged requests remain intentionally unimplemented until discarded-provider cost can be attributed fairly.
- A real user should determine whether stream idempotency warrants durable SSE chunk storage.
- Production provider credentials need an explicit ownership model, envelope-encryption key hierarchy,
  rotation contract, and redaction tests before authenticated upstreams are enabled.
- Tenant-owned provider catalogs and global operator-managed catalogs have different authorization and
  pricing semantics; the current implementation exposes only a global catalog.
