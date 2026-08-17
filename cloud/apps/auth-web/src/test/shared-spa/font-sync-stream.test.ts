import { describe, expect, it, vi } from "vitest";
import {
  consumeFontSyncStream,
  isFontSyncStream,
  type FontSyncProgress,
} from "../../../../../../frontend/src/utils/fontSyncStream";

// The panel's half of the cloud font sync. The route streams a line per font
// because the run takes minutes; this turns that into progress and a summary,
// and has to stay honest when the stream is cut short — commands already
// queued still reach the device, but the sync did not finish.

function streamOf(lines: string[], { chunkSize = 0 } = {}): Response {
  const encoder = new TextEncoder();
  const payload = lines.join("");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (chunkSize > 0) {
        // Deliberately split mid-line: a chunk boundary is not a line
        // boundary, and pretending otherwise loses events at random.
        for (let at = 0; at < payload.length; at += chunkSize) {
          controller.enqueue(encoder.encode(payload.slice(at, at + chunkSize)));
        }
      } else {
        controller.enqueue(encoder.encode(payload));
      }
      controller.close();
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
  });
}

const line = (event: Record<string, unknown>) => JSON.stringify(event) + "\n";

const happyRun = [
  line({ alreadyPresent: 0, total: 3, totalBytes: 900, type: "start" }),
  line({ file: "A.ttf", index: 0, status: "uploaded", total: 3, type: "font" }),
  line({ file: "B.ttf", index: 1, status: "uploaded", total: 3, type: "font" }),
  line({
    file: "C.ttf",
    index: 2,
    reason: "already on the frame",
    status: "skipped",
    total: 3,
    type: "font",
  }),
  line({ failed: 0, skipped: 1, type: "done", uploaded: 2 }),
];

describe("the font sync progress stream", () => {
  it("is recognised by content type, so a backend's plain JSON is not misread", () => {
    expect(isFontSyncStream(streamOf(happyRun))).toBe(true);
    expect(
      isFontSyncStream(
        new Response("{}", { headers: { "Content-Type": "application/json" } }),
      ),
    ).toBe(false);
  });

  it("reports each font as it lands and summarises the run", async () => {
    const progress: FontSyncProgress[] = [];
    const summary = await consumeFontSyncStream(streamOf(happyRun), (event) =>
      progress.push(event),
    );

    expect(progress.map((event) => event.done)).toEqual([0, 1, 2, 3]);
    expect(progress.at(-1)!.detail).toContain("Skipped C.ttf");
    expect(progress.at(-1)!.detail).toContain("already on the frame");
    expect(summary).toEqual({
      detail: "2 fonts copied, 1 skipped",
      failed: 0,
      ok: true,
      skipped: 1,
      uploaded: 2,
    });
  });

  it("survives events split across chunk boundaries", async () => {
    const summary = await consumeFontSyncStream(
      streamOf(happyRun, { chunkSize: 7 }),
      () => undefined,
    );
    expect(summary.uploaded).toBe(2);
  });

  it("calls a run with failures not ok, while still counting what landed", async () => {
    const summary = await consumeFontSyncStream(
      streamOf([
        line({ alreadyPresent: 0, total: 2, totalBytes: 10, type: "start" }),
        line({ file: "A.ttf", index: 0, status: "uploaded", total: 2, type: "font" }),
        line({
          file: "B.ttf",
          index: 1,
          reason: "no_space",
          status: "failed",
          total: 2,
          type: "font",
        }),
        line({ failed: 1, skipped: 0, type: "done", uploaded: 1 }),
      ]),
      () => undefined,
    );
    expect(summary.ok).toBe(false);
    expect(summary.detail).toBe("1 font copied, 1 failed");
  });

  it("says the run stopped early, and why", async () => {
    const summary = await consumeFontSyncStream(
      streamOf([
        line({ alreadyPresent: 0, total: 61, totalBytes: 10, type: "start" }),
        line({
          failed: 3,
          skipped: 0,
          stopped: "the frame stopped answering",
          type: "done",
          uploaded: 4,
        }),
      ]),
      () => undefined,
    );
    expect(summary.ok).toBe(false);
    expect(summary.detail).toContain("stopped early: the frame stopped answering");
  });

  it("refuses to call a truncated stream a finished sync", async () => {
    // The proxy dropped the connection halfway. Some fonts did land, so the
    // panel must not say "synced" — the queued commands are still in flight.
    await expect(
      consumeFontSyncStream(streamOf(happyRun.slice(0, 3)), () => undefined),
    ).rejects.toThrow(/stopped before it finished/);
  });

  it("propagates an explicit error event", async () => {
    await expect(
      consumeFontSyncStream(
        streamOf([line({ error: "frame_not_active", type: "error" })]),
        () => undefined,
      ),
    ).rejects.toThrow("frame_not_active");
  });

  it("ignores a half-written trailing line rather than failing on it", async () => {
    const summary = await consumeFontSyncStream(
      streamOf([...happyRun, '{"type":"fo']),
      () => undefined,
    );
    expect(summary.ok).toBe(true);
  });

  it("throws when there is no stream to read at all", async () => {
    const onProgress = vi.fn();
    await expect(
      consumeFontSyncStream(new Response(null), onProgress),
    ).rejects.toThrow(/no progress stream/);
    expect(onProgress).not.toHaveBeenCalled();
  });
});
