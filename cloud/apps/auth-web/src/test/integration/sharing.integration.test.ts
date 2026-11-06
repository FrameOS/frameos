// Sharing frames with the people on a plan (cloud/docs/sharing.md): the
// organization routes, and what a person who is not the owner can and cannot
// do with a frame, a scene on it and its activity trail.
import { generateKeyPairSync } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { zipSync } from "fflate";
import { NextRequest } from "next/server";
import {
  auditEvents,
  billingPlans,
  createDb,
  frames,
  frameSceneAssignments,
  linkedClients,
  organizationInvitations,
  organizationMembers,
  storeScenes,
  storeSceneVersions,
  subscriptions,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as createScene } from "../../../app/api/account/scenes/route";
import { POST as saveSceneContent } from "../../../app/api/account/scenes/[sceneId]/content/route";
import { GET as getFrameActivity } from "../../../app/api/frames/[frameId]/activity/route";
import { POST as sendCommand } from "../../../app/api/frames/[frameId]/command/route";
import {
  DELETE as deleteFrame,
  GET as getFrame,
  POST as renameFrame,
} from "../../../app/api/frames/[frameId]/route";
import {
  GET as listFrameScenes,
  POST as assignFrameScenes,
} from "../../../app/api/frames/[frameId]/scenes/route";
import { POST as setServiceSettings } from "../../../app/api/frames/[frameId]/service-settings/enabled/route";
import { GET as listFrames } from "../../../app/api/frames/route";
import { DELETE as revokeInvitationRoute } from "../../../app/api/organization/invitations/[invitationId]/route";
import { POST as invite } from "../../../app/api/organization/invitations/route";
import { POST as join } from "../../../app/api/organization/join/route";
import {
  DELETE as removeMemberRoute,
  PATCH as changeMember,
} from "../../../app/api/organization/members/[memberId]/route";
import {
  DELETE as deleteProjectRoute,
  PATCH as changeProject,
} from "../../../app/api/organization/projects/[projectId]/route";
import { POST as createProjectRoute } from "../../../app/api/organization/projects/route";
import { GET as getOrganization, PATCH as renameOrganizationRoute } from "../../../app/api/organization/route";
import { GET as getScenesJson } from "../../../app/api/store/scenes/[sceneId]/scenes.json/route";
import { sharedFrameViewers } from "../../lib/organizations";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { hashSecret } from "../../lib/secrets";
import { createSession, sessionCookieName } from "../../lib/session";

const cookieJar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9" }),
}));

const baseUrl = "http://localhost:3000";
const issuer = "https://accounts.google.com";
const db = createDb();
let userCounter = 0;

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
});

beforeEach(async () => {
  resetRateLimitForTests();
  cookieJar.clear();
  const tables = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  const names = tables
    .map((row) => row.tablename)
    .filter((name) => name !== "schema_migrations")
    .map((name) => `"${name}"`);
  if (names.length > 0) {
    await db.execute(sql.raw(`TRUNCATE TABLE ${names.join(", ")} CASCADE`));
  }
});

type Person = { accountId: string; email: string; token: string };

async function person(name: string): Promise<Person> {
  userCounter += 1;
  const providerSubject = `sharing-user-${userCounter}`;
  const email = `${name}-${userCounter}@example.com`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: name,
    email,
    emailVerified: true,
    providerIssuer: issuer,
    providerKey: "google",
    providerSubject,
  });
  const token = await createSession(db, {
    accountId,
    providerIssuer: issuer,
    providerSubject,
  });
  return { accountId, email, token };
}

/** Every request after this is that person's. */
function as(who: Person) {
  cookieJar.set(sessionCookieName, who.token);
}

// A paid plan: the stop's people, and nothing else of interest here.
async function plan(owner: Person, people: number) {
  const code = `private-${people}`;
  await db
    .insert(billingPlans)
    .values({
      code,
      entitlements: { frames: 40, people },
      marginBasisPoints: 10_000,
      name: "Private",
      priceMicros: BigInt(people) * 1_000_000n,
    })
    .onConflictDoNothing();
  await db
    .insert(subscriptions)
    .values({ accountId: owner.accountId, planCode: code })
    .onConflictDoUpdate({ set: { planCode: code }, target: subscriptions.accountId });
}

