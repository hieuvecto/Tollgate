CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE metering_failure_policy AS ENUM ('fail_open', 'fail_closed');
CREATE TYPE member_role AS ENUM ('owner', 'admin', 'member', 'billing_viewer');
CREATE TYPE request_status AS ENUM ('in_progress', 'succeeded', 'failed', 'client_aborted');
CREATE TYPE usage_source AS ENUM ('provider', 'estimated');
CREATE TYPE ledger_kind AS ENUM ('charge', 'reversal', 'adjustment', 'credit');
CREATE TYPE reservation_status AS ENUM ('pending', 'reserved', 'settled', 'released');
CREATE TYPE routing_strategy AS ENUM ('cheapest', 'lowest_latency', 'weighted', 'failover_order');

CREATE TABLE orgs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  on_metering_failure metering_failure_policy NOT NULL DEFAULT 'fail_closed',
  prompt_logging text NOT NULL DEFAULT 'none' CHECK (prompt_logging IN ('none','metadata_only','full')),
  prompt_retention_days integer, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE teams (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES orgs, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES orgs, email text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(org_id,email));
CREATE TABLE memberships (user_id uuid NOT NULL REFERENCES users, team_id uuid NOT NULL REFERENCES teams, role member_role NOT NULL, PRIMARY KEY(user_id,team_id));
CREATE TABLE control_plane_tokens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users, token_prefix text NOT NULL UNIQUE, token_hash text NOT NULL, status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')), created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz);
CREATE TABLE api_keys (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES orgs, team_id uuid REFERENCES teams, name text NOT NULL, key_prefix text NOT NULL UNIQUE, key_hash text NOT NULL, scopes jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')), last_used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz);

CREATE TABLE providers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE, kind text NOT NULL CHECK(kind IN ('openai','anthropic','openai_compatible','mock')), base_url text NOT NULL, enabled boolean NOT NULL DEFAULT true);
CREATE TABLE models (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), public_name text NOT NULL UNIQUE, context_window integer NOT NULL CHECK(context_window > 0), default_max_output_tokens integer NOT NULL DEFAULT 512);
CREATE TABLE provider_bindings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), model_id uuid NOT NULL REFERENCES models, provider_id uuid NOT NULL REFERENCES providers, provider_model_name text NOT NULL, priority integer NOT NULL DEFAULT 0, weight integer NOT NULL DEFAULT 100, input_cost_per_mtok bigint NOT NULL DEFAULT 0, output_cost_per_mtok bigint NOT NULL DEFAULT 0, enabled boolean NOT NULL DEFAULT true, UNIQUE(model_id,provider_id));
CREATE TABLE provider_health (binding_id uuid PRIMARY KEY REFERENCES provider_bindings, ewma_ttft_ms numeric, ewma_error_rate numeric NOT NULL DEFAULT 0, consecutive_failures integer NOT NULL DEFAULT 0, breaker_state text NOT NULL DEFAULT 'closed' CHECK(breaker_state IN ('closed','open','half_open')), opened_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE routing_policies (org_id uuid PRIMARY KEY REFERENCES orgs, strategy routing_strategy NOT NULL DEFAULT 'failover_order', rpm_limit integer NOT NULL DEFAULT 60, tpm_limit integer NOT NULL DEFAULT 100000);
CREATE TABLE model_pricing (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), model_id uuid NOT NULL REFERENCES models, input_per_mtok bigint NOT NULL CHECK(input_per_mtok >= 0), output_per_mtok bigint NOT NULL CHECK(output_per_mtok >= 0), cached_input_per_mtok bigint NOT NULL CHECK(cached_input_per_mtok >= 0), effective_from timestamptz NOT NULL, effective_to timestamptz, CHECK(effective_to IS NULL OR effective_to > effective_from), EXCLUDE USING gist (model_id WITH =, tstzrange(effective_from, effective_to, '[)') WITH &&));

CREATE TABLE budgets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES orgs, team_id uuid REFERENCES teams, period text NOT NULL CHECK(period IN ('day','month')), limit_micros bigint NOT NULL CHECK(limit_micros >= 0), hard_stop boolean NOT NULL DEFAULT true, UNIQUE NULLS NOT DISTINCT(org_id,team_id,period));
CREATE TABLE requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES orgs, team_id uuid REFERENCES teams, api_key_id uuid NOT NULL REFERENCES api_keys, model_id uuid NOT NULL REFERENCES models, pricing_id uuid NOT NULL REFERENCES model_pricing, idempotency_key text, idempotency_response jsonb, status request_status NOT NULL DEFAULT 'in_progress', stream boolean NOT NULL DEFAULT false, provider_id_used uuid REFERENCES providers, attempt_count integer NOT NULL DEFAULT 0, reservation_id uuid, first_token_ms integer, total_ms integer, created_at timestamptz NOT NULL DEFAULT now(), finalized_at timestamptz);
CREATE UNIQUE INDEX requests_org_idempotency_key ON requests(org_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE reservations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES orgs, team_id uuid REFERENCES teams, request_id uuid NOT NULL UNIQUE REFERENCES requests, amount_micros bigint NOT NULL CHECK(amount_micros >= 0), status reservation_status NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz);
ALTER TABLE requests ADD CONSTRAINT requests_reservation_fk FOREIGN KEY(reservation_id) REFERENCES reservations(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE outbox (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL, payload jsonb NOT NULL, dedupe_key text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, attempts integer NOT NULL DEFAULT 0, last_error text);
CREATE TABLE usage_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL UNIQUE REFERENCES requests, org_id uuid NOT NULL REFERENCES orgs, team_id uuid REFERENCES teams, api_key_id uuid NOT NULL REFERENCES api_keys, model_id uuid NOT NULL REFERENCES models, input_tokens integer NOT NULL CHECK(input_tokens >= 0), output_tokens integer NOT NULL CHECK(output_tokens >= 0), cached_input_tokens integer NOT NULL DEFAULT 0 CHECK(cached_input_tokens >= 0), source usage_source NOT NULL, provider_raw jsonb, recorded_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ledger_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES orgs, team_id uuid REFERENCES teams, request_id uuid NOT NULL REFERENCES requests, amount_micros bigint NOT NULL, currency text NOT NULL DEFAULT 'USD', kind ledger_kind NOT NULL, reverses_id uuid REFERENCES ledger_entries, pricing_id uuid NOT NULL REFERENCES model_pricing, created_at timestamptz NOT NULL DEFAULT now(), CHECK((kind = 'reversal') = (reverses_id IS NOT NULL)));
CREATE UNIQUE INDEX one_charge_per_request ON ledger_entries(request_id) WHERE kind = 'charge';
CREATE UNIQUE INDEX one_reversal_per_entry ON ledger_entries(reverses_id) WHERE reverses_id IS NOT NULL;
CREATE TABLE reconciliation_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), period_start timestamptz NOT NULL, period_end timestamptz NOT NULL, findings jsonb NOT NULL, proposed_adjustments jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now());

CREATE FUNCTION reject_append_only_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER usage_events_append_only BEFORE UPDATE OR DELETE ON usage_events FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
