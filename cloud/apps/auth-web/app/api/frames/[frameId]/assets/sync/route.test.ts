import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { catalogueFonts } from "../../../../../../src/lib/fonts";
import {
  assetWriteRequestContext,
  runAssetWriteCommand,
} from "../../../../../../src/lib/frame-asset-write";
import { POST } from "./route";

// Font sync for a cloud-managed frame. Every font is one asset_put whose ack
// the device sends after writing to an SD card, so the interesting behaviour
// is all in the loop: what it skips, what it reports, and when it gives up.
// The command layer is mocked (its own ack/timeout handling is tested with
// frame-asset-write); this pins the contract the panel reads.

vi.mock("../../../../../../src/lib/frame-asset-write", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assetWriteRequestContext: vi.fn(),
  invalidateCachedAssetSubtree: vi.fn(() => Promise.resolve()),
  queueAssetsListRefresh: vi.fn(() => Promise.resolve()),
  runAssetWriteCommand: vi.fn(() => Promise.resolve({ ok: true as const })),
}));

const contextMock = vi.mocked(assetWriteRequestContext);
const commandMock = vi.mocked(runAssetWriteCommand);

const frameId = "11111111-2222-3333-4444-555555555555";
const accountId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

type ListingEntry = { path: string; size: number; is_dir?: boolean };

function fakeDb(listing: ListingEntry[] | null) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(listing ? [{ payload: listing }] : []),
        }),
      }),
    }),
  };
}

function grantAccess(listing: ListingEntry[] | null = null) {
  contextMock.mockResolvedValue({
    accountId,
    db: fakeDb(listing) as never,
    frame: { id: frameId, status: "active" } as never,
  });
}

type SyncEvent = Record<string, unknown> & { type: string };

async function runSync(): Promise<SyncEvent[]> {
  const response = await POST(
    new NextRequest(`https://cloud.example/api/frames/${frameId}/assets/sync`, {
      method: "POST",
    }),
    { params: Promise.resolve({ frameId }) },
  );
  expect(response.headers.get("content-type")).toContain("ndjson");
  // nginx buffers proxied responses by default, which would hold every
  // progress line until the run finished and defeat the streaming.
  expect(response.headers.get("x-accel-buffering")).toBe("no");
  const body = await response.text();
  return body
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SyncEvent);
}

function putPaths(): string[] {
  return commandMock.mock.calls
    .filter((call) => call[3] === "asset_put")
    .map((call) => String((call[4] as { path: string }).path));
}

const oversizedFont = catalogueFonts.find((font) => font.size > 2_621_440)!;

beforeEach(() => {
  vi.clearAllMocks();
  commandMock.mockResolvedValue({ ok: true });
});