const frameParams = (frameId: string) => ({ params: Promise.resolve({ frameId }) });

function get(path: string) {
  return new NextRequest(new URL(path, baseUrl), { method: "GET" });
}

function send(method: string, path: string, body?: Record<string, unknown>) {
  return new NextRequest(new URL(path, baseUrl), {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { "content-type": "application/json", origin: baseUrl },
    method,
  });
}

function rawPublicKeyBase64() {
  const { publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(spki.length - 32)).toString("base64");
}

async function activeFrame(owner: Person, name: string) {
  const [client] = await db
    .insert(linkedClients)
    .values({
      accountId: owner.accountId,
      clientKind: "frame",
      providerClientMetadata: { requestedScopes: ["frame:managed"] },
      publicDisplayName: name,
      tokenReference: hashSecret(`fc_link_sharing_${owner.accountId}_${name}`),
    })
    .returning();
  const [frame] = await db
    .insert(frames)
    .values({
      accountId: owner.accountId,
      connected: true,
      frameosVersion: "2026.10.20",
      hardware: { height: 480, platform: "pi-zero2w", width: 800 },
      linkedClientId: client!.id,
      name,
      publicKey: rawPublicKeyBase64(),
      status: "active",
    })
    .returning();
  return frame!;
}

function sceneJson(runtimeId: string, name: string) {
  return [{ edges: [], id: runtimeId, name, nodes: [] }];
}

async function privateScene(owner: Person, name: string) {
  const [scene] = await db
    .insert(storeScenes)
    .values({
      accountId: owner.accountId,
      latestVersion: 1,
      name,
      riskFlags: [],
      slug: `sharing-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`,
      status: "active",
      visibility: "private",
    })
    .returning();
  await db.insert(storeSceneVersions).values({
    content: Buffer.from(
      zipSync({
        "scene/scenes.json": new TextEncoder().encode(JSON.stringify(sceneJson(`rt-${name}`, name))),
        "scene/template.json": new TextEncoder().encode(JSON.stringify({ name, scenes: "./scenes.json" })),
      }),
    ),
    contentType: "application/zip",
    riskFlags: [],
    sceneId: scene!.id,
    sha256: `sharing-${scene!.id}`,
    sizeBytes: 1000,
    version: 1,
  });
  return scene!;
}

type OrganizationBody = {
  memberships: {
    active: boolean;
    member_id: string;
    organization: { id: string; name: string };
    projects: { frame_count: number; id: string; name: string }[];
    role: string;
  }[];
  organization: {
    frames: { id: string; name: string; project_id: string | null }[];
    id: string;
    invitations: { email: string; id: string }[];
    members: { active: boolean; email: string; id: string; role: string; you: boolean }[];
    name: string;
    people: { limit: number; used: number };
    projects: { frame_ids: string[]; id: string; member_ids: string[]; name: string }[];
    role: string;
  };
};

async function organization(query = "") {
  const response = await getOrganization(get(`/api/organization${query}`));
  return { body: (await response.json()) as OrganizationBody, response };
}

