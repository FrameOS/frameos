import { NextRequest, NextResponse } from "next/server";
import { jsonError, readJsonObject } from "../../../../../src/lib/device-flow";
import {
  cleanIdList,
  cleanName,
  deleteProject,
  managedOrganization,
  maxIdsPerProjectChange,
  maxProjectNameChars,
  projectById,
  updateProject,
} from "../../../../../src/lib/organization-manage";
import {
  manageFailureResponse,
  organizationRequestContext,
  recordOrganizationAudit,
} from "../../../../../src/lib/organization-route";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ projectId: string }> };

async function managedProject(
  context: Exclude<Awaited<ReturnType<typeof organizationRequestContext>>, { response: NextResponse }>,
  projectId: string,
) {
  const found = await projectById(context.db, projectId);
  const managed = found
    ? await managedOrganization(context.db, context.accountId, found.organization.id)
    : undefined;
  // Someone else's project reads as none.
  return found && managed ? { ...found, role: managed.role } : undefined;
}

// Change a project: {name?, frame_ids?, member_ids?}. Each list replaces the
// one before it, and what is left out stays. Putting a frame in a project is
// what shares it; taking it out makes it the owner's alone again.
export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const context = await organizationRequestContext(request, { change: true });
  if (context.response) {
    return context.response;
  }
  const { projectId } = await params;
  const found = await managedProject(context, projectId);
  if (!found) {
    return jsonError("project_not_found", 404);
  }
  const body = await readJsonObject(request);
  const name = body.name === undefined ? undefined : cleanName(body.name, maxProjectNameChars);
  if (body.name !== undefined && !name) {
    return jsonError("invalid_name", 400);
  }
  const frameIds =
    body.frame_ids === undefined ? undefined : cleanIdList(body.frame_ids, maxIdsPerProjectChange);
  if (body.frame_ids !== undefined && !frameIds) {
    return jsonError("invalid_frame", 400);
  }
  const memberIds =
    body.member_ids === undefined ? undefined : cleanIdList(body.member_ids, maxIdsPerProjectChange);
  if (body.member_ids !== undefined && !memberIds) {
    return jsonError("invalid_member", 400);
  }
  if (name === undefined && frameIds === undefined && memberIds === undefined) {
    return jsonError("nothing_to_update", 400);
  }

  const updated = await updateProject(context.db, {
    frameIds,
    memberIds,
    name,
    organization: found.organization,
    projectId: found.project.id,
    role: found.role,
  });
  if (!updated.ok) {
    return manageFailureResponse(updated);
  }
  await recordOrganizationAudit(context, found.organization, "organization.project_changed", {
    project: name ?? found.project.name,
    ...(name !== undefined && name !== found.project.name ? { renamedFrom: found.project.name } : {}),
    ...(frameIds !== undefined
      ? { framesAdded: updated.added.length, framesRemoved: updated.removed.length }
      : {}),
    ...(memberIds !== undefined ? { people: memberIds.length } : {}),
  });
  return NextResponse.json({ status: "saved" });
}

// Delete a project. Its frames stay the owner's and are shared with nobody.
export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const context = await organizationRequestContext(request, { change: true });
  if (context.response) {
    return context.response;
  }
  const { projectId } = await params;
  const found = await managedProject(context, projectId);
  if (!found) {
    return jsonError("project_not_found", 404);
  }
  await deleteProject(context.db, found.project.id);
  await recordOrganizationAudit(context, found.organization, "organization.project_deleted", {
    project: found.project.name,
  });
  return NextResponse.json({ status: "deleted" });
}
