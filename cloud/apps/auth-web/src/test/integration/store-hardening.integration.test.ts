import { strToU8, zipSync } from "fflate";
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  accounts,
  auditEvents,
  createDb,
  storeSceneReports,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PATCH as adminPatchPublisher } from "../../../app/api/admin/publishers/[accountId]/route";
import { PATCH as adminPatchReport } from "../../../app/api/admin/reports/[reportId]/route";
import { POST as editSceneContent } from "../../../app/api/account/scenes/[sceneId]/content/route";
import { PATCH as patchScene } from "../../../app/api/account/scenes/[sceneId]/route";
import { GET as getDriveRepositoryJson } from "../../../app/api/store/account/repository.json/route";
import { POST as publishScene } from "../../../app/api/store/publish/route";
import { GET as getRepositoryJson } from "../../../app/api/store/repository.json/route";
import { GET as downloadScene } from "../../../app/api/store/scenes/[sceneId]/download/route";
import { POST as reportScene } from "../../../app/api/store/scenes/[sceneId]/report/route";
import { POST as authorizeDevice } from "../../../app/api/device/authorize/route";
import { POST as pollDevice } from "../../../app/api/device/poll/route";
import { POST as startDevice } from "../../../app/api/device/start/route";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { createSession, sessionCookieName } from "../../lib/session";

const cookieJar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
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

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  vi.unstubAllGlobals();
});

function request(
  path: string,
  method: string,
  {
    body,
    headers = {},
  }: { body?: Record<string, unknown>; headers?: Record<string, string> } = {},
) {
  return new NextRequest(new URL(path, baseUrl), {
    ...(body ? { body: JSON.stringify(body) } : {}),
    headers: { "content-type": "application/json", ...headers },
    method,
  });
}

async function readJson(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

async function signIn() {
  userCounter += 1;
  const providerSubject = `hardening-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Hardening Tester ${userCounter}`,
    email: `hardening-${userCounter}@example.com`,
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
  cookieJar.set(sessionCookieName, token);
  return accountId;
}

async function linkClient(scopes: string[]) {
  const startResponse = await startDevice(
    request("/api/device/start", "POST", {
      body: {
        local_origin: "http://10.2.2.2:8989",
        public_display_name: "Store Backend",
        scopes,
      },
    }),
  );
  const startPayload = await readJson(startResponse);

  const accountId = await signIn();
  const authorizeResponse = await authorizeDevice(
    request("/api/device/authorize", "POST", {
      body: { user_code: startPayload.user_code },
      headers: { origin: baseUrl },
    }),
  );
  expect(authorizeResponse.status).toBe(200);

  const pollResponse = await pollDevice(
    request("/api/device/poll", "POST", {
      body: { device_code: startPayload.device_code },
    }),
  );
  expect(pollResponse.status).toBe(200);
  const { access_token: accessToken } = await readJson(pollResponse);
  return { accessToken: accessToken as string, accountId };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

function templateZip({
  name = "Sunrise Clock",
  scenes = [{ id: "scene-1", nodes: [] }],
}: {
  name?: string;
  scenes?: unknown[];
} = {}) {
  return Buffer.from(
    zipSync({
      [`${name}/template.json`]: strToU8(
        JSON.stringify({
          description: "A calm sunrise clock",
          image: "./image.jpg",
          imageHeight: 480,
          imageWidth: 800,
          name,
          scenes: "./scenes.json",
        }),
      ),
      [`${name}/scenes.json`]: strToU8(JSON.stringify(scenes)),
      [`${name}/image.jpg`]: new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 9]),
    }),
  );
}

async function publish(
  accessToken: string,
  overrides: Record<string, unknown> = {},
) {
  return publishScene(
    request("/api/store/publish", "POST", {
      body: {
        content_base64: templateZip().toString("base64"),
        name: "Sunrise Clock",
        ...overrides,
      },
      headers: bearer(accessToken),
    }),
  );
}

function ctx<T extends Record<string, string>>(params: T) {
  return { params: Promise.resolve(params) };
}

