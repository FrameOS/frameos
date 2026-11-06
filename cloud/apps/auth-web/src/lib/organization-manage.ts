// Managing an organization: its people, its invitations and its projects
// (cloud/docs/sharing.md). Who may use which frame is organizations.ts; this
// file is the writes behind the People page and the routes under
// /api/organization.
//
// Every function here takes an organization the caller was already allowed
// to manage (managedOrganization), or says in its name that it checks.

import { and, asc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  accounts,
  frames,
  normalizeEmail,
  organizationInvitations,
  organizationMembers,
  organizations,
  projectMembers,
  projects,
  type createDb,
} from "@frameos-cloud/db";
import {
  isUuid,
  peopleLimitForAccount,
  type OrganizationMemberRole,
} from "./organizations";
import { createSecretToken, hashSecret } from "./secrets";

type Database = ReturnType<typeof createDb>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | Transaction;

export type OrganizationRow = typeof organizations.$inferSelect;
export type ManagerRole = "owner" | "admin";

export const maxOrganizationNameChars = 60;
export const maxProjectNameChars = 60;
export const maxProjectsPerOrganization = 100;
export const maxEmailChars = 254;
// How many ids one project change may carry: the largest plan's frames, with
// room. The bound only stops a body from being a novel.
export const maxIdsPerProjectChange = 2000;
export const invitationTtlMs = 7 * 24 * 60 * 60 * 1000;
export const invitationTokenPrefix = "FOINV";

/** A name as it is stored: one line, no control characters, trimmed. */
export function cleanName(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const name = value
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return name.length > 0 && name.length <= maxChars ? name : undefined;
}

const emailPattern = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

export function cleanEmail(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const email = normalizeEmail(value);
  return email.length <= maxEmailChars && emailPattern.test(email) ? email : undefined;
}

export function cleanRole(value: unknown): OrganizationMemberRole | undefined {
  return value === "admin" || value === "member" ? value : undefined;
}

/** A list of distinct uuids, or undefined when it is anything else. */
export function cleanIdList(value: unknown, max: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > max || !value.every(isUuid)) {
    return undefined;
  }
  return [...new Set(value as string[])];
}

function accountLabel(row: { displayName: string | null; primaryEmail: string | null }) {
  return row.displayName?.trim() || row.primaryEmail || null;
}

/**
 * The organization an account owns, made the first time it is asked for. It
 * is named after the owner until they rename it.
 */
export async function ensureOrganization(
  db: Database,
  ownerAccountId: string,
): Promise<OrganizationRow> {
  const [existing] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.ownerAccountId, ownerAccountId))
    .limit(1);
  if (existing) {
    return existing;
  }
  const [owner] = await db
    .select({ displayName: accounts.displayName, primaryEmail: accounts.primaryEmail })
    .from(accounts)
    .where(eq(accounts.id, ownerAccountId))
    .limit(1);
  const name =
    cleanName(owner?.displayName, maxOrganizationNameChars) ??
    cleanName(owner?.primaryEmail?.split("@")[0], maxOrganizationNameChars) ??
    "My frames";
  await db
    .insert(organizations)
    .values({ name, ownerAccountId })
    .onConflictDoNothing({ target: organizations.ownerAccountId });
  const [created] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.ownerAccountId, ownerAccountId))
    .limit(1);
  if (!created) {
    throw new Error("organization could not be created");
  }
  return created;
}

async function memberSeatNumber(db: Executor, member: { id: string; organizationId: string }) {
  const [row] = await db.execute<{ seat: number }>(
    sql`select (1 + count(*))::int as seat
          from ${organizationMembers} as earlier, ${organizationMembers} as me
         where me.id = ${member.id}
           and earlier.organization_id = me.organization_id
           and (earlier.created_at, earlier.id) <= (me.created_at, me.id)`,
  );
  return Number(row?.seat ?? Number.MAX_SAFE_INTEGER);
}

/**
 * The organization the account may manage: its own (made on first use) when
 * none is named, else the named one when the account owns it or is one of
 * its admins with a seat on the plan.
 */
