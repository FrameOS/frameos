import { and, eq, inArray } from "drizzle-orm";
import { organizationMembers, projects } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, readJsonObject } from "../../../../src/lib/device-flow";
import {
  acceptInvitation,
  invitationForToken,
} from "../../../../src/lib/organization-manage";
import { isUuid } from "../../../../src/lib/organizations";
import {
  manageFailureResponse,
  organizationRequestContext,
  recordOrganizationAudit,
} from "../../../../src/lib/organization-route";

export const runtime = "nodejs";

// An invitation link, opened: {token} says what it is for, {token, accept:
// true} joins. The token travels in the body, never in a path or a query of
// this API, so it is in no access log.
//
// The link is the proof. It was mailed to one address, but whoever holds it
// and is signed in may accept, with whichever account they use: people sign
// in with another address than the one their friend knows, and the people
// page shows the owner who joined.
export async function POST(request: NextRequest) {
  const context = await organizationRequestContext(request, { change: true });
  if (context.response) {
    return context.response;
  }
  const { accountId, db } = context;
  const body = await readJsonObject(request);
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) {
    return jsonError("invitation_not_found", 404);
  }

  if (body.accept !== true) {
    const found = await invitationForToken(db, token);
    if (!found) {
      return jsonError("invitation_not_found", 404);
    }
    const projectIds = (Array.isArray(found.invitation.projectIds) ? found.invitation.projectIds : [])
      .filter(isUuid);
    const [projectRows, [member]] = await Promise.all([
      projectIds.length === 0
        ? []
        : db
            .select({ name: projects.name })
            .from(projects)
            .where(
              and(
                eq(projects.organizationId, found.organization.id),
                inArray(projects.id, projectIds),
              ),
            ),
      db
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, found.organization.id),
            eq(organizationMembers.accountId, accountId),
          ),
        )
        .limit(1),
    ]);
    return NextResponse.json({
      invitation: {
        already_member: member !== undefined,
        email: found.invitation.email,
        expires_at: found.invitation.expiresAt.toISOString(),
        organization: { id: found.organization.id, name: found.organization.name },
        own_organization: found.organization.ownerAccountId === accountId,
        owner_name: found.ownerName,
        projects: projectRows.map((project) => project.name),
        role: found.invitation.role,
        state: found.state,
      },
    });
  }

  const accepted = await acceptInvitation(db, token, accountId);
  if (!accepted.ok) {
    return manageFailureResponse(accepted);
  }
  await recordOrganizationAudit(context, accepted.organization, "organization.member_joined");
  return NextResponse.json({
    organization: { id: accepted.organization.id, name: accepted.organization.name },
    status: "joined",
  });
}
