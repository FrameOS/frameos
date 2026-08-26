import { timingSafeEqual } from "node:crypto";
import type { createDb } from "@frameos-cloud/db";
import { authenticateLinkedClient, linkedClientHasScope } from "./backend-auth";
import { readSession } from "./session";
import { storePublishScope } from "./store";
import { accountIsSuperadmin } from "./superadmin";

// A private scene is reachable by its owner two ways: the owner's web session
// (browsing the store signed in) or a linked client of the owner's account
// with the store scope (the frameos backend fetching "My cloud drive" zips,
// images, and scene pages on the user's behalf). Takes the authorization
// header value so both route handlers and server components can call it.
export async function canAccessPrivateScene(
  db: ReturnType<typeof createDb>,
  authorizationHeader: string | null,
  ownerAccountId: string,
) {
  const session = await readSession();
  if (session?.accountId === ownerAccountId) {
    return true;
  }

  const linkedClient = await authenticateLinkedClient(db, authorizationHeader);
  return Boolean(
    linkedClient &&
    linkedClient.accountId === ownerAccountId &&
    linkedClientHasScope(linkedClient, storePublishScope),
  );
}

// Third way in: the scene's high-entropy share token, appended to the URL as
// ?share={token}. Grants READ access only (page, zip, scenes.json, images),
// so a private scene's "Install on your FrameOS" link works for anyone the
// owner shares it with. Timing-safe compare; pulled scenes stay blocked by
// the callers' status checks regardless of the token.
export function shareTokenGrantsAccess(
  sceneShareToken: string | null | undefined,
  providedToken: string | string[] | null | undefined,
) {
  const provided = Array.isArray(providedToken)
    ? providedToken[0]
    : providedToken;
  if (!sceneShareToken || !provided) {
    return false;
  }
  const expected = Buffer.from(sceneShareToken);
  const actual = Buffer.from(provided);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// A pulled scene is gone for the public, for share-token holders and for
// linked frames alike — but its owner and moderators still open its page
// (the store page itself lets them through), so the reads that page is made
// of (images, scenes.json, the zip) follow the same rule: the owner's or a
// superadmin's web session, nothing else. Without this the owner sees a
// page of broken images and a "Could not load the scene (410)".
export async function canViewPulledScene(ownerAccountId: string) {
  const session = await readSession();
  if (!session?.accountId) {
    return false;
  }
  return (
    session.accountId === ownerAccountId ||
    (await accountIsSuperadmin(session.accountId))
  );
}
