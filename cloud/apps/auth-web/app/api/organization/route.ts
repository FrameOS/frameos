import { NextRequest, NextResponse } from "next/server";
import { jsonError, readJsonObject } from "../../../src/lib/device-flow";
import {
  cleanName,
  managedOrganization,
  maxOrganizationNameChars,
  membershipsSummary,
  organizationSummary,
  renameOrganization,
} from "../../../src/lib/organization-manage";
import {
  organizationRequestContext,
  recordOrganizationAudit,
} from "../../../src/lib/organization-route";

export const runtime = "nodejs";

// The people page's one read (cloud/docs/sharing.md "API").
//
// `organization` is the one the caller manages: their own, made the first
// time this is asked, or with `?organization_id=` another they are an admin
// of. `memberships` are the organizations of other people the caller is in,
// with the projects they were given.
export async function GET(request: NextRequest) {
  const context = await organizationRequestContext(request, { change: false });
  if (context.response) {
    return context.response;
  }
  const { accountId, db } = context;
  const managed = await managedOrganization(
    db,
    accountId,
    request.nextUrl.searchParams.get("organization_id"),
  );
  if (!managed) {
    return jsonError("organization_not_found", 404);
  }
  const [organization, memberships] = await Promise.all([
    organizationSummary(db, managed.organization, managed.role, accountId),
    membershipsSummary(db, accountId),
  ]);
  return NextResponse.json(
    { memberships, organization },
    { headers: { "cache-control": "no-store" } },
  );
}

// Rename the organization: {name, organization_id?}.
export async function PATCH(request: NextRequest) {
  const context = await organizationRequestContext(request, { change: true });
  if (context.response) {
    return context.response;
  }
  const { accountId, db } = context;
  const body = await readJsonObject(request);
  const name = cleanName(body.name, maxOrganizationNameChars);
  if (!name) {
    return jsonError("invalid_name", 400);
  }
  const managed = await managedOrganization(
    db,
    accountId,
    typeof body.organization_id === "string" ? body.organization_id : null,
  );
  if (!managed) {
    return jsonError("organization_not_found", 404);
  }
  if (name !== managed.organization.name) {
    await renameOrganization(db, managed.organization.id, name);
    await recordOrganizationAudit(context, managed.organization, "organization.renamed", {
      from: managed.organization.name,
      to: name,
    });
  }
  return NextResponse.json({ name, status: "saved" });
}
