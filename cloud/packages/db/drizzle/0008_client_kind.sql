-- Distinguish backends from frames that link directly (CLOUD-TODO Phase 0).
-- The kind is derived at device/start time: an explicit client_kind in the
-- request body, else "frame" when frame:link is among the requested scopes.
ALTER TABLE "device_authorization_requests"
  ADD COLUMN "client_kind" text DEFAULT 'backend' NOT NULL;

ALTER TABLE "linked_clients"
  ADD COLUMN "client_kind" text DEFAULT 'backend' NOT NULL;
