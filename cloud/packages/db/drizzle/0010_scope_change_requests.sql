-- Feature (scope) changes for an existing linked client. Instead of
-- disconnecting and relinking, a backend asks for a new scope set through
-- POST /api/backends/scopes; additions create a device_authorization_request
-- pointing at the client it upgrades. Approval rewrites the client's granted
-- scopes in place — the link token never changes.
ALTER TABLE "device_authorization_requests"
  ADD COLUMN "upgrade_linked_client_id" uuid
  REFERENCES "linked_clients"("id") ON DELETE CASCADE;

CREATE INDEX device_authorization_requests_upgrade_linked_client_idx
  ON device_authorization_requests (upgrade_linked_client_id);