export async function managedOrganization(
  db: Database,
  accountId: string,
  organizationId?: string | null,
): Promise<{ organization: OrganizationRow; role: ManagerRole } | undefined> {
  if (!organizationId) {
    return { organization: await ensureOrganization(db, accountId), role: "owner" };
  }
  if (!isUuid(organizationId)) {
    return undefined;
  }
  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!organization) {
    return undefined;
  }
  if (organization.ownerAccountId === accountId) {
    return { organization, role: "owner" };
  }
  const [member] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organization.id),
        eq(organizationMembers.accountId, accountId),
        eq(organizationMembers.role, "admin"),
      ),
    )
    .limit(1);
  if (!member) {
    return undefined;
  }
  const [seat, limit] = await Promise.all([
    memberSeatNumber(db, member),
    peopleLimitForAccount(db, organization.ownerAccountId),
  ]);
  return seat <= limit ? { organization, role: "admin" } : undefined;
}

const invitationIsPending = (now: Date) =>
  and(
    isNull(organizationInvitations.acceptedAt),
    isNull(organizationInvitations.revokedAt),
    gt(organizationInvitations.expiresAt, now),
  );

/** The seats taken: the owner, every member, every invitation still open. */
export async function seatsUsed(db: Executor, organizationId: string, now = new Date()) {
  const [[members], [pending]] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, organizationId)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(organizationInvitations)
      .where(
        and(eq(organizationInvitations.organizationId, organizationId), invitationIsPending(now)),
      ),
  ]);
  return 1 + Number(members?.count ?? 0) + Number(pending?.count ?? 0);
}

function invitationJson(row: typeof organizationInvitations.$inferSelect) {
  return {
    created_at: row.createdAt.toISOString(),
    email: row.email,
    expires_at: row.expiresAt.toISOString(),
    id: row.id,
    project_ids: Array.isArray(row.projectIds) ? row.projectIds : [],
    role: row.role,
  };
}

/**
 * Everything the People page draws for an organization the caller manages.
 * An admin gets the same as the owner, minus the owner's frames that are in
 * no project: those are not shared with anyone.
 */
export async function organizationSummary(
  db: Database,
  organization: OrganizationRow,
  role: ManagerRole,
  viewerAccountId: string,
) {
  const now = new Date();
  const [limit, [owner], memberRows, invitationRows, projectRows, projectMemberRows, frameRows] =
    await Promise.all([
      peopleLimitForAccount(db, organization.ownerAccountId),
      db
        .select({ displayName: accounts.displayName, primaryEmail: accounts.primaryEmail })
        .from(accounts)
        .where(eq(accounts.id, organization.ownerAccountId))
        .limit(1),
      db
        .select({
          accountId: organizationMembers.accountId,
          createdAt: organizationMembers.createdAt,
          displayName: accounts.displayName,
          id: organizationMembers.id,
          primaryEmail: accounts.primaryEmail,
          role: organizationMembers.role,
        })
        .from(organizationMembers)
        .innerJoin(accounts, eq(accounts.id, organizationMembers.accountId))
        .where(eq(organizationMembers.organizationId, organization.id))
        .orderBy(asc(organizationMembers.createdAt), asc(organizationMembers.id)),
      db
        .select()
        .from(organizationInvitations)
        .where(
          and(
            eq(organizationInvitations.organizationId, organization.id),
            invitationIsPending(now),
          ),
        )
        .orderBy(asc(organizationInvitations.createdAt)),
      db
        .select()
        .from(projects)
        .where(eq(projects.organizationId, organization.id))
        .orderBy(asc(projects.createdAt), asc(projects.id)),
      db
        .select({ memberId: projectMembers.memberId, projectId: projectMembers.projectId })
        .from(projectMembers)
        .innerJoin(projects, eq(projects.id, projectMembers.projectId))
        .where(eq(projects.organizationId, organization.id)),
      db
        .select({ id: frames.id, name: frames.name, projectId: frames.projectId })
        .from(frames)
        .where(
          and(eq(frames.accountId, organization.ownerAccountId), ne(frames.status, "revoked")),
        )
        .orderBy(asc(frames.createdAt)),
    ]);
  const projectIds = new Set(projectRows.map((project) => project.id));
  // A frame of the owner's that sits in a project of ANOTHER organization
  // cannot happen (one organization per owner); a stale id reads as none.
  const visibleFrames = frameRows
    .map((frame) => ({
      id: frame.id,
      name: frame.name,
      project_id: frame.projectId && projectIds.has(frame.projectId) ? frame.projectId : null,
    }))
    .filter((frame) => role === "owner" || frame.project_id !== null);
  return {
    frames: visibleFrames,
    id: organization.id,
    invitations: invitationRows.map(invitationJson),
    members: memberRows.map((member, index) => ({
      // The seats go in joining order, the owner's first: a member past the
      // plan's people keeps the row and has no access.
      active: index + 2 <= limit,
      email: member.primaryEmail,
      id: member.id,
      joined_at: member.createdAt.toISOString(),
      name: member.displayName,
      role: member.role,
      you: member.accountId === viewerAccountId,
    })),
    name: organization.name,
    owner: {
      email: owner?.primaryEmail ?? null,
      name: owner?.displayName ?? null,
      you: organization.ownerAccountId === viewerAccountId,
    },
    people: {
      limit,
      used: 1 + memberRows.length + invitationRows.length,
    },
    projects: projectRows.map((project) => ({
      frame_ids: frameRows
        .filter((frame) => frame.projectId === project.id)
        .map((frame) => frame.id),
      id: project.id,
      member_ids: projectMemberRows
        .filter((row) => row.projectId === project.id)
        .map((row) => row.memberId),
      name: project.name,
    })),
    role,
  };
}

