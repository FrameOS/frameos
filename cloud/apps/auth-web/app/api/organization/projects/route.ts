import { NextRequest, NextResponse } from "next/server";
import { jsonError, readJsonObject } from "../../../../src/lib/device-flow";
import {
  cleanName,
  createProject,
  managedOrganization,
  maxProjectNameChars,
} from "../../../../src/lib/organization-manage";
import {
  manageFailureResponse,
  organizationRequestContext,
  recordOrganizationAudit,
} from "../../../../src/lib/organization-route";

export const runtime = "nodejs";

// A new project: {name, organization_id?}. Empty until frames and people
// are put in it (PATCH /api/organization/projects/{id}).
export async function POST(request: NextRequest) {
  const context = await organizationRequestContext(request, { change: true });
  if (context.response) {
    return context.response;
  }
  const { accountId, db } = context;
  const body = await readJsonObject(request);
  const name = cleanName(body.name, maxProjectNameChars);
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
  const created = await createProject(db, managed.organization, name);
  if (!created.ok) {
    return manageFailureResponse(created);
  }
  await recordOrganizationAudit(context, managed.organization, "organization.project_created", {
    project: name,
  });
  return NextResponse.json(
    { project: { frame_ids: [], id: created.project.id, member_ids: [], name } },
    { status: 201 },
  );
}
