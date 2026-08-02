ALTER TABLE requests ADD COLUMN idempotency_expires_at timestamptz;
UPDATE requests
SET idempotency_expires_at = created_at + interval '24 hours'
WHERE idempotency_key IS NOT NULL;
CREATE INDEX requests_idempotency_expiry
  ON requests(idempotency_expires_at)
  WHERE idempotency_expires_at IS NOT NULL;