describe("font sync for a cloud frame", () => {
  it("relays the guard's refusal instead of streaming anything", async () => {
    contextMock.mockResolvedValue({
      response: new Response("nope", { status: 401 }),
    });
    const response = await POST(
      new NextRequest(`https://cloud.example/api/frames/${frameId}/assets/sync`, {
        method: "POST",
      }),
      { params: Promise.resolve({ frameId }) },
    );
    expect(response.status).toBe(401);
    expect(commandMock).not.toHaveBeenCalled();
  });

  it("puts every font it can into fonts/ on the device", async () => {
    grantAccess();
    const events = await runSync();

    const start = events[0]!;
    expect(start.type).toBe("start");
    expect(start.total).toBe(catalogueFonts.length);
    expect(start.alreadyPresent).toBe(0);

    const paths = putPaths();
    expect(paths).toContain("fonts/CascadiaMono.ttf");
    for (const path of paths) {
      expect(path.startsWith("fonts/")).toBe(true);
    }
    // Everything except the one font that cannot ride a single WS frame.
    expect(paths.length).toBe(catalogueFonts.length - 1);

    const done = events.at(-1)!;
    expect(done.type).toBe("done");
    expect(done.uploaded).toBe(catalogueFonts.length - 1);
    expect(done.failed).toBe(0);
    expect(done.stopped).toBeUndefined();
  });

  it("creates fonts/ before writing into it", async () => {
    grantAccess();
    await runSync();
    expect(commandMock.mock.calls[0]![3]).toBe("asset_mkdir");
    expect(commandMock.mock.calls[0]![4]).toEqual({ path: "fonts" });
  });

  it("says which font is too large rather than failing it", async () => {
    grantAccess();
    const events = await runSync();

    const emoji = events.find((event) => event.file === oversizedFont.file)!;
    expect(emoji.status).toBe("skipped");
    expect(String(emoji.reason)).toContain("too large");
    // The number in the message is the font's real size, so "why" is checkable.
    expect(String(emoji.reason)).toContain((oversizedFont.size / 1_000_000).toFixed(1));
    expect(putPaths()).not.toContain(`fonts/${oversizedFont.file}`);
  });

  it("skips a font the frame already has at the same size", async () => {
    const present = catalogueFonts.slice(0, 3);
    grantAccess(present.map((font) => ({ path: `fonts/${font.file}`, size: font.size })));
    const events = await runSync();

    expect(events[0]!.alreadyPresent).toBe(3);
    for (const font of present) {
      expect(putPaths()).not.toContain(`fonts/${font.file}`);
      const event = events.find((candidate) => candidate.file === font.file)!;
      expect(event.status).toBe("skipped");
      expect(event.reason).toBe("already on the frame");
    }
  });

  it("re-pushes a font whose size on the frame differs", async () => {
    // A truncated or half-written file is exactly what a re-sync is for.
    const font = catalogueFonts[0]!;
    grantAccess([{ path: `fonts/${font.file}`, size: font.size - 1 }]);
    await runSync();
    expect(putPaths()).toContain(`fonts/${font.file}`);
  });

  it("ignores a listing entry that is a directory or lives deeper", async () => {
    const font = catalogueFonts[0]!;
    grantAccess([
      { is_dir: true, path: `fonts/${font.file}`, size: font.size },
      { path: `fonts/subdir/${font.file}`, size: font.size },
    ]);
    const events = await runSync();
    expect(events[0]!.alreadyPresent).toBe(0);
    expect(putPaths()).toContain(`fonts/${font.file}`);
  });

  it("stops early when the frame stops answering", async () => {
    grantAccess();
    commandMock.mockResolvedValue({
      error: "frame_unreachable",
      ok: false,
      timedOut: true,
    });
    const events = await runSync();

    const done = events.at(-1)!;
    expect(done.type).toBe("done");
    expect(done.failed).toBe(3);
    expect(String(done.stopped)).toContain("stopped answering");
    // Three failures, not sixty: at 30s per timeout the difference is half an
    // hour of a progress bar crawling towards a frame that is not there.
    expect(putPaths().length).toBe(3);
  });

  it("keeps going when a single font is refused", async () => {
    grantAccess();
    let call = 0;
    commandMock.mockImplementation(async (_db, _account, _frame, type) => {
      if (type !== "asset_put") {
        return { ok: true };
      }
      call += 1;
      return call === 2 ? { error: "no_space", ok: false } : { ok: true };
    });
    const events = await runSync();

    const done = events.at(-1)!;
    expect(done.failed).toBe(1);
    expect(done.stopped).toBeUndefined();
    expect(done.uploaded).toBe(catalogueFonts.length - 2);
    const failure = events.find((event) => event.status === "failed")!;
    expect(failure.reason).toBe("no_space");
  });

  it("reports progress as it goes, not in one lump at the end", async () => {
    grantAccess();
    const events = await runSync();
    const fontEvents = events.filter((event) => event.type === "font");
    expect(fontEvents.length).toBe(catalogueFonts.length);
    fontEvents.forEach((event, index) => {
      expect(event.index).toBe(index);
      expect(event.total).toBe(catalogueFonts.length);
    });
  });
});
