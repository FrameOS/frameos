import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "../../../../../src/lib/device-flow";
import {
  invitationById,
  managedOrganization,
  revokeInvitation,
} from "../../../../../src/lib/organization-manage";
import {
  organizationRequestContext,
  recordOrganizationAudit,
} from "../../../../../src/lib/organization-route";

export const runtime = "nodejs";

// Take an open invitation back: its link stops working and its seat is free.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ invitationId: string }> },
) {
  const context = await organizationRequestContext(request, { change: true });
  if (context.response) {
    return context.response;
  }
  const { accountId, db } = context;
  const { invitationId } = await params;
  const invitation = await invitationById(db, invitationId);
  const managed = invitation
    ? await managedOrganization(db, accountId, invitation.organizationId)
    : undefined;
  // Someone else's invitation reads as none.
  if (!invitation || !managed) {
    return jsonError("invitation_not_found", 404);
  }
  if (!(await revokeInvitation(db, invitation.id))) {
    return jsonError("invitation_not_found", 404);
  }
  await recordOrganizationAudit(context, managed.organization, "organization.invitation_revoked", {
    email: invitation.email,
  });
  return NextResponse.json({ status: "revoked" });
}
