import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createDb,
  storeScenes,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import HomePage from "../../../app/page";
import { GET as getBrowse } from "../../../app/api/store/browse/route";
import { GET as getRepositoryJson } from "../../../app/api/store/repository.json/route";
import { GET as getVersionedRepositoryJson } from "../../../app/api/store/[frameosVersion]/repository.json/route";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { storePageSize } from "../../lib/store-filters";

// Cookie-less: every case here is the anonymous store front.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

const baseUrl = "http://localhost:3000";
const issuer = "https://accounts.google.com";
const db = createDb();

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
});

beforeEach(async () => {
  resetRateLimitForTests();
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

function request(path: string) {
  return new NextRequest(new URL(path, baseUrl), { method: "GET" });
}

async function readJson(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

async function seedPublisher() {
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: "Version Tester",
    email: "versions@example.com",
    emailVerified: true,
    providerIssuer: issuer,
    providerKey: "google",
    providerSubject: "store-browse-publisher",
  });
  return accountId;
}

async function seedScene(
  accountId: string,
  scene: {
    downloadCount?: number;
    frameosVersion?: string | null;
    name: string;
    tags?: string[];
  },
) {
  const [row] = await db
    .insert(storeScenes)
    .values({
      accountId,
      downloadCount: scene.downloadCount ?? 0,
      frameosVersion: scene.frameosVersion ?? null,
      latestVersion: 1,
      name: scene.name,
      slug: scene.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      status: "active",
      tags: scene.tags ?? [],
      visibility: "public",
    })
    .returning({ id: storeScenes.id, slug: storeScenes.slug });
  return row!;
}

function templateNames(payload: Record<string, unknown>) {
  return (payload.templates as { name: string }[]).map(
    (template) => template.name,
  );
}

describe("store repository indexes", () => {
  it("serves only scenes an install of that version can run", async () => {
    const accountId = await seedPublisher();
    await seedScene(accountId, { frameosVersion: "2026.9.0", name: "Nine" });
    // Lexicographically "2026.10.0" < "2026.9.0" — the case a string
    // comparison gets wrong.
    await seedScene(accountId, { frameosVersion: "2026.10.0", name: "Ten" });
    await seedScene(accountId, { frameosVersion: null, name: "Undeclared" });
    await seedScene(accountId, { frameosVersion: "nightly", name: "Nightly" });

    const nine = await readJson(
      await getVersionedRepositoryJson(
        request("/api/store/2026.9.0/repository.json"),
        { params: Promise.resolve({ frameosVersion: "2026.9.0" }) },
      ),
    );
    expect(templateNames(nine).sort()).toEqual([
      "Nightly",
      "Nine",
      "Undeclared",
    ]);

    const ten = await readJson(
      await getVersionedRepositoryJson(
        request("/api/store/2026.10.0/repository.json"),
        { params: Promise.resolve({ frameosVersion: "2026.10.0" }) },
      ),
    );
    expect(templateNames(ten).sort()).toEqual([
      "Nightly",
      "Nine",
      "Ten",
      "Undeclared",
    ]);

    const eight = await readJson(
      await getVersionedRepositoryJson(
        request("/api/store/2026.8/repository.json"),
        { params: Promise.resolve({ frameosVersion: "2026.8" }) },
      ),
    );
    expect(templateNames(eight).sort()).toEqual(["Nightly", "Undeclared"]);
  });

  it("keeps the unversioned index listing everything, with relative URLs", async () => {
    const accountId = await seedPublisher();
    const scene = await seedScene(accountId, {
      frameosVersion: "2999.1.0",
      name: "From the future",
    });

    const payload = await readJson(
      await getRepositoryJson(request("/api/store/repository.json")),
    );
    const [template] = payload.templates as { zip: string }[];
    expect(templateNames(payload)).toEqual(["From the future"]);
    // Unchanged contract for installs already subscribed to this URL.
    expect(template!.zip).toBe(`./scenes/${scene.id}/download`);
  });

  it("makes versioned URLs absolute so they resolve outside the version folder", async () => {
    const accountId = await seedPublisher();
    const scene = await seedScene(accountId, {
      frameosVersion: "2026.9.0",
      name: "Absolute",
    });

    const payload = await readJson(
      await getVersionedRepositoryJson(
        request("/api/store/2026.9.0/repository.json"),
        { params: Promise.resolve({ frameosVersion: "2026.9.0" }) },
      ),
    );
    const [template] = payload.templates as { url: string; zip: string }[];
    expect(template!.zip).toBe(
      `${baseUrl}/api/store/scenes/${scene.id}/download`,
    );
    expect(template!.url).toBe(`${baseUrl}/s/${scene.slug}`);
    expect(payload.description).toContain("2026.9.0");
  });

  it("rejects path segments that are not versions", async () => {
    for (const segment of ["nightly", "v2026.9", "..", "2026.9.0-rc1"]) {
      const response = await getVersionedRepositoryJson(
        request(`/api/store/${segment}/repository.json`),
        { params: Promise.resolve({ frameosVersion: segment }) },
      );
      expect(response.status).toBe(404);
      expect((await readJson(response)).error).toBe("invalid_frameos_version");
    }
  });
});

describe("store browse feed", () => {
  it("pages the listing instead of loading everything", async () => {
    const accountId = await seedPublisher();
    const wanted = storePageSize + 5;
    for (let index = 0; index < wanted; index += 1) {
      await seedScene(accountId, {
        // Descending download counts pin the order across pages.
        downloadCount: wanted - index,
        name: `Scene ${String(index).padStart(3, "0")}`,
      });
    }

    const first = await readJson(await getBrowse(request("/api/store/browse")));
    expect((first.scenes as unknown[]).length).toBe(storePageSize);
    expect(first.hasMore).toBe(true);

    const second = await readJson(
      await getBrowse(request("/api/store/browse?page=2")),
    );
    expect((second.scenes as { name: string }[]).map((s) => s.name)).toEqual([
      "Scene 048",
      "Scene 049",
      "Scene 050",
      "Scene 051",
      "Scene 052",
    ]);
    expect(second.hasMore).toBe(false);

    // The server-rendered page carries the first batch only; the rest is the
    // feed's job.
    const markup = renderToStaticMarkup(
      await HomePage({ searchParams: Promise.resolve({}) }),
    );
    expect(markup).toContain("Scene 000");
    expect(markup).not.toContain("Scene 052");
    expect(markup).toContain("Page 1 of 2");
  });

  it("applies the version filter to the feed and the page", async () => {
    const accountId = await seedPublisher();
    await seedScene(accountId, { frameosVersion: "2026.9.0", name: "Nine" });
    await seedScene(accountId, { frameosVersion: "2026.10.0", name: "Ten" });

    const filtered = await readJson(
      await getBrowse(request("/api/store/browse?version=2026.9.0")),
    );
    expect((filtered.scenes as { name: string }[]).map((s) => s.name)).toEqual([
      "Nine",
    ]);

    const markup = renderToStaticMarkup(
      await HomePage({ searchParams: Promise.resolve({ version: "2026.9.0" }) }),
    );
    expect(markup).toContain("Scenes for FrameOS 2026.9.0");
    expect(markup).toContain("Nine");
    expect(markup).not.toContain(">Ten<");
    // The version picker offers both declared versions.
    expect(markup).toContain("FrameOS 2026.10.0");
    // …and points the install at the matching repository URL.
    expect(markup).toContain("/api/store/2026.9.0/repository.json");
  });

  it("ignores a malformed version instead of failing the page", async () => {
    const accountId = await seedPublisher();
    await seedScene(accountId, { frameosVersion: "2026.10.0", name: "Ten" });

    const payload = await readJson(
      await getBrowse(request("/api/store/browse?version=not-a-version")),
    );
    expect((payload.scenes as { name: string }[]).map((s) => s.name)).toEqual([
      "Ten",
    ]);
  });
});