/**
 * The organizations the account is a member of (never its own): what it was
 * given, and whether the plan still has a seat for it.
 */
export async function membershipsSummary(db: Database, accountId: string) {
  const rows = await db
    .select({
      createdAt: organizationMembers.createdAt,
      memberId: organizationMembers.id,
      organizationId: organizations.id,
      organizationName: organizations.name,
      ownerAccountId: organizations.ownerAccountId,
      ownerDisplayName: accounts.displayName,
      ownerPrimaryEmail: accounts.primaryEmail,
      role: organizationMembers.role,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .innerJoin(accounts, eq(accounts.id, organizations.ownerAccountId))
    .where(eq(organizationMembers.accountId, accountId))
    .orderBy(asc(organizationMembers.createdAt));
  const result = [];
  for (const row of rows) {
    const [seat, limit, projectRows] = await Promise.all([
      memberSeatNumber(db, { id: row.memberId, organizationId: row.organizationId }),
      peopleLimitForAccount(db, row.ownerAccountId),
      db
        .select({
          // Table names spelled out: drizzle leaves the qualifier off a
          // column in a one-table select, and "id" inside the subquery
          // would then be the frame's.
          frameCount: sql<number>`(select count(*)::int from "frames"
                                    where "frames"."project_id" = "projects"."id")`,
          id: projects.id,
          name: projects.name,
        })
        .from(projects)
        .where(
          and(
            eq(projects.organizationId, row.organizationId),
            row.role === "admin"
              ? undefined
              : sql`exists (select 1 from "project_members"
                             where "project_members"."project_id" = "projects"."id"
                               and "project_members"."member_id" = ${row.memberId})`,
          ),
        )
        .orderBy(asc(projects.createdAt), asc(projects.id)),
    ]);
    result.push({
      active: seat <= limit,
      joined_at: row.createdAt.toISOString(),
      member_id: row.memberId,
      organization: { id: row.organizationId, name: row.organizationName },
      owner_name: accountLabel({
        displayName: row.ownerDisplayName,
        primaryEmail: row.ownerPrimaryEmail,
      }),
      projects: projectRows.map((project) => ({
        frame_count: Number(project.frameCount),
        id: project.id,
        name: project.name,
      })),
      role: row.role,
    });
  }
  return result;
}

export type ManageFailure = { error: string; detail?: Record<string, unknown>; status: number };

function failure(error: string, status: number, detail?: Record<string, unknown>): ManageFailure {
  return { error, status, ...(detail ? { detail } : {}) };
}

// One organization's seats change under this lock, so two invitations (or an
// invitation and an acceptance) cannot both take the last one.
async function lockOrganization(tx: Transaction, organizationId: string) {
  await tx.execute(
    sql`select 1 from ${organizations} where ${organizations.id} = ${organizationId} for update`,
  );
}

async function projectIdsOfOrganization(
  db: Executor,
  organizationId: string,
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) {
    return [];
  }
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.organizationId, organizationId), inArray(projects.id, [...ids])));
  return rows.map((row) => row.id);
}

/**
 * Invite an address. The invitation takes a seat at once; the link is in the
 * result exactly once (only its hash is stored).
 */
