-- Sharing frames with the people on a plan (cloud/docs/sharing.md).
--
-- An organization is the people on one account's plan: the account that
-- pays is its owner, and the plan's `people` entitlement is how many there
-- may be, the owner included. A project is a set of the owner's frames and
-- the members who may use them. A frame in no project is the owner's alone,
-- which is what every frame is before this migration, so nothing is
-- backfilled.
--
-- Nothing here moves a frame, a scene or a key to another account: a shared
-- frame stays the owner's (its quota, its service keys, its audit trail).
-- Access is worked out from these tables on every request
-- (apps/auth-web/src/lib/organizations.ts), so removing a row is the whole
-- revocation.

CREATE TABLE "organizations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
-- One organization per plan: an account owns at most one.
CREATE UNIQUE INDEX "organizations_owner_unique"
  ON "organizations" ("owner_account_id");

-- The people on the plan besides the owner. `role`: 'admin' manages people
-- and projects and may use every project's frames; 'member' uses the frames
-- of the projects it was added to. The order of (created_at, id) is the
-- order of the seats: when the plan shrinks, the members who joined last
-- are the ones without access.
CREATE TABLE "organization_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "role" text NOT NULL DEFAULT 'member' CHECK ("role" IN ('admin', 'member')),
  "invited_by_account_id" uuid REFERENCES "accounts"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "organization_members_org_account_unique"
  ON "organization_members" ("organization_id", "account_id");
CREATE INDEX "organization_members_account_idx"
  ON "organization_members" ("account_id");
CREATE INDEX "organization_members_invited_by_idx"
  ON "organization_members" ("invited_by_account_id")
  WHERE "invited_by_account_id" IS NOT NULL;

CREATE TABLE "projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "projects_organization_idx" ON "projects" ("organization_id");

-- Which members may use a project's frames. An admin needs no row.
CREATE TABLE "project_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "member_id" uuid NOT NULL REFERENCES "organization_members"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "project_members_project_member_unique"
  ON "project_members" ("project_id", "member_id");
CREATE INDEX "project_members_member_idx" ON "project_members" ("member_id");

-- An invitation is a link mailed to an address, hashed at rest like every
-- other token. It holds a seat until it is accepted, revoked or expired, so
-- a plan cannot be oversold by inviting faster than people accept.
-- `project_ids` are the projects the person joins on accepting; a project
-- deleted meanwhile is skipped.
CREATE TABLE "organization_invitations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "role" text NOT NULL DEFAULT 'member' CHECK ("role" IN ('admin', 'member')),
  "project_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "token_hash" text NOT NULL,
  "invited_by_account_id" uuid REFERENCES "accounts"("id") ON DELETE SET NULL,
  "expires_at" timestamptz NOT NULL,
  "accepted_at" timestamptz,
  "accepted_by_account_id" uuid REFERENCES "accounts"("id") ON DELETE SET NULL,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "organization_invitations_token_hash_unique"
  ON "organization_invitations" ("token_hash");
CREATE INDEX "organization_invitations_organization_idx"
  ON "organization_invitations" ("organization_id");
CREATE INDEX "organization_invitations_invited_by_idx"
  ON "organization_invitations" ("invited_by_account_id")
  WHERE "invited_by_account_id" IS NOT NULL;
CREATE INDEX "organization_invitations_accepted_by_idx"
  ON "organization_invitations" ("accepted_by_account_id")
  WHERE "accepted_by_account_id" IS NOT NULL;

-- The project a frame is shared through. NULL: the owner's alone. Deleting
-- a project takes its frames back to that.
ALTER TABLE "frames"
  ADD COLUMN "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL;
CREATE INDEX "frames_project_idx" ON "frames" ("project_id")
  WHERE "project_id" IS NOT NULL;

-- Who made a scene, when that is not the account it belongs to: a scene a
-- member builds on a shared frame is the frame owner's (its storage, its
-- lifetime), and this is how the member may install it before any frame
-- holds it. NULL: the owner made it.
ALTER TABLE "store_scenes"
  ADD COLUMN "created_by_account_id" uuid REFERENCES "accounts"("id") ON DELETE SET NULL;
CREATE INDEX "store_scenes_created_by_idx" ON "store_scenes" ("created_by_account_id")
  WHERE "created_by_account_id" IS NOT NULL;

-- The plans' people. A paid stop at $N a month is N people
-- (cloud/docs/accounting-todo.md §0.1); the rows "Sync plans" wrote before
-- this migration do not say so, and a row without the key reads as one
-- person. "Sync plans" writes the same number from the catalog from now on.
UPDATE "billing_plans"
   SET "entitlements" = "entitlements"
         || jsonb_build_object('people', ("price_micros" / 1000000)::int),
       "updated_at" = now()
 WHERE "code" ~ '^(private|business)-[0-9]+$'
   AND "price_micros" >= 1000000
   AND NOT ("entitlements" ? 'people');