async function newProject(name: string, organizationId?: string) {
  const response = await createProjectRoute(
    send("POST", "/api/organization/projects", {
      name,
      ...(organizationId ? { organization_id: organizationId } : {}),
    }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { project: { id: string } }).project.id;
}

async function setProject(projectId: string, body: Record<string, unknown>) {
  return changeProject(send("PATCH", `/api/organization/projects/${projectId}`, body), {
    params: Promise.resolve({ projectId }),
  });
}

/** Invite as whoever is signed in; the token is the link's. */
async function invitation(email: string, body: Record<string, unknown> = {}) {
  const response = await invite(send("POST", "/api/organization/invitations", { email, ...body }));
  const payload = (await response.json()) as {
    error?: string;
    invitation?: { id: string };
    url?: string;
  };
  return {
    id: payload.invitation?.id,
    payload,
    response,
    token: payload.url ? new URL(payload.url).searchParams.get("invite")! : "",
  };
}

async function accept(token: string) {
  return join(send("POST", "/api/organization/join", { accept: true, token }));
}

/** Owner on a plan of `people`, one frame in a project, one member in it. */
async function sharedFrame(people = 3) {
  const owner = await person("Olive");
  const member = await person("Milo");
  await plan(owner, people);
  const frame = await activeFrame(owner, "Kitchen");
  as(owner);
  const projectId = await newProject("Home");
  expect((await setProject(projectId, { frame_ids: [frame.id] })).status).toBe(200);
  const invited = await invitation(member.email, { project_ids: [projectId] });
  expect(invited.response.status).toBe(201);
  as(member);
  expect((await accept(invited.token)).status).toBe(200);
  const [row] = await db
    .select()
    .from(organizationMembers)
    .where(eq(organizationMembers.accountId, member.accountId));
  return { frame, member, memberId: row!.id, owner, projectId };
}

async function frameIds() {
  const response = await listFrames(get("/api/frames"));
  const body = (await response.json()) as {
    frames: { access: { owner_name?: string; project: { name: string } | null; role: string }; id: string }[];
  };
  return body.frames;
}

describe("the plan's people", () => {
  it("is one on the free plan: an organization and projects exist, an invitation does not", async () => {
    const owner = await person("Olive");
    as(owner);
    const { body } = await organization();
    expect(body.organization.name).toBe("Olive");
    expect(body.organization.role).toBe("owner");
    expect(body.organization.people).toEqual({ limit: 1, used: 1 });
    // The same organization the second time.
    expect((await organization()).body.organization.id).toBe(body.organization.id);

    await newProject("Home");
    const refused = await invitation("friend@example.com");
    expect(refused.response.status).toBe(403);
    expect(refused.payload).toMatchObject({ error: "people_limit", limit: 1, used: 1 });
  });

  it("counts open invitations, and frees a seat when one is taken back", async () => {
    const owner = await person("Olive");
    await plan(owner, 2);
    as(owner);
    const first = await invitation("first@example.com");
    expect(first.response.status).toBe(201);
    expect(first.payload.url).toContain("/account/people?invite=FOINV_");
    // Only the hash is stored.
    const [stored] = await db.select().from(organizationInvitations);
    expect(stored!.tokenHash).toBe(hashSecret(first.token));

    expect((await invitation("second@example.com")).payload.error).toBe("people_limit");
    expect((await invitation("FIRST@example.com")).payload.error).toBe("already_invited");
    expect((await organization()).body.organization.people).toEqual({ limit: 2, used: 2 });

    const revoked = await revokeInvitationRoute(
      send("DELETE", `/api/organization/invitations/${first.id}`),
      { params: Promise.resolve({ invitationId: first.id! }) },
    );
    expect(revoked.status).toBe(200);
    expect((await invitation("second@example.com")).response.status).toBe(201);

    // The link that was taken back is dead.
    const late = await person("Late");
    as(late);
    const refused = await accept(first.token);
    expect(refused.status).toBe(410);
    expect(((await refused.json()) as { error: string }).error).toBe("invitation_revoked");
  });

  it("takes a link once, and never from the owner", async () => {
    const owner = await person("Olive");
    await plan(owner, 5);
    as(owner);
    const invited = await invitation("milo@example.com");
    const own = await accept(invited.token);
    expect(own.status).toBe(409);

    const milo = await person("Milo");
    as(milo);
    const preview = await join(send("POST", "/api/organization/join", { token: invited.token }));
    expect(((await preview.json()) as { invitation: Record<string, unknown> }).invitation).toMatchObject({
      already_member: false,
      organization: { name: "Olive" },
      owner_name: "Olive",
      role: "member",
      state: "open",
    });
    expect((await accept(invited.token)).status).toBe(200);
    // Again by the same person: where they already are.
    expect((await accept(invited.token)).status).toBe(200);
    expect(await db.select().from(organizationMembers)).toHaveLength(1);

    const other = await person("Other");
    as(other);
    expect((await accept(invited.token)).status).toBe(410);
    expect((await accept("FOINV_nope")).status).toBe(404);
  });
});

describe("a frame shared through a project", () => {
  it("is the member's to see and change, with the owner's switches left to the owner", async () => {
    const { frame, member, owner } = await sharedFrame();
    const other = await activeFrame(owner, "Office");

    as(member);
    const listed = await frameIds();
    expect(listed.map((entry) => entry.id)).toEqual([frame.id]);
    expect(listed[0]!.access).toMatchObject({
      owner_name: "Olive",
      project: { name: "Home" },
      role: "member",
    });

    const detail = await getFrame(get(`/api/frames/${frame.id}`), frameParams(frame.id));
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { frame: { access: { role: string } } }).frame.access.role).toBe("member");

    // Edit: rename, commands.
    const renamed = await renameFrame(
      send("POST", `/api/frames/${frame.id}`, { name: "Kitchen wall" }),
      frameParams(frame.id),
    );
    expect(renamed.status).toBe(200);
    const command = await sendCommand(
      send("POST", `/api/frames/${frame.id}/command`, { type: "render" }),
      frameParams(frame.id),
    );
    expect(command.status).toBe(200);

    // Manage and owner: a frame the member may not do that to is not there.
    const keys = await setServiceSettings(
      send("POST", `/api/frames/${frame.id}/service-settings/enabled`, { enabled: true }),
      frameParams(frame.id),
    );
    expect(keys.status).toBe(404);
    const removed = await deleteFrame(send("DELETE", `/api/frames/${frame.id}`), frameParams(frame.id));
    expect([401, 403, 404]).toContain(removed.status);
    expect(await db.select().from(frames).where(eq(frames.id, frame.id))).toHaveLength(1);

    // The owner's other frame is in no project.
    expect((await getFrame(get(`/api/frames/${other.id}`), frameParams(other.id))).status).toBe(404);

    // The owner sees both, and which is shared.
    as(owner);
    const owned = await frameIds();
    expect(owned.map((entry) => [entry.id, entry.access.role, entry.access.project?.name ?? null])).toEqual([
      [frame.id, "owner", "Home"],
      [other.id, "owner", null],
    ]);
  });

  it("writes the trail on the owner's account, naming who acted", async () => {
    const { frame, member, owner } = await sharedFrame();
    as(member);
    await renameFrame(
      send("POST", `/api/frames/${frame.id}`, { name: "Kitchen wall" }),
      frameParams(frame.id),
    );
    const rows = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.eventType, "frame.renamed"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.accountId).toBe(owner.accountId);
    expect(rows[0]!.actor).toMatchObject({ accountId: member.accountId });

    type Activity = { events: { actor: { email?: string; ip?: string }; event_type: string }[] };
    as(owner);
    await renameFrame(send("POST", `/api/frames/${frame.id}`, { name: "Kitchen" }), frameParams(frame.id));
    const forOwner = (await (
      await getFrameActivity(get(`/api/frames/${frame.id}/activity`), frameParams(frame.id))
    ).json()) as Activity;
    const renames = forOwner.events.filter((event) => event.event_type === "frame.renamed");
    expect(renames.map((event) => event.actor.email)).toEqual([owner.email, member.email]);
    expect(renames.every((event) => event.actor.ip === "203.0.113.9")).toBe(true);

    // The member reads the same trail, with an address on their own rows only.
    as(member);
    const forMember = (await (
      await getFrameActivity(get(`/api/frames/${frame.id}/activity`), frameParams(frame.id))
    ).json()) as Activity;
    const seen = forMember.events.filter((event) => event.event_type === "frame.renamed");
    expect(seen.map((event) => [event.actor.email, event.actor.ip ?? null])).toEqual([
      [owner.email, null],
      [member.email, "203.0.113.9"],
    ]);
  });

  it("ends with the membership, the project or the frame's place in it", async () => {
    const { frame, member, memberId, owner, projectId } = await sharedFrame();
    const visible = async () => {
      as(member);
      return (await getFrame(get(`/api/frames/${frame.id}`), frameParams(frame.id))).status;
    };
    expect(await visible()).toBe(200);

    // Out of the project: the owner's alone.
    as(owner);
    await setProject(projectId, { frame_ids: [] });
    expect(await visible()).toBe(404);
    as(owner);
    await setProject(projectId, { frame_ids: [frame.id] });
    expect(await visible()).toBe(200);

    // Out of the project's people.
    as(owner);
    await setProject(projectId, { member_ids: [] });
    expect(await visible()).toBe(404);
    as(owner);
    await setProject(projectId, { member_ids: [memberId] });
    expect(await visible()).toBe(200);

    // The project deleted: the frame stays, shared with nobody.
    as(owner);
    await deleteProjectRoute(send("DELETE", `/api/organization/projects/${projectId}`), {
      params: Promise.resolve({ projectId }),
    });
    expect(await visible()).toBe(404);
    const [row] = await db.select().from(frames).where(eq(frames.id, frame.id));
    expect(row!.projectId).toBeNull();
  });

  it("lets a member leave, and the owner remove one", async () => {
    const { frame, member, memberId, owner } = await sharedFrame();
    as(member);
    const left = await removeMemberRoute(send("DELETE", `/api/organization/members/${memberId}`), {
      params: Promise.resolve({ memberId }),
    });
    expect(((await left.json()) as { status: string }).status).toBe("left");
    expect((await getFrame(get(`/api/frames/${frame.id}`), frameParams(frame.id))).status).toBe(404);
    expect(await sharedFrameViewers(db, [member.accountId])).toEqual([]);

    as(owner);
    const again = await invitation(member.email);
    as(member);
    await accept(again.token);
    const [row] = await db.select().from(organizationMembers);
    as(owner);
    const removed = await removeMemberRoute(send("DELETE", `/api/organization/members/${row!.id}`), {
      params: Promise.resolve({ memberId: row!.id }),
    });
    expect(((await removed.json()) as { status: string }).status).toBe("removed");
    expect(await db.select().from(organizationMembers)).toHaveLength(0);
  });
});