function moderationFetch(flaggedCategories: string[] = []) {
  const calls: unknown[] = [];
  const fetchStub = vi.fn(async (_url: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(
      JSON.stringify({
        results: [
          {
            categories: Object.fromEntries(
              flaggedCategories.map((category) => [category, true]),
            ),
          },
        ],
      }),
      { headers: { "content-type": "application/json" }, status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetchStub);
  return { calls, fetchStub };
}

const publishScopes = ["backend:link", "store:publish"];

describe("store moderation gate", () => {
  it("classifies text and image at publish and rejects flagged content", async () => {
    const { accessToken, accountId } = await linkClient(publishScopes);
    process.env.OPENAI_API_KEY = "test-key";

    const { calls } = moderationFetch(["sexual"]);
    const rejected = await publish(accessToken);
    expect(rejected.status).toBe(422);
    expect(await readJson(rejected)).toMatchObject({
      categories: ["sexual"],
      error: "content_rejected",
    });

    // Name, description, and the preview image all went to the classifier.
    const sent = calls[0] as { input: { type: string }[] };
    expect(sent.input.map((part) => part.type)).toEqual([
      "text",
      "text",
      "image_url",
    ]);

    // Nothing stored, and the rejection is on the audit trail.
    const repo = await readJson(
      await getRepositoryJson(request("/api/store/repository.json", "GET")),
    );
    expect(repo.templates).toHaveLength(0);
    const [event] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.eventType, "store.publish_rejected"));
    expect(event?.accountId).toBe(accountId);

    // Clean content passes.
    moderationFetch([]);
    const accepted = await publish(accessToken);
    expect(accepted.status).toBe(200);
  });

  it("fails closed when moderation is configured but unreachable", async () => {
    const { accessToken } = await linkClient(publishScopes);
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    );

    const response = await publish(accessToken);
    expect(response.status).toBe(503);
    expect((await readJson(response)).error).toBe("moderation_unavailable");
  });

  it("re-moderates when a scene is made public or its description edited", async () => {
    const { accessToken } = await linkClient(publishScopes);
    const published = await publish(accessToken);
    expect(published.status).toBe(200);
    const scene = (await readJson(published)).scene as { id: string };

    process.env.OPENAI_API_KEY = "test-key";
    moderationFetch(["harassment"]);
    const flip = await patchScene(
      request(`/api/account/scenes/${scene.id}`, "PATCH", {
        body: { visibility: "public" },
        headers: { origin: baseUrl },
      }),
      ctx({ sceneId: scene.id }),
    );
    expect(flip.status).toBe(422);

    moderationFetch([]);
    const flipClean = await patchScene(
      request(`/api/account/scenes/${scene.id}`, "PATCH", {
        body: { visibility: "public" },
        headers: { origin: baseUrl },
      }),
      ctx({ sceneId: scene.id }),
    );
    expect(flipClean.status).toBe(200);

    // The description is published with a version now; the gate is the same.
    moderationFetch(["hate"]);
    const edit = await editSceneContent(
      request(`/api/account/scenes/${scene.id}/content`, "POST", {
        body: { listing: { description: "something vile" } },
        headers: { origin: baseUrl },
      }),
      ctx({ sceneId: scene.id }),
    );
    expect(edit.status).toBe(422);
  });
});

