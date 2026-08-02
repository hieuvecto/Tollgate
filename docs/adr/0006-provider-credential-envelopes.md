# ADR 0006: Envelope-encrypt organization provider credentials

**Status:** accepted

Provider credentials belong to an organization and provider pair. The control plane creates a random 256-bit data-encryption key for every credential, encrypts the credential with AES-256-GCM, and wraps the data key with a deployment key-encryption key. Organization and provider IDs are authenticated as additional data, preventing ciphertext from being moved across tenant or provider contexts. Rotation replaces the active envelope; revocation preserves ciphertext but removes it from gateway selection.

The database stores only ciphertext, nonces, authentication tags, a key version, and a one-way fingerprint. The gateway decrypts an active credential only in process memory and strips it before writing catalog fallback data to Redis. If encrypted credentials exist but the deployment key is unavailable, the gateway fails closed for those bindings instead of sending an unauthenticated upstream request.

The deployment key is currently supplied as a base64-encoded 32-byte `PROVIDER_CREDENTIAL_KEK`. Integrating a managed KMS and automating key-version rewrapping are intentionally left to the production environment because access policy and recovery ownership are deployment-specific.
