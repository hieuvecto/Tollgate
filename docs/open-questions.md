# Open questions

- Provider invoice APIs differ substantially; production adapters need provider-specific pagination and authentication.
- Hedged requests remain intentionally unimplemented until discarded-provider cost can be attributed fairly.
- A real user should determine whether stream idempotency warrants durable SSE chunk storage.