export async function createInvitation(
  db: Database,
  input: {
    email: string;
    invitedByAccountId: string;
    organization: OrganizationRow;
    projectIds: readonly string[];
    role: OrganizationMemberRole;
  },
): Promise<
  | { invitation: ReturnType<typeof invitationJson>; ok: true; token: string }
  | (ManageFailure & { ok: false })
> {
  const { organization } = input;
  const limit = await peopleLimitForAccount(db, organization.ownerAccountId);
  const token = createSecretToken(invitationTokenPrefix);
  return db.transaction(async (tx) => {
    await lockOrganization(tx, organization.id);
    const now = new Date();
    // The same person twice is a mistake, not a second seat.
    const [already] = await tx
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .innerJoin(accounts, eq(accounts.id, organizationMembers.accountId))
      .where(
        and(
          eq(organizationMembers.organizationId, organization.id),
          sql`lower(${accounts.primaryEmail}) = ${input.email}`,
        ),
      )
      .limit(1);
    if (already) {
      return { ok: false as const, ...failure("already_member", 409) };
    }
    const [owner] = await tx
      .select({ primaryEmail: accounts.primaryEmail })
      .from(accounts)
      .where(eq(accounts.id, organization.ownerAccountId))
      .limit(1);
    if (owner?.primaryEmail && normalizeEmail(owner.primaryEmail) === input.email) {
      return { ok: false as const, ...failure("already_member", 409) };
    }
    const [open] = await tx
      .select({ id: organizationInvitations.id })
      .from(organizationInvitations)
      .where(
        and(
          eq(organizationInvitations.organizationId, organization.id),
          eq(organizationInvitations.email, input.email),
          invitationIsPending(now),
        ),
      )
      .limit(1);
    if (open) {
      return { ok: false as const, ...failure("already_invited", 409) };
    }
    const used = await seatsUsed(tx, organization.id, now);
    if (used >= limit) {
      return { ok: false as const, ...failure("people_limit", 403, { limit, used }) };
    }
    const projectIds = await projectIdsOfOrganization(tx, organization.id, input.projectIds);
    if (projectIds.length !== input.projectIds.length) {
      return { ok: false as const, ...failure("invalid_project", 400) };
    }
    const [row] = await tx
      .insert(organizationInvitations)
      .values({
        email: input.email,
        expiresAt: new Date(now.getTime() + invitationTtlMs),
        invitedByAccountId: input.invitedByAccountId,
        organizationId: organization.id,
        projectIds,
        role: input.role,
        tokenHash: hashSecret(token),
      })
      .returning();
    return { invitation: invitationJson(row!), ok: true as const, token };
  });
}

/** Take an open invitation back. False when there is none by that id. */
export async function revokeInvitation(db: Database, invitationId: string): Promise<boolean> {
  const revoked = await db
    .update(organizationInvitations)
    .set({ revokedAt: new Date() })
    .where(and(eq(organizationInvitations.id, invitationId), invitationIsPending(new Date())))
    .returning({ id: organizationInvitations.id });
  return revoked.length > 0;
}

export async function invitationById(db: Database, invitationId: string) {
  if (!isUuid(invitationId)) {
    return undefined;
  }
  const [row] = await db
    .select()
    .from(organizationInvitations)
    .where(eq(organizationInvitations.id, invitationId))
    .limit(1);
  return row;
}

export type InvitationState = "open" | "accepted" | "revoked" | "expired";

function invitationState(
  row: typeof organizationInvitations.$inferSelect,
  now = new Date(),
): InvitationState {
  if (row.acceptedAt) {
    return "accepted";
  }
  if (row.revokedAt) {
    return "revoked";
  }
  return row.expiresAt.getTime() > now.getTime() ? "open" : "expired";
}

/** What an invitation link is for, as the person opening it sees it. */
export async function invitationForToken(db: Database, token: string) {
  if (!token.startsWith(`${invitationTokenPrefix}_`) || token.length > 128) {
    return undefined;
  }
  const [row] = await db
    .select({
      invitation: organizationInvitations,
      organization: organizations,
      ownerDisplayName: accounts.displayName,
      ownerPrimaryEmail: accounts.primaryEmail,
    })
    .from(organizationInvitations)
    .innerJoin(organizations, eq(organizations.id, organizationInvitations.organizationId))
    .innerJoin(accounts, eq(accounts.id, organizations.ownerAccountId))
    .where(eq(organizationInvitations.tokenHash, hashSecret(token)))
    .limit(1);
  if (!row) {
    return undefined;
  }
  return {
    invitation: row.invitation,
    organization: row.organization,
    ownerName: accountLabel({
      displayName: row.ownerDisplayName,
      primaryEmail: row.ownerPrimaryEmail,
    }),
    state: invitationState(row.invitation),
  };
}

