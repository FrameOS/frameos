import { NextRequest, NextResponse } from "next/server";
import { jsonError, readJsonObject } from "../../../../../src/lib/device-flow";
import {
  cleanRole,
  managedOrganization,
  memberById,
  removeMember,
  setMemberRole,
} from "../../../../../src/lib/organization-manage";
import {
  organizationRequestContext,
  recordOrganizationAudit,
} from "../../../../../src/lib/organization-route";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ memberId: string }> };

// Change a member's role: {role: "admin" | "member"}. The owner's alone:
// admins manage people and projects, not who else is an admin.
export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const context = await organizationRequestContext(request, { change: true });
  if (context.response) {
    return context.response;
  }
  const { accountId, db } = context;
  const { memberId } = await params;
  const body = await readJsonObject(request);
  const role = cleanRole(body.role);
  if (!role) {
    return jsonError("invalid_role", 400);
  }
  const found = await memberById(db, memberId);
  if (!found || found.organization.ownerAccountId !== accountId) {
    // An admin can see the member; say why rather than "not found".
    const managed = found
      ? await managedOrganization(db, accountId, found.organization.id)
      : undefined;
    return managed ? jsonError("owner_only", 403) : jsonError("member_not_found", 404);
  }
  if (found.member.role !== role) {
    await setMemberRole(db, found.member.id, role);
    await recordOrganizationAudit(context, found.organization, "organization.member_role_changed", {
      email: found.primaryEmail,
      from: found.member.role,
      to: role,
    });
  }
  return NextResponse.json({ role, status: "saved" });
}

// Remove a member, or leave: the row goes and with it every frame the
// person had through this organization. A member may remove themselves; the
// owner anyone; an admin anyone but another admin.
export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const context = await organizationRequestContext(request, { change: true });
  if (context.response) {
    return context.response;
  }
  const { accountId, db } = context;
  const { memberId } = await params;
  const found = await memberById(db, memberId);
  if (!found) {
    return jsonError("member_not_found", 404);
  }
  const leaving = found.member.accountId === accountId;
  if (!leaving) {
    const managed = await managedOrganization(db, accountId, found.organization.id);
    if (!managed) {
      return jsonError("member_not_found", 404);
    }
    if (managed.role !== "owner" && found.member.role === "admin") {
      return jsonError("owner_only", 403);
    }
  }
  await removeMember(db, found.member.id);
  await recordOrganizationAudit(
    context,
    found.organization,
    leaving ? "organization.member_left" : "organization.member_removed",
    { email: found.primaryEmail },
  );
  return NextResponse.json({ status: leaving ? "left" : "removed" });
}
