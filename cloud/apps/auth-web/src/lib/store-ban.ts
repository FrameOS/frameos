import { eq } from "drizzle-orm";
import { accounts, type createDb } from "@frameos-cloud/db";
import { jsonError } from "./device-flow";

// A publisher an admin banned from the store (accounts.store_banned_at,
// /admin/scenes). The ban is one rule, asked by every door:
//
// - no new scene (publish, upload, create, fork);
// - no change to a scene that is public: no new version, no listing or
//   image edit, and nothing goes public;
// - their public scenes are in no listing (the store front, the frames'
//   listing, the repository index, the publisher page, the AI's search).
//
// What stays open is what a banned publisher needs to step back: making a
// scene private and deleting it, and working on their own private scenes.
type Database = Pick<ReturnType<typeof createDb>, "select">;

export async function storePublisherBanned(db: Database, accountId: string) {
  const [publisher] = await db
    .select({ storeBannedAt: accounts.storeBannedAt })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return Boolean(publisher?.storeBannedAt);
}

/** The refusal to send, or undefined when the account is not banned. */
export async function storeBanRefusal(db: Database, accountId: string) {
  return (await storePublisherBanned(db, accountId))
    ? jsonError("store_banned", 403)
    : undefined;
}
