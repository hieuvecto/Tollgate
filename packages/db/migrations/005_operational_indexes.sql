ALTER TABLE outbox ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX outbox_ready_for_processing
  ON outbox(next_attempt_at, created_at)
  WHERE processed_at IS NULL;
CREATE INDEX ledger_entries_org_created_at ON ledger_entries(org_id, created_at);
CREATE INDEX requests_created_at ON requests(created_at);
CREATE INDEX reservations_active_created_at
  ON reservations(status, created_at)
  WHERE status IN ('pending', 'reserved');
