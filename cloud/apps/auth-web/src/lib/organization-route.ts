// The guard every /api/organization route starts with (cloud/docs/sharing.md
// "API"): rate limit, session, database, and for a change the origin check
// and a real sign-in.
//
// Changing who is on a plan is done by a person: an API token may read the
// organization and never change it, so a leaked token cannot invite its
// thief onto the owner's frames.

import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "./audit";
import { csrfResponse } from "./csrf";
import { jsonError, requireDatabase } from "./device-flow";
import { getAccountUrl } from "./env";
import type { ManageFailure, OrganizationRow } from "./organization-manage";
import { identityRateLimitResponse, rateLimitResponse } from "./rate-limit";
import { readSession } from "./session";

type Database = NonNullable<ReturnType<typeof requireDatabase>["db"]>;

export type OrganizationRequestContext = {
  accountId: string;
  actor: { accountId: string; providerSubject: string };
  db: Database;
  response?: undefined;
};

const readLimit = { limit: 240, windowMs: 15 * 60 * 1000 };
const writeLimit = { limit: 120, windowMs: 15 * 60 * 1000 };

export async function organizationRequestContext(
  request: NextRequest,
  { change }: { change: boolean },
): Promise<OrganizationRequestContext | { response: NextResponse }> {
  if (change) {
    const csrf = csrfResponse(request);
    if (csrf) {
      return { response: csrf };
    }
  }
  const limited = await rateLimitResponse(
    request,
    change ? "organization:write" : "organization:read",
    change ? writeLimit : readLimit,
  );
  if (limited) {
    return { response: limited };
  }
  const session = await readSession();
  if (!session?.accountId) {
    return { response: jsonError("login_required", 401) };
  }
  if (change && session.apiToken) {
    return { response: jsonError("session_required", 403) };
  }
  if (change) {
    // Per account as well as per address: the invitation route sends mail.
    const accountLimited = await identityRateLimitResponse(
      session.accountId,
      "organization:write",
      writeLimit,
    );
    if (accountLimited) {
      return { response: accountLimited };
    }
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return { response: response! };
  }
  return {
    accountId: session.accountId,
    actor: { accountId: session.accountId, providerSubject: session.providerSubject },
    db,
  };
}

/** Where an invitation link lands: the people page, which shows the offer. */
export function invitationUrl(token: string) {
  const url = new URL(getAccountUrl("/account/people"));
  url.searchParams.set("invite", token);
  return url.toString();
}

export function manageFailureResponse(failure: ManageFailure) {
  return jsonError(failure.error, failure.status, failure.detail);
}

/**
 * The organization's trail is its owner's: every change is recorded on the
 * owner's account, with the person who made it as the actor.
 */
export async function recordOrganizationAudit(
  context: OrganizationRequestContext,
  organization: OrganizationRow,
  eventType: string,
  metadata?: Record<string, unknown>,
) {
  await recordAuditEvent(context.db, {
    accountId: organization.ownerAccountId,
    actor: context.actor,
    eventType,
    metadata: { organization: organization.name, ...(metadata ?? {}) },
    target: { organizationId: organization.id },
  });
}
