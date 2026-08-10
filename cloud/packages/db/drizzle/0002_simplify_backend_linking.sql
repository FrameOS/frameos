DROP TABLE IF EXISTS billing_subscriptions CASCADE;
DROP TABLE IF EXISTS billing_customers CASCADE;
DROP TABLE IF EXISTS cloud_entitlements CASCADE;
DROP TABLE IF EXISTS cloud_frames CASCADE;
DROP TABLE IF EXISTS hosted_backends CASCADE;
DROP TABLE IF EXISTS cloud_invitations CASCADE;
DROP TABLE IF EXISTS cloud_memberships CASCADE;

ALTER TABLE linked_clients DROP COLUMN IF EXISTS client_type;
ALTER TABLE linked_clients DROP COLUMN IF EXISTS organization_id;
ALTER TABLE linked_clients DROP COLUMN IF EXISTS project_id;
ALTER TABLE linked_clients DROP COLUMN IF EXISTS user_provided_name;

CREATE UNIQUE INDEX IF NOT EXISTS linked_clients_token_reference_unique
  ON linked_clients(token_reference);

DELETE FROM connected_backends
WHERE linked_client_id IS NULL;

DELETE FROM connected_backends stale
USING connected_backends kept
WHERE stale.linked_client_id = kept.linked_client_id
  AND stale.ctid < kept.ctid;

ALTER TABLE connected_backends DROP COLUMN IF EXISTS backend_type;
ALTER TABLE connected_backends DROP COLUMN IF EXISTS backend_instance_id;
ALTER TABLE connected_backends DROP COLUMN IF EXISTS organization_id;
ALTER TABLE connected_backends DROP COLUMN IF EXISTS project_id;
ALTER TABLE connected_backends ALTER COLUMN linked_client_id SET NOT NULL;
ALTER TABLE connected_backends
  DROP CONSTRAINT IF EXISTS connected_backends_linked_client_id_fkey;
ALTER TABLE connected_backends
  ADD CONSTRAINT connected_backends_linked_client_id_fkey
  FOREIGN KEY (linked_client_id) REFERENCES linked_clients(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS connected_backends_linked_client_unique
  ON connected_backends(linked_client_id);

ALTER TABLE device_authorization_requests DROP COLUMN IF EXISTS client_type;
ALTER TABLE device_authorization_requests DROP COLUMN IF EXISTS completed_at;
ALTER TABLE device_authorization_requests DROP COLUMN IF EXISTS organization_id;
ALTER TABLE device_authorization_requests DROP COLUMN IF EXISTS project_id;

DROP TABLE IF EXISTS cloud_projects CASCADE;
DROP TABLE IF EXISTS cloud_organizations CASCADE;

DROP TYPE IF EXISTS backend_type;
DROP TYPE IF EXISTS cloud_role;
DROP TYPE IF EXISTS hosted_backend_status;
DROP TYPE IF EXISTS invitation_status;
DROP TYPE IF EXISTS linked_client_type;
