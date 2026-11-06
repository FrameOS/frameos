// Who may use a frame that is not theirs (cloud/docs/sharing.md).
//
// A frame belongs to ONE account, the owner, and that never changes: its
// quota, its service keys and its audit trail are the owner's. Sharing is an
// answer worked out on every request from four tables (migration 0074):
//
//   organizations         the people on the owner's plan
//   organization_members  one row per person besides the owner: admin | member
//   projects              a set of the owner's frames (frames.project_id)
//   project_members       which members may use a project's frames
//
// A member has a frame when it is in a project they were added to; an admin
// has every project's frames. A frame in no project is the owner's alone.
// Nothing is copied or cached, so deleting a row is the whole revocation.
//
// The plan decides how many people there are (`people`, the owner included).
// The seats go in the order people joined, so a plan that shrinks leaves the
// members who joined last without access until it grows again or someone is
// removed; nobody's membership is deleted by a downgrade.
//
// Free of Next imports on purpose: the frame hub reads this file to decide
// which browsers hear a frame's live events.

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  accounts,
  frameSceneAssignments,
  frames,
  linkedClients,
  organizationMembers,
  organizations,
  projectMembers,
  projects,
  type createDb,
} from "@frameos-cloud/db";
import { accountLimits } from "./usage";

type Database = ReturnType<typeof createDb>;
type FrameRow = typeof frames.$inferSelect;

/**
 * What a route needs from the caller, least to most:
 *
 *   view    read the frame: its picture, state, logs, scenes
 *   edit    change what it shows and how: scenes, settings, files, commands
 *   manage  the owner's switches: service keys, telemetry, voice, local
 *           network access, which project the frame is in
 *   owner   what stays with the account the frame belongs to: deleting and
 *           revoking it, enrolling new ones
 */
export type FrameAccessLevel = "view" | "edit" | "manage" | "owner";

/** Who the caller is to a frame. */
export type FrameAccessRole = "owner" | "admin" | "member";

export const organizationMemberRoles = ["admin", "member"] as const;
export type OrganizationMemberRole = (typeof organizationMemberRoles)[number];

const levelRank: Record<FrameAccessLevel, number> = {
  view: 0,
  edit: 1,
  manage: 2,
  owner: 3,
};

// The most each role may do. There is no view-only role yet: the workspace
// has no read-only mode to show one, and a role the page cannot draw is a
// page of buttons that fail.
const roleLevel: Record<FrameAccessRole, FrameAccessLevel> = {
  admin: "manage",
  member: "edit",
  owner: "owner",
};

export function roleAllows(role: FrameAccessRole, need: FrameAccessLevel): boolean {
  return levelRank[roleLevel[role]] >= levelRank[need];
}

export interface FrameAccess {
  role: FrameAccessRole;
  organization: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
  /** The account the frame belongs to, when that is not the caller. */
  owner?: { name: string | null } | undefined;
}

