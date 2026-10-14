import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activePhotoScanners, defaultPhotoDnaEndpoint, scanPhoto } from "./scan";

const input = {
  source: Buffer.from("fake image bytes"),
  contentType: "image/jpeg",
  sha256: "ab".repeat(32),
};
const notListed = async () => undefined;
// What the route sends PhotoDNA (thumbnail.ts photoScanCopy): a small JPEG
// made from the upload. Here, the bytes with a mark.
const copyOf = async (source: Buffer | string) =>
  Buffer.concat([Buffer.from("copy:"), Buffer.isBuffer(source) ? source : Buffer.from(source)]);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

const photoDnaOk = (isMatch: boolean) => ({
  IsMatch: isMatch,
  MatchDetails: { MatchFlags: isMatch ? [{ Source: "test" }] : [] },
  Status: { Code: 3000, Description: "OK" },
  TrackingId: "track-1",
});

beforeEach(() => {
  vi.stubEnv("PHOTODNA_SUBSCRIPTION_KEY", "");
  vi.stubEnv("PHOTODNA_ENDPOINT", "");
  vi.stubEnv("OPENAI_API_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("activePhotoScanners", () => {
  it("always has the hash list, and the others when their keys are set", () => {
    expect(activePhotoScanners({})).toEqual(["hash_list"]);
    expect(activePhotoScanners({ PHOTODNA_SUBSCRIPTION_KEY: "k" })).toEqual([
      "hash_list",
      "photodna",
    ]);
    // OpenAI moderation scores sexual/minors on text only, so it is never
    // a photo scanner, whatever keys are set.
    expect(
      activePhotoScanners({ OPENAI_API_KEY: "sk", PHOTODNA_SUBSCRIPTION_KEY: " k " }),
    ).toEqual(["hash_list", "photodna"]);
    expect(activePhotoScanners({ PHOTODNA_SUBSCRIPTION_KEY: "  " })).toEqual(["hash_list"]);
  });
});

describe("scanPhoto", () => {
  it("passes a clean photo with only the hash list, calling nothing remote", async () => {
    const fetchImpl = vi.fn();
    const result = await scanPhoto(input, { blockedHash: notListed, fetchImpl });
    expect(result).toEqual({ outcome: "clean", scanners: ["hash_list"] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("matches a listed hash before any remote scanner runs", async () => {
    vi.stubEnv("PHOTODNA_SUBSCRIPTION_KEY", "key");
    const fetchImpl = vi.fn();
    const result = await scanPhoto(input, {
      blockedHash: async (sha256) => (sha256 === input.sha256 ? { reason: "known" } : undefined),
      fetchImpl,
    });
    expect(result).toEqual({
      details: { reason: "known" },
      outcome: "match",
      scanner: "hash_list",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed when the hash list cannot be read", async () => {
    const result = await scanPhoto(input, {
      blockedHash: async () => {
        throw new Error("db down");
      },
    });
    expect(result).toMatchObject({ outcome: "unavailable", scanner: "hash_list" });
  });

  it("sends PhotoDNA the scan copy inline with the subscription key", async () => {
    vi.stubEnv("PHOTODNA_SUBSCRIPTION_KEY", "secret-key");
    const fetchImpl = vi.fn(async () => jsonResponse(photoDnaOk(false)));
    const result = await scanPhoto(input, {
      blockedHash: notListed,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      scanCopy: copyOf,
    });
    expect(result).toEqual({ outcome: "clean", scanners: ["hash_list", "photodna"] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${defaultPhotoDnaEndpoint}?enhance=false`);
    expect((init.headers as Record<string, string>)["ocp-apim-subscription-key"]).toBe(
      "secret-key",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      DataRepresentation: "inline",
      Value: Buffer.concat([Buffer.from("copy:"), input.source as Buffer]).toString("base64"),
    });
  });

  it("fails closed when the image cannot be copied for PhotoDNA", async () => {
    vi.stubEnv("PHOTODNA_SUBSCRIPTION_KEY", "k");
    const fetchImpl = vi.fn();
    const result = await scanPhoto(input, {
      blockedHash: notListed,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      scanCopy: async () => null,
    });
    expect(result).toEqual({ error: "unreadable_image", outcome: "unavailable", scanner: "photodna" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not retry a refused key", async () => {
    vi.stubEnv("PHOTODNA_SUBSCRIPTION_KEY", "wrong");
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "denied" }, 401));
    const result = await scanPhoto(input, {
      blockedHash: notListed,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      scanCopy: copyOf,
    });
    expect(result).toEqual({ error: "http_401", outcome: "unavailable", scanner: "photodna" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses PHOTODNA_ENDPOINT when set", async () => {
    vi.stubEnv("PHOTODNA_SUBSCRIPTION_KEY", "k");
    vi.stubEnv("PHOTODNA_ENDPOINT", "https://photodna.example/Match");
    const fetchImpl = vi.fn(async () => jsonResponse(photoDnaOk(false)));
    await scanPhoto(input, { blockedHash: notListed, fetchImpl: fetchImpl as unknown as typeof fetch, scanCopy: copyOf });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(
      "https://photodna.example/Match?enhance=false",
    );
  });

  it("reports a PhotoDNA match with its tracking id", async () => {
    vi.stubEnv("PHOTODNA_SUBSCRIPTION_KEY", "k");
    const fetchImpl = vi.fn(async () => jsonResponse(photoDnaOk(true)));
    const result = await scanPhoto(input, {
      blockedHash: notListed,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      scanCopy: copyOf,
    });
    expect(result).toMatchObject({
      details: { tracking_id: "track-1" },
      outcome: "match",
      scanner: "photodna",
    });
  });

  it("fails closed on a PhotoDNA error status, without retrying", async () => {
    vi.stubEnv("PHOTODNA_SUBSCRIPTION_KEY", "k");
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ IsMatch: false, Status: { Code: 3004, Description: "Image too small" } }),
    );
    const result = await scanPhoto(input, {
      blockedHash: notListed,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      scanCopy: copyOf,
    });
    expect(result).toEqual({ error: "status_3004", outcome: "unavailable", scanner: "photodna" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a PhotoDNA outage once, then fails closed", async () => {
    vi.stubEnv("PHOTODNA_SUBSCRIPTION_KEY", "k");
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "busy" }, 503));
    const result = await scanPhoto(input, {
      blockedHash: notListed,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      scanCopy: copyOf,
    });
    expect(result).toEqual({ error: "http_503", outcome: "unavailable", scanner: "photodna" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const throwing = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(
      await scanPhoto(input, { blockedHash: notListed, fetchImpl: throwing as unknown as typeof fetch }),
    ).toMatchObject({ outcome: "unavailable", scanner: "photodna" });
  });

  it("fails closed on an answer without IsMatch", async () => {
    vi.stubEnv("PHOTODNA_SUBSCRIPTION_KEY", "k");
    const fetchImpl = vi.fn(async () => jsonResponse({ Status: { Code: 3000 } }));
    expect(
      await scanPhoto(input, { blockedHash: notListed,
      scanCopy: copyOf, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).toMatchObject({ error: "invalid_response", outcome: "unavailable" });
  });
});
