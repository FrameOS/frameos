import { generateKeyPairSync, sign as signDigest } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetReleaseCacheForTests } from "../../../../src/lib/firmware-release";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { createReleaseDigest } from "../../../../src/lib/release-signing";
import { resetSdImageVerdictsForTests } from "../../../../src/lib/sd-image-verify";
import { readSession } from "../../../../src/lib/session";
import { GET } from "./route";

// The SD image route verifies the Buildroot image's minisign signature
// before serving a byte (one hashing pass per release per process, then a
// cached verdict). GitHub is mocked like the sibling browser-flasher suite
// (../firmware/route.test.ts); the release key is swapped for a throwaway
// keypair so the suite can sign its own "image".

vi.mock("../../../../src/lib/rate-limit", () => ({
  identityRateLimitResponse: vi.fn(() => Promise.resolve(undefined)),
  rateLimitResponse: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("../../../../src/lib/session", () => ({
  readSession: vi.fn(() => Promise.resolve({ accountId: "acct_1" })),
}));

const testKey = generateKeyPairSync("ed25519");
const testPublicKeyBase64 = testKey.publicKey
  .export({ format: "der", type: "spki" })
  .subarray(12)
  .toString("base64");
vi.mock("../../../../src/lib/release-signing", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../../src/lib/release-signing")>();
  return {
    ...original,
    verifyReleaseDigest: (digest: Uint8Array, minisig: string) =>
      original.verifyReleaseDigest(digest, minisig, testPublicKeyBase64),
  };
});

const readSessionMock = vi.mocked(readSession);
const rateLimitMock = vi.mocked(rateLimitResponse);
const fetchMock = vi.fn<typeof fetch>();

const imageBytes = new Uint8Array(70_000).map((_, i) => (i * 7) % 253);

function minisigFor(bytes: Uint8Array) {
  const digest = createReleaseDigest().update(bytes).digest();
  const signature = signDigest(null, digest, testKey.privateKey);
  const blob = Buffer.concat([
    Buffer.from("ED", "latin1"),
    Buffer.alloc(8, 0x27),
    signature,
  ]);
  return (
    "untrusted comment: signature from FrameOS firmware key\n" +
    `${blob.toString("base64")}\n` +
    "trusted comment: timestamp:1\n" +
    `${Buffer.alloc(64, 1).toString("base64")}\n`
  );
}

const goodMinisig = minisigFor(imageBytes);
const imageName = "frameos-1.2.3-raspberry-pi-64-buildroot.img.gz";
const imageUrl = `https://github.com/FrameOS/frameos/releases/download/v1.2.3/${imageName}`;

function releaseWith({ minisig = true }: { minisig?: boolean } = {}) {
  return {
    assets: [
      {
        browser_download_url: imageUrl,
        name: imageName,
        size: imageBytes.length,
      },
      ...(minisig
        ? [
            {
              browser_download_url: `${imageUrl}.minisig`,
              name: `${imageName}.minisig`,
              size: goodMinisig.length,
            },
          ]
        : []),
    ],
    tag_name: "v1.2.3",
  };
}

// Streams the image in several chunks so the hashing pass has to loop.
function imageResponse(bytes: Uint8Array, etag = '"etag-1"') {
  const chunk = 16_384;
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunk));
      offset += chunk;
    },
  });
  return new Response(body, {
    headers: { "content-length": String(bytes.length), etag },
  });
}

let imageDownloads = 0;

function mockGitHub({
  release = releaseWith(),
  minisig = goodMinisig,
  image = imageBytes,
  etag,
}: {
  release?: unknown;
  minisig?: string;
  image?: Uint8Array;
  etag?: string;
} = {}) {
  imageDownloads = 0;
  fetchMock.mockImplementation((input) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/")) {
      return Promise.resolve(Response.json(release));
    }
    if (url === `${imageUrl}.minisig`) {
      return Promise.resolve(new Response(minisig));
    }
    if (url === imageUrl) {
      imageDownloads += 1;
      return Promise.resolve(imageResponse(image, etag));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

function request(query = "?platform=raspberry-pi-64") {
  return new NextRequest(`https://cloud.example/api/frames/sd-image${query}`);
}

beforeEach(() => {
  resetReleaseCacheForTests();
  resetSdImageVerdictsForTests();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  rateLimitMock.mockClear();
  readSessionMock.mockClear();
  readSessionMock.mockImplementation(() =>
    Promise.resolve({ accountId: "acct_1" } as never),
  );
  vi.unstubAllGlobals();
});

describe("GET /api/frames/sd-image", () => {
  it("requires a session and a known platform before reaching GitHub", async () => {
    mockGitHub();
    readSessionMock.mockImplementation(() => Promise.resolve(undefined));
    const anonymous = await GET(request());
    expect(anonymous.status).toBe(401);

    readSessionMock.mockImplementation(() =>
      Promise.resolve({ accountId: "acct_1" } as never),
    );
    const unknown = await GET(request("?platform=../etc/passwd"));
    expect(unknown.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("verifies the image once, then streams it with the verified length", async () => {
    mockGitHub();
    const first = await GET(request());
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("application/gzip");
    expect(first.headers.get("content-length")).toBe(String(imageBytes.length));
    expect(first.headers.get("x-frameos-image-name")).toBe(imageName);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(imageBytes);
    // One pass to hash, one to stream.
    expect(imageDownloads).toBe(2);

    const second = await GET(request());
    expect(second.status).toBe(200);
    await second.arrayBuffer();
    // The verdict is remembered: no second hashing pass.
    expect(imageDownloads).toBe(3);
  });

  it("refuses an image whose signature does not verify, without serving a byte", async () => {
    const tampered = imageBytes.slice();
    tampered[4242] = (tampered[4242] ?? 0) ^ 0xff;
    mockGitHub({ image: tampered });
    const response = await GET(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "release_signature_invalid",
      release: "v1.2.3",
    });
    // Only the hashing pass touched the image; nothing was streamed.
    expect(imageDownloads).toBe(1);
  });

  it("refuses a release that published the image without a .minisig", async () => {
    mockGitHub({ release: releaseWith({ minisig: false }) });
    const response = await GET(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "unsigned_release" });
    expect(imageDownloads).toBe(0);
  });

  it("hands the browser the signature text on ?signature=1", async () => {
    mockGitHub();
    const response = await GET(request("?platform=raspberry-pi-64&signature=1"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe(goodMinisig);
    expect(imageDownloads).toBe(0);
  });

  it("refuses to stream when GitHub serves different bytes than were verified", async () => {
    mockGitHub();
    const warm = await GET(request());
    expect(warm.status).toBe(200);
    await warm.arrayBuffer();

    // Same name and listed size, a different object behind the URL.
    const swapped = imageBytes.slice();
    swapped[0] = (swapped[0] ?? 0) ^ 0x01;
    mockGitHub({ image: swapped, etag: '"etag-2"' });
    const response = await GET(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "release_signature_invalid",
    });
  });
});