/** `access` on a frame, as the workspace reads it. */
export function frameAccessSummary(access: FrameAccess) {
  return {
    organization: access.organization,
    ...(access.owner ? { owner_name: access.owner.name } : {}),
    project: access.project,
    role: access.role,
  };
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

function isMemberRole(value: unknown): value is OrganizationMemberRole {
  return value === "admin" || value === "member";
}

// A member's seat: the owner has the first, members follow in the order they
// joined. Worked out in SQL beside the row so no caller can forget it.
const memberSeat = sql<number>`(1 + (
  select count(*) from "organization_members" as "earlier"
   where "earlier"."organization_id" = ${organizationMembers.organizationId}
     and ("earlier"."created_at", "earlier"."id")
           <= (${organizationMembers.createdAt}, ${organizationMembers.id})
))::int`;

// The member may use the project: an admin every one, a member the ones it
// was added to.
const memberHasProject = sql`(${organizationMembers.role} = 'admin' or exists (
  select 1 from ${projectMembers}
   where ${projectMembers.projectId} = ${projects.id}
     and ${projectMembers.memberId} = ${organizationMembers.id}
))`;

/** How many people the owner's plan has, the owner included. */
export async function peopleLimitForAccount(
  db: Database,
  ownerAccountId: string,
): Promise<number> {
  return (await accountLimits(db, ownerAccountId)).people;
}

// One lookup per owner for the length of a request: a listing asks about the
// same few organizations for every frame.
function peopleLimits(db: Database) {
  const known = new Map<string, Promise<number>>();
  return (ownerAccountId: string) => {
    let limit = known.get(ownerAccountId);
    if (!limit) {
      limit = peopleLimitForAccount(db, ownerAccountId);
      known.set(ownerAccountId, limit);
    }
    return limit;
  };
}

function ownerName(row: { displayName: string | null; primaryEmail: string | null }) {
  return row.displayName?.trim() || row.primaryEmail || null;
}

/**
 * The frame as someone who shares it sees it, or undefined: not in a project
 * of an organization the account is in, not in a project the member has, or
 * the member is past the plan's people. Never the owner's own frame.
 */
export async function sharedFrameAccess(
  db: Database,
  accountId: string,
  frameId: string,
): Promise<{ access: FrameAccess; frame: FrameRow } | undefined> {
  if (!isUuid(frameId)) {
    return undefined;
  }
  const [row] = await db
    .select({
      frame: frames,
      organizationId: organizations.id,
      organizationName: organizations.name,
      ownerDisplayName: accounts.displayName,
      ownerPrimaryEmail: accounts.primaryEmail,
      projectId: projects.id,
      projectName: projects.name,
      role: organizationMembers.role,
      seat: memberSeat,
    })
    .from(frames)
    .innerJoin(projects, eq(projects.id, frames.projectId))
    .innerJoin(
      organizations,
      and(
        eq(organizations.id, projects.organizationId),
        // A frame is only ever shared by the account it belongs to.
        eq(organizations.ownerAccountId, frames.accountId),
      ),
    )
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.organizationId, organizations.id),
        eq(organizationMembers.accountId, accountId),
      ),
    )
    .innerJoin(accounts, eq(accounts.id, frames.accountId))
    .where(and(eq(frames.id, frameId), memberHasProject))
    .limit(1);
  if (!row || !isMemberRole(row.role)) {
    return undefined;
  }
  if (row.seat > (await peopleLimitForAccount(db, row.frame.accountId))) {
    return undefined;
  }
  return {
    access: {
      organization: { id: row.organizationId, name: row.organizationName },
      owner: {
        name: ownerName({
          displayName: row.ownerDisplayName,
          primaryEmail: row.ownerPrimaryEmail,
        }),
      },
      project: { id: row.projectId, name: row.projectName },
      role: row.role,
    },
    frame: row.frame,
  };
}

/**
 * The frame and who the account is to it, when the account may do `need`.
 * Undefined otherwise: a frame the caller may not use at that level reads as
 * a frame that is not there, the way someone else's always has.
 */
export async function frameAccessForAccount(
  db: Database,
  accountId: string,
  frameId: string,
  need: FrameAccessLevel,
): Promise<{ access: FrameAccess; frame: FrameRow } | undefined> {
  if (!isUuid(frameId)) {
    return undefined;
  }
  const [own] = await db
    .select({
      frame: frames,
      organizationId: organizations.id,
      organizationName: organizations.name,
      projectId: projects.id,
      projectName: projects.name,
    })
    .from(frames)
    .leftJoin(projects, eq(projects.id, frames.projectId))
    .leftJoin(organizations, eq(organizations.id, projects.organizationId))
    .where(and(eq(frames.id, frameId), eq(frames.accountId, accountId)))
    .limit(1);
  if (own) {
    return {
      access: {
        organization:
          own.organizationId && own.organizationName !== null
            ? { id: own.organizationId, name: own.organizationName }
            : null,
        project:
          own.projectId && own.projectName !== null
            ? { id: own.projectId, name: own.projectName }
            : null,
        role: "owner",
      },
      frame: own.frame,
    };
  }
  if (need === "owner") {
    return undefined;
  }
  const shared = await sharedFrameAccess(db, accountId, frameId);
  return shared && roleAllows(shared.access.role, need) ? shared : undefined;
}

export interface AccessibleFrame {
  access: FrameAccess;
  frame: FrameRow;
  linkedClient: typeof linkedClients.$inferSelect | null;
}

/**
 * Every frame the account has: its own in the order they were added, then
 * the ones shared with it.
 */
