import { eq } from "drizzle-orm";
import { accounts } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, readJsonObject } from "../../../../src/lib/device-flow";
import { sendOrganizationInvitationEmail } from "../../../../src/lib/email";
import { reportError } from "../../../../src/lib/log";
import {
  cleanEmail,
  cleanIdList,
  cleanRole,
  createInvitation,
  managedOrganization,
  maxProjectsPerOrganization,
  revokeInvitation,
} from "../../../../src/lib/organization-manage";
import {
  invitationUrl,
  manageFailureResponse,
  organizationRequestContext,
  recordOrganizationAudit,
} from "../../../../src/lib/organization-route";
import { identityRateLimitResponse } from "../../../../src/lib/rate-limit";

export const runtime = "nodejs";

// A day's invitations for one account. The route mails an address its caller
// chose, so it is bounded well below what a plan's seats would allow by
// revoking and inviting again.
const invitationsPerDay = { limit: 60, windowMs: 24 * 60 * 60 * 1000 };

// Invite someone onto the plan: {email, role?, project_ids?, organization_id?}.
// The invitation takes a seat until it is accepted, revoked or expired
// (seven days), and the address gets one mail with the link. The link is
// also in the answer, once, for the owner to pass on themselves.
export async function POST(request: NextRequest) {
  const context = await organizationRequestContext(request, { change: true });
  if (context.response) {
    return context.response;
  }
  const { accountId, db } = context;
  const body = await readJsonObject(request);
  const email = cleanEmail(body.email);
  if (!email) {
    return jsonError("invalid_email", 400);
  }
  const role = body.role === undefined ? "member" : cleanRole(body.role);
  if (!role) {
    return jsonError("invalid_role", 400);
  }
  const projectIds =
    body.project_ids === undefined ? [] : cleanIdList(body.project_ids, maxProjectsPerOrganization);
  if (!projectIds) {
    return jsonError("invalid_project", 400);
  }
  const managed = await managedOrganization(
    db,
    accountId,
    typeof body.organization_id === "string" ? body.organization_id : null,
  );
  if (!managed) {
    return jsonError("organization_not_found", 404);
  }
  // Only the owner makes an admin: an admin could otherwise hand out the
  // role that manages the owner's plan.
  if (role === "admin" && managed.role !== "owner") {
    return jsonError("owner_only", 403);
  }
  const limited = await identityRateLimitResponse(accountId, "organization:invite", invitationsPerDay);
  if (limited) {
    return limited;
  }

  const created = await createInvitation(db, {
    email,
    invitedByAccountId: accountId,
    organization: managed.organization,
    projectIds,
    role,
  });
  if (!created.ok) {
    return manageFailureResponse(created);
  }
  const url = invitationUrl(created.token);
  const [inviter] = await db
    .select({ displayName: accounts.displayName, primaryEmail: accounts.primaryEmail })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  try {
    await sendOrganizationInvitationEmail(email, {
      inviter: inviter?.displayName?.trim() || inviter?.primaryEmail || "Someone",
      organization: managed.organization.name,
      url,
    });
  } catch (error) {
    // An invitation nobody was told about would hold a seat for a week.
    reportError("organization.invitation_email_failed", error, {
      organizationId: managed.organization.id,
    });
    await revokeInvitation(db, created.invitation.id);
    return jsonError("email_failed", 502);
  }
  await recordOrganizationAudit(context, managed.organization, "organization.member_invited", {
    email,
    role,
  });
  return NextResponse.json({ invitation: created.invitation, url }, { status: 201 });
}