/**
 * Join the organization an invitation is for. The link is the proof: whoever
 * holds it and is signed in joins, as the people page then shows by name.
 * Used once; accepting a second time as the same account is a no-op.
 */
export async function acceptInvitation(
  db: Database,
  token: string,
  accountId: string,
): Promise<
  | { memberId: string; ok: true; organization: OrganizationRow }
  | (ManageFailure & { ok: false })
> {
  const found = await invitationForToken(db, token);
  if (!found) {
    return { ok: false, ...failure("invitation_not_found", 404) };
  }
  const { organization } = found;
  if (organization.ownerAccountId === accountId) {
    return { ok: false, ...failure("own_organization", 409) };
  }
  const limit = await peopleLimitForAccount(db, organization.ownerAccountId);
  return db.transaction(async (tx) => {
    await lockOrganization(tx, organization.id);
    const [invitation] = await tx
      .select()
      .from(organizationInvitations)
      .where(eq(organizationInvitations.id, found.invitation.id))
      .limit(1);
    const [existing] = await tx
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organization.id),
          eq(organizationMembers.accountId, accountId),
        ),
      )
      .limit(1);
    const state = invitation ? invitationState(invitation) : "revoked";
    if (!invitation || state !== "open") {
      // The same person opening their link again lands where they are.
      if (existing && invitation?.acceptedByAccountId === accountId) {
        return { memberId: existing.id, ok: true as const, organization };
      }
      return { ok: false as const, ...failure(`invitation_${state}`, 410) };
    }
    let memberId = existing?.id;
    if (!memberId) {
      // The invitation has held a seat since it was sent; only a plan that
      // shrank meanwhile can leave no room for it.
      const [members] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(organizationMembers)
        .where(eq(organizationMembers.organizationId, organization.id));
      if (1 + Number(members?.count ?? 0) >= limit) {
        return { ok: false as const, ...failure("people_limit", 403, { limit }) };
      }
      const [created] = await tx
        .insert(organizationMembers)
        .values({
          accountId,
          invitedByAccountId: invitation.invitedByAccountId,
          organizationId: organization.id,
          role: invitation.role,
        })
        .returning({ id: organizationMembers.id });
      memberId = created!.id;
    }
    const projectIds = await projectIdsOfOrganization(
      tx,
      organization.id,
      Array.isArray(invitation.projectIds) ? invitation.projectIds.filter(isUuid) : [],
    );
    if (projectIds.length > 0) {
      await tx
        .insert(projectMembers)
        .values(projectIds.map((projectId) => ({ memberId: memberId!, projectId })))
        .onConflictDoNothing();
    }
    await tx
      .update(organizationInvitations)
      .set({ acceptedAt: new Date(), acceptedByAccountId: accountId })
      .where(eq(organizationInvitations.id, invitation.id));
    return { memberId, ok: true as const, organization };
  });
}

