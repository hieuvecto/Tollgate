CREATE TABLE provider_credentials (
  org_id uuid NOT NULL REFERENCES orgs,
  provider_id uuid NOT NULL REFERENCES providers,
  encrypted_secret bytea NOT NULL,
  secret_iv bytea NOT NULL,
  secret_tag bytea NOT NULL,
  wrapped_dek bytea NOT NULL,
  wrap_iv bytea NOT NULL,
  wrap_tag bytea NOT NULL,
  key_version integer NOT NULL,
  secret_fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY(org_id, provider_id)
);

CREATE INDEX provider_credentials_provider_active
  ON provider_credentials(provider_id, org_id)
  WHERE status = 'active';
