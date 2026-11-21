import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultUpdateManifestUrl,
  fetchUpdateManifest,
  parseUpdateManifest,
  resetUpdateManifestCacheForTests,
  updateManifestFreshMs,
  updateManifestRetryMs,
} from "./update-manifest";

const fetchMock = vi.fn<typeof fetch>();
const manifest = { version: 1, releases: [{ version: "2026.11.13", at: "2026-11-20T00:00:00Z" }] };

beforeEach(() => {
  resetUpdateManifestCacheForTests();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("fetchUpdateManifest", () => {
  it("reads main on GitHub and keeps it fresh for ten minutes", async () => {
    fetchMock.mockResolvedValue(Response.json(manifest));

    expect(await fetchUpdateManifest(1_000)).toEqual(manifest);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(defaultUpdateManifestUrl);
    expect(await fetchUpdateManifest(1_000 + updateManifestFreshMs - 1)).toEqual(manifest);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serves the last good copy when GitHub fails, and backs off before asking again", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(manifest));
    await fetchUpdateManifest(0);

    fetchMock.mockResolvedValue(new Response("down", { status: 503 }));
    const later = updateManifestFreshMs + 1;
    expect(await fetchUpdateManifest(later)).toEqual(manifest);
    expect(await fetchUpdateManifest(later + updateManifestRetryMs - 1)).toEqual(manifest);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await fetchUpdateManifest(later + updateManifestRetryMs + 1)).toEqual(manifest);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("is undefined with no good copy ever, and refuses what is not a manifest", async () => {
    fetchMock.mockResolvedValue(new Response("<html>", { status: 200 }));
    expect(await fetchUpdateManifest(0)).toBeUndefined();
    expect(parseUpdateManifest(JSON.stringify({ releases: "nope" }))).toBeUndefined();
    expect(parseUpdateManifest("[]")).toBeUndefined();
  });

  it("FRAMEOS_UPDATE_MANIFEST_URL points it elsewhere", async () => {
    vi.stubEnv("FRAMEOS_UPDATE_MANIFEST_URL", "https://example.test/manifest.json");
    fetchMock.mockResolvedValue(Response.json(manifest));
    await fetchUpdateManifest(0);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://example.test/manifest.json");
  });
});