describe("seats", () => {
  it("go in joining order when the plan shrinks, and come back when it grows", async () => {
    const { frame, member, owner, projectId } = await sharedFrame(3);
    const second = await person("Sam");
    as(owner);
    const invited = await invitation(second.email, { project_ids: [projectId] });
    as(second);
    expect((await accept(invited.token)).status).toBe(200);
    const sees = async (who: Person) => {
      as(who);
      return (await getFrame(get(`/api/frames/${frame.id}`), frameParams(frame.id))).status;
    };
    expect([await sees(member), await sees(second)]).toEqual([200, 200]);
    expect(
      (await sharedFrameViewers(db, [member.accountId, second.accountId])).map((pair) => pair.accountId).sort(),
    ).toEqual([member.accountId, second.accountId].sort());

    // Two people: the owner and whoever joined first.
    await plan(owner, 2);
    expect([await sees(member), await sees(second)]).toEqual([200, 404]);
    expect(await sharedFrameViewers(db, [member.accountId, second.accountId])).toEqual([
      { accountId: member.accountId, frameId: frame.id },
    ]);
    as(owner);
    const { body } = await organization();
    expect(body.organization.members.map((entry) => entry.active)).toEqual([true, false]);
    expect(body.organization.people).toEqual({ limit: 2, used: 3 });
    as(second);
    expect((await organization()).body.memberships[0]).toMatchObject({ active: false });
    expect(await frameIds()).toEqual([]);

    // Free: nobody but the owner. Nothing was deleted.
    await db.delete(subscriptions).where(eq(subscriptions.accountId, owner.accountId));
    expect([await sees(member), await sees(second)]).toEqual([404, 404]);
    expect(await db.select().from(organizationMembers)).toHaveLength(2);

    await plan(owner, 3);
    expect([await sees(member), await sees(second)]).toEqual([200, 200]);
  });
});