export async function framesForAccount(
  db: Database,
  accountId: string,
): Promise<AccessibleFrame[]> {
  const [own, shared] = await Promise.all([
    db
      .select({
        frame: frames,
        linkedClient: linkedClients,
        organizationId: organizations.id,
        organizationName: organizations.name,
        projectId: projects.id,
        projectName: projects.name,
      })
      .from(frames)
      // A LEFT join keeps a frame whose linked client vanished visible.
      .leftJoin(linkedClients, eq(linkedClients.id, frames.linkedClientId))
      .leftJoin(projects, eq(projects.id, frames.projectId))
      .leftJoin(organizations, eq(organizations.id, projects.organizationId))
      .where(eq(frames.accountId, accountId))
      .orderBy(asc(frames.createdAt)),
    db
      .select({
        frame: frames,
        linkedClient: linkedClients,
        organizationId: organizations.id,
        organizationName: organizations.name,
        ownerDisplayName: accounts.displayName,
        ownerPrimaryEmail: accounts.primaryEmail,
        projectId: projects.id,
        projectName: projects.name,
        role: organizationMembers.role,
        seat: memberSeat,
      })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .innerJoin(projects, eq(projects.organizationId, organizations.id))
      .innerJoin(
        frames,
        and(
          eq(frames.projectId, projects.id),
          eq(frames.accountId, organizations.ownerAccountId),
        ),
      )
      .leftJoin(linkedClients, eq(linkedClients.id, frames.linkedClientId))
      .innerJoin(accounts, eq(accounts.id, organizations.ownerAccountId))
      .where(and(eq(organizationMembers.accountId, accountId), memberHasProject))
      .orderBy(asc(organizations.name), asc(projects.name), asc(frames.createdAt)),
  ]);

  const result: AccessibleFrame[] = own.map((row) => ({
    access: {
      organization:
        row.organizationId && row.organizationName !== null
          ? { id: row.organizationId, name: row.organizationName }
          : null,
      project:
        row.projectId && row.projectName !== null
          ? { id: row.projectId, name: row.projectName }
          : null,
      role: "owner",
    },
    frame: row.frame,
    linkedClient: row.linkedClient,
  }));
  const limitFor = peopleLimits(db);
  for (const row of shared) {
    if (!isMemberRole(row.role) || row.seat > (await limitFor(row.frame.accountId))) {
      continue;
    }
    result.push({
      access: {
        organization: { id: row.organizationId, name: row.organizationName },
        owner: {
          name: ownerName({
            displayName: row.ownerDisplayName,
            primaryEmail: row.ownerPrimaryEmail,
          }),
        },
        project: { id: row.projectId, name: row.projectName },
        role: row.role,
      },
      frame: row.frame,
      linkedClient: row.linkedClient,
    });
  }
  return result;
}

/**
 * Which of these accounts have which shared frames, for the hub's live
 * events: the pairs (account, frame) where the account is not the frame's
 * owner and may see it now.
 */
export async function sharedFrameViewers(
  db: Database,
  accountIds: readonly string[],
): Promise<{ accountId: string; frameId: string }[]> {
  if (accountIds.length === 0) {
    return [];
  }
  const rows = await db
    .select({
      accountId: organizationMembers.accountId,
      frameId: frames.id,
      ownerAccountId: organizations.ownerAccountId,
      seat: memberSeat,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .innerJoin(projects, eq(projects.organizationId, organizations.id))
    .innerJoin(
      frames,
      and(
        eq(frames.projectId, projects.id),
        eq(frames.accountId, organizations.ownerAccountId),
      ),
    )
    .where(and(inArray(organizationMembers.accountId, [...accountIds]), memberHasProject));
  const limitFor = peopleLimits(db);
  const result: { accountId: string; frameId: string }[] = [];
  for (const row of rows) {
    if (row.seat <= (await limitFor(row.ownerAccountId))) {
      result.push({ accountId: row.accountId, frameId: row.frameId });
    }
  }
  return result;
}

// How many frames one scene is looked for on. A private scene sits on a
// handful; the bound only keeps a public one, installed everywhere, from
// turning one check into a table scan.
const maxFramesPerSceneCheck = 50;

/**
 * May the account read (`view`) or change (`edit`) a private scene because
 * it is on a frame they share? (cloud/docs/sharing.md "Scenes")
 *
 * A private scene on a frame always belongs to the frame's account: the
 * payload builder sends nothing else (frames.ts `scene_private`). So the
 * answer is yes when the scene is on a frame of its own account that the
 * caller may use at that level. A scene whose publisher took it private
 * after other people installed it is on their frames and not theirs, and
 * stays unreadable to them.
 *
 * The scene's own account never comes here; it owns the scene.
 */
export async function sceneReachableThroughFrames(
  db: Database,
  accountId: string,
  scene: { accountId: string; id: string },
  need: "view" | "edit",
): Promise<boolean> {
  const candidates = await db
    .select({ accountId: frames.accountId, id: frames.id })
    .from(frameSceneAssignments)
    .innerJoin(frames, eq(frames.id, frameSceneAssignments.frameId))
    .where(
      and(
        eq(frameSceneAssignments.sceneId, scene.id),
        // The scene's own account's frames, in a project of an organization
        // the caller is in. The seat and the project are checked per frame
        // below.
        eq(frames.accountId, scene.accountId),
        sql`${frames.projectId} in (
          select ${projects.id} from ${projects}
            join ${organizationMembers}
              on ${organizationMembers.organizationId} = ${projects.organizationId}
           where ${organizationMembers.accountId} = ${accountId})`,
      ),
    )
    .limit(maxFramesPerSceneCheck);
  for (const frame of candidates) {
    if (
      frame.accountId === scene.accountId &&
      (await frameAccessForAccount(db, accountId, frame.id, need)) !== undefined
    ) {
      return true;
    }
  }
  return false;
}
