CREATE TABLE admin_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs,
  actor_user_id uuid NOT NULL REFERENCES users,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  changes jsonb NOT NULL,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX admin_audit_log_org_created_at ON admin_audit_log(org_id, created_at DESC);
CREATE TRIGGER admin_audit_log_append_only
  BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