describe("roles", () => {
  it("lets an admin manage people, projects and the frame's switches, and not the owner's things", async () => {
    const { frame, member, memberId, owner, projectId } = await sharedFrame(5);
    as(member);
    // A member manages nothing.
    const { body: own } = await organization();
    const organizationId = (await db.select().from(organizationMembers))[0]!.organizationId;
    expect(own.organization.id).not.toBe(organizationId);
    expect((await organization(`?organization_id=${organizationId}`)).response.status).toBe(404);
    expect((await setProject(projectId, { name: "Mine" })).status).toBe(404);

    as(owner);
    const promoted = await changeMember(send("PATCH", `/api/organization/members/${memberId}`, { role: "admin" }), {
      params: Promise.resolve({ memberId }),
    });
    expect(promoted.status).toBe(200);
    const unshared = await activeFrame(owner, "Office");

    as(member);
    const managed = await organization(`?organization_id=${organizationId}`);
    expect(managed.response.status).toBe(200);
    expect(managed.body.organization.role).toBe("admin");
    // The owner's frames that are shared, never the others.
    expect(managed.body.organization.frames.map((entry) => entry.id)).toEqual([frame.id]);

    // The frame's switches.
    const keys = await setServiceSettings(
      send("POST", `/api/frames/${frame.id}/service-settings/enabled`, { enabled: true }),
      frameParams(frame.id),
    );
    expect(keys.status).toBe(200);
    // Every project, without being in it.
    const second = await newProject("Office", organizationId);
    expect((await setProject(second, { frame_ids: [frame.id] })).status).toBe(200);
    expect((await getFrame(get(`/api/frames/${frame.id}`), frameParams(frame.id))).status).toBe(200);
    // Not a frame the owner never shared.
    expect((await setProject(second, { frame_ids: [frame.id, unshared.id] })).status).toBe(400);

    // People: a member, never another admin.
    const invited = await invite(
      send("POST", "/api/organization/invitations", {
        email: "new@example.com",
        organization_id: organizationId,
      }),
    );
    expect(invited.status).toBe(201);
    const asAdmin = await invite(
      send("POST", "/api/organization/invitations", {
        email: "boss@example.com",
        organization_id: organizationId,
        role: "admin",
      }),
    );
    expect(asAdmin.status).toBe(403);
    const demote = await changeMember(send("PATCH", `/api/organization/members/${memberId}`, { role: "member" }), {
      params: Promise.resolve({ memberId }),
    });
    expect(demote.status).toBe(403);

    // Still not the owner: the frame cannot be deleted from here.
    const removed = await deleteFrame(send("DELETE", `/api/frames/${frame.id}`), frameParams(frame.id));
    expect(removed.status).not.toBe(200);
    expect(await db.select().from(frames).where(eq(frames.id, frame.id))).toHaveLength(1);

    // The rename is the owner's organization, in the owner's trail.
    const renamed = await renameOrganizationRoute(
      send("PATCH", "/api/organization", { name: "The Olives", organization_id: organizationId }),
    );
    expect(renamed.status).toBe(200);
    const trail = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.eventType, "organization.renamed"));
    expect(trail[0]).toMatchObject({ accountId: owner.accountId });
  });
});