describe("risk flags", () => {
  it("flags scenes that shell out and exposes the flag in the repository", async () => {
    const { accessToken } = await linkClient(publishScopes);

    const shellScenes = [
      {
        id: "scene-1",
        nodes: [
          {
            data: { config: {}, keyword: "data/chromiumScreenshot" },
            id: "n1",
            type: "app",
          },
        ],
      },
    ];
    const published = await publish(accessToken, {
      content_base64: templateZip({ scenes: shellScenes }).toString("base64"),
      visibility: "public",
    });
    expect(published.status).toBe(200);
    const scene = (await readJson(published)).scene as Record<string, unknown>;
    expect(scene.risk_flags).toEqual(["shell"]);

    const repo = await readJson(
      await getRepositoryJson(request("/api/store/repository.json", "GET")),
    );
    expect(
      (repo.templates as Record<string, unknown>[])[0]?.flags,
    ).toEqual(["shell"]);

    // Code nodes calling process APIs are flagged too.
    const codeScenes = [
      {
        id: "scene-1",
        nodes: [
          // A JavaScript code node: a Nim one (data.code, no codeJS) is a
          // legacy compiled scene and is refused before it can be flagged.
          { data: { codeJS: 'execShellCmd("rm -rf /")' }, id: "n1", type: "code" },
        ],
      },
    ];
    const codePublished = await publish(accessToken, {
      content_base64: templateZip({ name: "Coder", scenes: codeScenes }).toString(
        "base64",
      ),
      name: "Coder",
    });
    expect(codePublished.status).toBe(200);
    const codeScene = (await readJson(codePublished)).scene as Record<
      string,
      unknown
    >;
    expect(codeScene.risk_flags).toEqual(["shell"]);

    // Plain scenes stay unflagged.
    const plain = await publish(accessToken, { name: "Plain" });
    expect(
      ((await readJson(plain)).scene as Record<string, unknown>).risk_flags,
    ).toEqual([]);
  });

  it("refuses legacy compiled scenes and names the converter", async () => {
    const { accessToken } = await linkClient(publishScopes);
    const nimScenes = [
      {
        id: "scene-1",
        name: "Old timer",
        nodes: [{ data: { code: 'state{"a"}.getStr' }, id: "n1", type: "code" }],
      },
    ];
    const refused = await publish(accessToken, {
      content_base64: templateZip({ name: "Nim", scenes: nimScenes }).toString("base64"),
      name: "Nim",
    });
    expect(refused.status).toBe(400);
    const body = await readJson(refused);
    expect(body.error).toBe("scene_requires_compilation");
    expect(body.scenes).toEqual(["Old timer"]);
    expect(String(body.hint)).toContain("/nim-converter");
  });
});

describe("publish bans", () => {
  it("banned publishers cannot publish until unbanned", async () => {
    const { accessToken, accountId } = await linkClient(publishScopes);

    const adminId = await signIn();
    await db
      .update(accounts)
      .set({ isSuperadmin: true })
      .where(eq(accounts.id, adminId));

    const ban = await adminPatchPublisher(
      request(`/api/admin/publishers/${accountId}`, "PATCH", {
        body: { reason: "spamming the store", store_banned: true },
        headers: { origin: baseUrl },
      }),
      ctx({ accountId }),
    );
    expect(ban.status).toBe(200);

    const rejected = await publish(accessToken);
    expect(rejected.status).toBe(403);
    expect((await readJson(rejected)).error).toBe("store_banned");

    const unban = await adminPatchPublisher(
      request(`/api/admin/publishers/${accountId}`, "PATCH", {
        body: { store_banned: false },
        headers: { origin: baseUrl },
      }),
      ctx({ accountId }),
    );
    expect(unban.status).toBe(200);
    expect((await publish(accessToken)).status).toBe(200);
  });

  it("requires a superadmin", async () => {
    const { accountId } = await linkClient(publishScopes);
    const response = await adminPatchPublisher(
      request(`/api/admin/publishers/${accountId}`, "PATCH", {
        body: { store_banned: true },
        headers: { origin: baseUrl },
      }),
      ctx({ accountId }),
    );
    expect(response.status).toBe(403);
  });
});

