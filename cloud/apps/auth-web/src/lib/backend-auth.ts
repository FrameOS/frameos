import { and, eq, gt, isNull, or } from "drizzle-orm";
import { createDb, linkedClients } from "@frameos-cloud/db";
import { hashSecret } from "./secrets";

export async function authenticateLinkedClient(
  db: ReturnType<typeof createDb>,
  authorizationHeader: string | null,
) {
  const token = authorizationHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) {
    return undefined;
  }

  const tokenHash = hashSecret(token);
  const [linkedClient] = await db
    .select()
    .from(linkedClients)
    .where(
      and(
        or(
          eq(linkedClients.tokenReference, tokenHash),
          // After rotation the previous token stays valid for a short grace
          // window so a backend that never received the rotation response is
          // not locked out.
          and(
            eq(linkedClients.previousTokenReference, tokenHash),
            gt(linkedClients.previousTokenExpiresAt, new Date()),
          ),
        ),
        isNull(linkedClients.revokedAt),
      ),
    )
    .limit(1);

  if (!linkedClient) {
    return undefined;
  }

  const authenticatedWithPreviousToken =
    linkedClient.tokenReference !== tokenHash;

  // First use of the new token proves the backend received it; retire the
  // previous token immediately instead of letting the grace window run out.
  if (
    !authenticatedWithPreviousToken &&
    linkedClient.previousTokenReference
  ) {
    await db
      .update(linkedClients)
      .set({
        previousTokenExpiresAt: null,
        previousTokenReference: null,
        updatedAt: new Date(),
      })
      .where(eq(linkedClients.id, linkedClient.id));
  }

  // Which credential proved the request matters to exactly one caller:
  // rotate-token must not accept the retiring token, or whoever holds the old
  // one could rotate again inside the grace window and lock the real backend
  // out with its own freshly issued token.
  return { ...linkedClient, authenticatedWithPreviousToken };
}

// The scopes the user approved on the consent screen, as stored on the linked
// client at approval time. Feature endpoints must check these before serving
// a request (CLOUD-TODO principle: scopes are enforced on both sides).
export function linkedClientScopes(linkedClient: {
  providerClientMetadata: unknown;
}): string[] {
  const metadata = linkedClient.providerClientMetadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return [];
  }

  const scopes = (metadata as Record<string, unknown>).requestedScopes;
  if (!Array.isArray(scopes)) {
    return [];
  }

  return scopes.filter((scope): scope is string => typeof scope === "string");
}

export function linkedClientHasScope(
  linkedClient: { providerClientMetadata: unknown },
  scope: string,
) {
  return linkedClientScopes(linkedClient).includes(scope);
}