describe("scenes on a shared frame", () => {
  async function scenesJson(sceneId: string) {
    return getScenesJson(get(`/api/store/scenes/${sceneId}/scenes.json`), {
      params: Promise.resolve({ sceneId }),
    });
  }

  async function assign(frameId: string, scenes: Record<string, unknown>[]) {
    return assignFrameScenes(send("POST", `/api/frames/${frameId}/scenes`, { scenes }), frameParams(frameId));
  }

  it("are read by everyone who shares the frame, and by nobody else", async () => {
    const { frame, member, owner } = await sharedFrame();
    const onFrame = await privateScene(owner, "Clock");
    const elsewhere = await privateScene(owner, "Diary");
    as(owner);
    expect((await assign(frame.id, [{ scene_id: onFrame.id }])).status).toBe(200);

    as(member);
    expect((await scenesJson(onFrame.id)).status).toBe(200);
    expect((await scenesJson(elsewhere.id)).status).toBe(404);
    const listing = (await (
      await listFrameScenes(get(`/api/frames/${frame.id}/scenes`), frameParams(frame.id))
    ).json()) as { scenes: { scene_id: string }[] };
    expect(listing.scenes.map((scene) => scene.scene_id)).toEqual([onFrame.id]);

    const stranger = await person("Stranger");
    as(stranger);
    expect((await scenesJson(onFrame.id)).status).toBe(404);
  });

  it("are saved into the owner's account, by whoever edits them", async () => {
    const { frame, member, owner } = await sharedFrame();
    const clock = await privateScene(owner, "Clock");
    const diary = await privateScene(owner, "Diary");
    as(owner);
    await assign(frame.id, [{ scene_id: clock.id }]);

    as(member);
    const content = (sceneId: string, body: Record<string, unknown>) =>
      saveSceneContent(send("POST", `/api/account/scenes/${sceneId}/content`, body), {
        params: Promise.resolve({ sceneId }),
      });
    // The scene the frame runs: its content, not its page.
    const saved = await content(clock.id, { scenes: sceneJson("rt-Clock", "Clock, edited") });
    expect(saved.status).toBe(200);
    expect((await content(clock.id, { listing: { description: "mine now" } })).status).toBe(403);
    // Not a scene of the owner's that is on no shared frame.
    expect((await content(diary.id, { scenes: sceneJson("rt-Diary", "Diary") })).status).toBe(404);
    const [version] = await db
      .select({ latestVersion: storeScenes.latestVersion })
      .from(storeScenes)
      .where(eq(storeScenes.id, clock.id));
    expect(version!.latestVersion).toBe(2);

    // A scene built on the frame is the owner's, and the member's to install.
    const created = await createScene(
      send("POST", "/api/account/scenes", {
        frame_id: frame.id,
        name: "Weather",
        scenes: sceneJson("rt-weather", "Weather"),
      }),
    );
    expect(created.status).toBeLessThan(300);
    const newId = ((await created.json()) as { scene: { id: string } }).scene.id;
    const [row] = await db.select().from(storeScenes).where(eq(storeScenes.id, newId));
    expect(row).toMatchObject({
      accountId: owner.accountId,
      createdByAccountId: member.accountId,
      visibility: "private",
    });
    const pushed = await assign(frame.id, [
      { latest: true, scene_id: clock.id },
      { scene_id: newId },
    ]);
    expect(pushed.status).toBe(200);
    // A scene of the owner's the member has never been shown stays out.
    expect((await assign(frame.id, [{ scene_id: clock.id }, { scene_id: diary.id }])).status).toBe(400);

    // Not for a frame that is not shared with them.
    const other = await activeFrame(owner, "Office");
    const refused = await createScene(
      send("POST", "/api/account/scenes", {
        frame_id: other.id,
        name: "Nope",
        scenes: sceneJson("rt-nope", "Nope"),
      }),
    );
    expect(refused.status).toBe(404);
  });

  it("are the frame's account's: a member's own private scene does not go on", async () => {
    const { frame, member, owner } = await sharedFrame();
    const mine = await privateScene(member, "Milo's");
    as(member);
    const refused = await assign(frame.id, [{ scene_id: mine.id }]);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe("scene_private");
    expect(await db.select().from(frameSceneAssignments)).toHaveLength(0);

    // Public, it is anyone's to install.
    await db.update(storeScenes).set({ visibility: "public" }).where(eq(storeScenes.id, mine.id));
    expect((await assign(frame.id, [{ scene_id: mine.id }])).status).toBe(200);
    // Taken private again it is on the frame and not the frame's: the owner
    // cannot read it for having it.
    await db.update(storeScenes).set({ visibility: "private" }).where(eq(storeScenes.id, mine.id));
    as(owner);
    expect((await scenesJson(mine.id)).status).toBe(404);
  });
});