describe("scene reports", () => {
  it("signed-in users report once; superadmins resolve from the queue", async () => {
    const { accessToken } = await linkClient(publishScopes);
    const published = await publish(accessToken, { visibility: "public" });
    const scene = (await readJson(published)).scene as { id: string };

    await signIn(); // the reporter, a different account
    const reported = await reportScene(
      request(`/api/store/scenes/${scene.id}/report`, "POST", {
        body: { reason: "This scene looks malicious" },
        headers: { origin: baseUrl },
      }),
      ctx({ sceneId: scene.id }),
    );
    expect(reported.status).toBe(200);
    expect((await readJson(reported)).status).toBe("reported");

    const again = await reportScene(
      request(`/api/store/scenes/${scene.id}/report`, "POST", {
        body: { reason: "Still malicious" },
        headers: { origin: baseUrl },
      }),
      ctx({ sceneId: scene.id }),
    );
    expect((await readJson(again)).status).toBe("already_reported");

    const [report] = await db.select().from(storeSceneReports);
    expect(report?.status).toBe("open");

    const adminId = await signIn();
    await db
      .update(accounts)
      .set({ isSuperadmin: true })
      .where(eq(accounts.id, adminId));
    const resolved = await adminPatchReport(
      request(`/api/admin/reports/${report!.id}`, "PATCH", {
        body: { status: "resolved" },
        headers: { origin: baseUrl },
      }),
      ctx({ reportId: report!.id }),
    );
    expect(resolved.status).toBe(200);
    const [after] = await db.select().from(storeSceneReports);
    expect(after?.status).toBe("resolved");
    expect(after?.resolvedByAccountId).toBe(adminId);
  });

  it("rejects reports on private scenes and from signed-out visitors", async () => {
    const { accessToken } = await linkClient(publishScopes);
    const published = await publish(accessToken);
    const scene = (await readJson(published)).scene as { id: string };

    // Signed in (the owner) but the scene is private → invisible to reports.
    const privateReport = await reportScene(
      request(`/api/store/scenes/${scene.id}/report`, "POST", {
        body: { reason: "reporting my own private scene" },
        headers: { origin: baseUrl },
      }),
      ctx({ sceneId: scene.id }),
    );
    expect(privateReport.status).toBe(404);

    cookieJar.clear();
    const anonymous = await reportScene(
      request(`/api/store/scenes/${scene.id}/report`, "POST", {
        body: { reason: "anonymous" },
        headers: { origin: baseUrl },
      }),
      ctx({ sceneId: scene.id }),
    );
    expect(anonymous.status).toBe(401);
  });
});

describe("my cloud drive", () => {
  it("lists private scenes for the linked client and serves their zips", async () => {
    const { accessToken } = await linkClient(publishScopes);
    const published = await publish(accessToken);
    const scene = (await readJson(published)).scene as { id: string };
    cookieJar.clear(); // everything below authenticates with the link token

    const drive = await getDriveRepositoryJson(
      request("/api/store/account/repository.json", "GET", {
        headers: bearer(accessToken),
      }),
    );
    expect(drive.status).toBe(200);
    const payload = await readJson(drive);
    expect(payload.name).toBe("My cloud drive");
    const templates = payload.templates as Record<string, unknown>[];
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({
      sceneId: scene.id,
      visibility: "private",
      zip: `${baseUrl}/api/store/scenes/${scene.id}/download`,
    });

    // The private zip downloads with the link token attached.
    const download = await downloadScene(
      request(`/api/store/scenes/${scene.id}/download`, "GET", {
        headers: bearer(accessToken),
      }),
      ctx({ sceneId: scene.id }),
    );
    expect(download.status).toBe(200);

    // ...and stays hidden without it.
    const anonymous = await downloadScene(
      request(`/api/store/scenes/${scene.id}/download`, "GET"),
      ctx({ sceneId: scene.id }),
    );
    expect(anonymous.status).toBe(404);
  });

  it("requires the store scope", async () => {
    const { accessToken } = await linkClient(["backend:link"]);
    const drive = await getDriveRepositoryJson(
      request("/api/store/account/repository.json", "GET", {
        headers: bearer(accessToken),
      }),
    );
    expect(drive.status).toBe(403);
  });
});

describe("publish limits", () => {
  it("caps new scene creation per day", async () => {
    const { accessToken } = await linkClient(publishScopes);
    for (let index = 0; index < 20; index += 1) {
      const response = await publish(accessToken, { name: `Scene ${index}` });
      expect(response.status).toBe(200);
    }
    const overflow = await publish(accessToken, { name: "One too many" });
    expect(overflow.status).toBe(429);
    expect((await readJson(overflow)).error).toBe(
      "daily_scene_limit_exceeded",
    );

    // Re-publishing an existing scene is not throttled by the daily cap.
    const republish = await publish(accessToken, { name: "Scene 0" });
    expect(republish.status).toBe(200);
  });
});
