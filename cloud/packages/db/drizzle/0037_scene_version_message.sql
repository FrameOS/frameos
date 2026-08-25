-- A short "what changed" note the owner types when the web editor publishes a
-- new version, shown in the editor's version dropdown and the Versions dialog.
-- Nullable: every version published before this (and every zip upload from a
-- linked backend, which has nowhere to ask) simply has none.
ALTER TABLE "store_scene_versions"
  ADD COLUMN "message" text;