export async function memberById(db: Database, memberId: string) {
  if (!isUuid(memberId)) {
    return undefined;
  }
  const [row] = await db
    .select({
      member: organizationMembers,
      organization: organizations,
      primaryEmail: accounts.primaryEmail,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .innerJoin(accounts, eq(accounts.id, organizationMembers.accountId))
    .where(eq(organizationMembers.id, memberId))
    .limit(1);
  return row;
}

/** Removing the row is the revocation: nothing else holds the access. */
export async function removeMember(db: Database, memberId: string) {
  await db.delete(organizationMembers).where(eq(organizationMembers.id, memberId));
}

export async function setMemberRole(
  db: Database,
  memberId: string,
  role: OrganizationMemberRole,
) {
  await db
    .update(organizationMembers)
    .set({ role, updatedAt: new Date() })
    .where(eq(organizationMembers.id, memberId));
}

export async function renameOrganization(db: Database, organizationId: string, name: string) {
  await db
    .update(organizations)
    .set({ name, updatedAt: new Date() })
    .where(eq(organizations.id, organizationId));
}

export async function projectById(db: Database, projectId: string) {
  if (!isUuid(projectId)) {
    return undefined;
  }
  const [row] = await db
    .select({ organization: organizations, project: projects })
    .from(projects)
    .innerJoin(organizations, eq(organizations.id, projects.organizationId))
    .where(eq(projects.id, projectId))
    .limit(1);
  return row;
}

export async function createProject(
  db: Database,
  organization: OrganizationRow,
  name: string,
): Promise<{ ok: true; project: typeof projects.$inferSelect } | (ManageFailure & { ok: false })> {
  const [count] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(projects)
    .where(eq(projects.organizationId, organization.id));
  if (Number(count?.count ?? 0) >= maxProjectsPerOrganization) {
    return { ok: false, ...failure("too_many_projects", 409, { max: maxProjectsPerOrganization }) };
  }
  const [project] = await db
    .insert(projects)
    .values({ name, organizationId: organization.id })
    .returning();
  return { ok: true, project: project! };
}

/**
 * Change a project: its name, the frames in it, the members who have it.
 * Each list replaces the one before; a part left out stays as it is.
 *
 * The frames must be the organization owner's. An admin may only move
 * frames that are already shared (in one of the organization's projects):
 * the owner's other frames are not theirs to see, so not theirs to share.
 */
export async function updateProject(
  db: Database,
  input: {
    frameIds?: readonly string[] | undefined;
    memberIds?: readonly string[] | undefined;
    name?: string | undefined;
    organization: OrganizationRow;
    projectId: string;
    role: ManagerRole;
  },
): Promise<
  | { added: string[]; ok: true; removed: string[] }
  | (ManageFailure & { ok: false })
> {
  const { organization, projectId } = input;
  return db.transaction(async (tx) => {
    await lockOrganization(tx, organization.id);
    let added: string[] = [];
    let removed: string[] = [];
    if (input.frameIds !== undefined) {
      const wanted = [...input.frameIds];
      const current = await tx
        .select({ id: frames.id })
        .from(frames)
        .where(eq(frames.projectId, projectId));
      const currentIds = new Set(current.map((frame) => frame.id));
      added = wanted.filter((id) => !currentIds.has(id));
      removed = [...currentIds].filter((id) => !wanted.includes(id));
      if (added.length > 0) {
        const candidates = await tx
          .select({ id: frames.id, projectId: frames.projectId, status: frames.status })
          .from(frames)
          .where(and(eq(frames.accountId, organization.ownerAccountId), inArray(frames.id, added)));
        const usable = candidates.filter(
          (frame) =>
            frame.status !== "revoked" && (input.role === "owner" || frame.projectId !== null),
        );
        if (usable.length !== added.length) {
          return { ok: false as const, ...failure("invalid_frame", 400) };
        }
        await tx
          .update(frames)
          .set({ projectId, updatedAt: new Date() })
          .where(inArray(frames.id, added));
      }
      if (removed.length > 0) {
        await tx
          .update(frames)
          .set({ projectId: null, updatedAt: new Date() })
          .where(and(eq(frames.projectId, projectId), inArray(frames.id, removed)));
      }
    }
    if (input.memberIds !== undefined) {
      const wanted = [...input.memberIds];
      const valid =
        wanted.length === 0
          ? []
          : await tx
              .select({ id: organizationMembers.id })
              .from(organizationMembers)
              .where(
                and(
                  eq(organizationMembers.organizationId, organization.id),
                  inArray(organizationMembers.id, wanted),
                ),
              );
      if (valid.length !== wanted.length) {
        return { ok: false as const, ...failure("invalid_member", 400) };
      }
      await tx.delete(projectMembers).where(eq(projectMembers.projectId, projectId));
      if (wanted.length > 0) {
        await tx
          .insert(projectMembers)
          .values(wanted.map((memberId) => ({ memberId, projectId })));
      }
    }
    if (input.name !== undefined) {
      await tx
        .update(projects)
        .set({ name: input.name, updatedAt: new Date() })
        .where(eq(projects.id, projectId));
    } else if (input.frameIds !== undefined || input.memberIds !== undefined) {
      await tx.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, projectId));
    }
    return { added, ok: true as const, removed };
  });
}

/** The project's frames go back to being the owner's alone (ON DELETE SET NULL). */
export async function deleteProject(db: Database, projectId: string) {
  await db.delete(projects).where(eq(projects.id, projectId));
}
