// A set of scenes over the USB console after a flash
// (frontend/src/scenes/workspace/embeddedFlashShared.tsx
// uploadScenesOverUsbAfterFlash): in batches of what the board holds in
// memory at once (512 KB of JSON, FOS_SCENES_HELD_MAX_BYTES), each deflated
// for `usb_api scenes-deflated`, the first replacing the board's set and the
// rest added to it. Firmware without that command gets the scenes that fit
// one `upload-scenes`, then the rest a scene at a time with `scene-put`, and a
// restart when it holds the first set back.
import { inflateSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Sent {
  command: string;
  payload: Uint8Array | null;
}

const sent: Sent[] = [];
const logLines: string[] = [];
let answer: (command: string) => void = () => undefined;

vi.mock("../../../../../../frontend/src/models/embeddedUsbLogsModel", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runEmbeddedUsbApiCommand: vi.fn(
      async (_frameId: unknown, command: string, options?: { payload?: Uint8Array | string }) => {
        const payload = options?.payload;
        sent.push({ command, payload: payload instanceof Uint8Array ? payload : null });
        answer(command);
        return { command: command.split(" ")[0] };
      },
    ),
    usbRestart: vi.fn(async () => {
      sent.push({ command: "restart", payload: null });
    }),
    resolveLiveSerialPort: vi.fn(async (port: unknown) => port),
    appendEmbeddedUsbLogLine: vi.fn((_frameId: unknown, line: string) => {
      logLines.push(line);
    }),
  };
});

import { uploadScenesOverUsbAfterFlash } from "../../../../../../frontend/src/scenes/workspace/embeddedFlashShared";
import {
  EMBEDDED_USB_WHOLE_SET_MAX_BYTES,
  deflateForUsb,
  embeddedUsbScenesBatches,
  embeddedUsbScenesUploadPlan,
} from "../../../../../../frontend/src/utils/embeddedUsbUpload";

function scene(id: string, kilobytes: number): Record<string, unknown> {
  return { id, pad: "x".repeat(kilobytes * 1024 - 20) };
}

function ids(scenes: readonly Record<string, unknown>[]): unknown[] {
  return scenes.map((entry) => entry.id);
}

function verbs(): string[] {
  return sent.map((entry) => entry.command.split(" ").slice(0, 2).join(" "));
}

/** What a `scenes-deflated` command carried, as the board inflates it; the
 * command names the inflated length, and the runner appends the sent one. */
function inflated(entry: Sent): Record<string, unknown>[] {
  const json = inflateSync(entry.payload!).toString("utf8");
  expect(entry.command).toMatch(new RegExp(`^scenes-deflated (set|put) ${Buffer.byteLength(json)}$`));
  return JSON.parse(json) as Record<string, unknown>[];
}

const WAITING =
  "UNKNOWN ERROR a scene upload is waiting to be applied, try again, payload=0, stateUsed=7179120, stateTotal=21798465";

describe("embeddedUsbScenesUploadPlan", () => {
  it("sends a set that fits in one upload whole", () => {
    const scenes = [scene("a", 100), scene("b", 100)];
    expect(embeddedUsbScenesUploadPlan(scenes)).toEqual({ whole: scenes, each: [] });
  });

  it("sends the first scenes that fit, then the rest alone", () => {
    const scenes = [scene("store", 64), scene("a", 200), scene("b", 200), scene("c", 100), scene("d", 10)];
    const plan = embeddedUsbScenesUploadPlan(scenes);
    expect(ids(plan.whole)).toEqual(["store", "a", "b"]);
    expect(ids(plan.each)).toEqual(["c", "d"]);
    expect(new TextEncoder().encode(JSON.stringify(plan.whole)).byteLength).toBeLessThanOrEqual(
      EMBEDDED_USB_WHOLE_SET_MAX_BYTES,
    );
  });

  it("always sends at least one scene whole, so the board's set is replaced", () => {
    const plan = embeddedUsbScenesUploadPlan([scene("big", 600), scene("small", 1)]);
    expect(ids(plan.whole)).toEqual(["big"]);
  });
});

describe("embeddedUsbScenesBatches", () => {
  it("cuts a set into batches that each fit what the board holds, in order", () => {
    const scenes = [scene("store", 64), scene("a", 200), scene("b", 200), scene("c", 300), scene("d", 300), scene("e", 1)];
    const batches = embeddedUsbScenesBatches(scenes);
    expect(batches.map(ids)).toEqual([["store", "a", "b"], ["c"], ["d", "e"]]);
    for (const batch of batches) {
      expect(new TextEncoder().encode(JSON.stringify(batch)).byteLength).toBeLessThanOrEqual(
        EMBEDDED_USB_WHOLE_SET_MAX_BYTES,
      );
    }
    expect(embeddedUsbScenesBatches([])).toEqual([]);
  });
});

describe("deflateForUsb", () => {
  it("is a zlib stream, which the board's tinfl checks by its Adler-32", async () => {
    const json = new TextEncoder().encode(JSON.stringify([scene("a", 30)]));
    const body = await deflateForUsb(json);
    // CMF 0x78: deflate with a 32 KB window, the zlib header tinfl parses.
    expect(body[0]).toBe(0x78);
    expect(body.byteLength).toBeLessThan(json.byteLength / 3);
    expect(new Uint8Array(inflateSync(body))).toEqual(json);
  });
});

describe("uploadScenesOverUsbAfterFlash", () => {
  beforeEach(() => {
    sent.length = 0;
    logLines.length = 0;
    answer = () => undefined;
  });

  it("uploads a small set in one deflated command", async () => {
    const statuses: string[] = [];
    const scenes = [scene("a", 10), scene("b", 10)];
    await expect(
      uploadScenesOverUsbAfterFlash("flasher", scenes, {} as SerialPort, (message) => statuses.push(message)),
    ).resolves.toBe(true);
    expect(verbs()).toEqual(["scenes-deflated set"]);
    expect(inflated(sent[0]!)).toEqual(scenes);
    expect(statuses).toEqual(["Uploading 2 scene(s) over USB"]);
  });

  it("uploads a big set as a deflated set, then deflated batches added to it", async () => {
    const statuses: string[] = [];
    const scenes = [scene("store", 64), scene("a", 300), scene("b", 300), scene("c", 300), scene("d", 1)];
    await uploadScenesOverUsbAfterFlash("flasher", scenes, {} as SerialPort, (message) => statuses.push(message));
    expect(verbs()).toEqual(["scenes-deflated set", "scenes-deflated put", "scenes-deflated put"]);
    const batches = sent.map(inflated);
    expect(batches.map(ids)).toEqual([["store", "a"], ["b"], ["c", "d"]]);
    expect(batches.flat()).toEqual(scenes);
    expect(statuses).toEqual([
      "Uploading scenes 1 to 2 of 5 over USB",
      "Uploading scene 3 of 5 over USB",
      "Uploading scenes 4 to 5 of 5 over USB",
    ]);
  });

  it("tries a batch the board did not take again", async () => {
    // The retry's wait alone: the deflate stream's own work stays real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let failures = 1;
      answer = (command) => {
        if (command.startsWith("scenes-deflated put") && failures-- > 0) {
          throw new Error("Timed out waiting for USB command response: scenes-deflated put");
        }
      };
      const statuses: string[] = [];
      const scenes = [scene("store", 64), scene("a", 300), scene("b", 300)];
      let settled = false;
      const done = uploadScenesOverUsbAfterFlash("flasher", scenes, {} as SerialPort, (message) =>
        statuses.push(message),
      ).finally(() => {
        settled = true;
      });
      while (!settled) {
        await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(1000);
      }
      await expect(done).resolves.toBe(true);
      expect(verbs()).toEqual(["scenes-deflated set", "scenes-deflated put", "scenes-deflated put"]);
      expect(statuses).toContain("Retrying scene 3 of 3 over USB (2/3)");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the set as it is to firmware that does not know the deflated command", async () => {
    answer = (command) => {
      if (command.startsWith("scenes-deflated")) {
        throw new Error("UNKNOWN ERROR unknown subcommand");
      }
    };
    const statuses: string[] = [];
    const scenes = [scene("store", 64), scene("a", 300), scene("b", 300), scene("c", 300)];
    await uploadScenesOverUsbAfterFlash("flasher", scenes, {} as SerialPort, (message) => statuses.push(message));
    // Asked once, never again: the board answered before READY.
    expect(verbs()).toEqual(["scenes-deflated set", "upload-scenes", "scene-put", "scene-put"]);
    expect(sent.slice(1).every((entry) => entry.payload!.byteLength <= EMBEDDED_USB_WHOLE_SET_MAX_BYTES)).toBe(true);
    expect(statuses.slice(1)).toEqual([
      "Uploading 2 of 4 scenes over USB",
      "Uploading scene 3 of 4 over USB",
      "Uploading scene 4 of 4 over USB",
    ]);
  });

  it("restarts firmware that holds the first set back, once, and sends the rest", async () => {
    // A board with no network yet: its render task never applies the set the
    // first upload stored, and firmware through 2026.11.14 refuses every put
    // on top of it until a boot (the reTerminal Sticky, 2026-11-25).
    answer = (command) => {
      if (command.startsWith("scenes-deflated")) {
        throw new Error("UNKNOWN ERROR unknown subcommand");
      }
      if (command === "scene-put" && !sent.some((entry) => entry.command === "restart")) {
        throw new Error(WAITING);
      }
    };
    const statuses: string[] = [];
    const scenes = [scene("store", 64), scene("a", 300), scene("b", 300), scene("c", 300)];
    await expect(
      uploadScenesOverUsbAfterFlash("flasher", scenes, {} as SerialPort, (message) => statuses.push(message)),
    ).resolves.toBe(true);
    // The refused put is not sent again as it is (three times a scene's bytes
    // on the cable for the same answer): a restart, the board answers, the
    // put again.
    expect(sent.map((entry) => entry.command.split(" ")[0])).toEqual([
      "scenes-deflated",
      "upload-scenes",
      "scene-put",
      "restart",
      "status",
      "scene-put",
      "scene-put",
    ]);
    expect(statuses).toContain(
      "Restarting the board so it takes the rest of the scenes. Leave its screen and keys alone until it is done.",
    );
    expect(logLines.some((line) => line.includes("holds back the first 2 scenes"))).toBe(true);
  });

  it("gives up when the board holds the set back after a restart too", async () => {
    answer = (command) => {
      if (command.startsWith("scenes-deflated")) {
        throw new Error("UNKNOWN ERROR unknown subcommand");
      }
      if (command === "scene-put") {
        throw new Error(WAITING);
      }
    };
    const scenes = [scene("store", 64), scene("a", 300), scene("b", 300)];
    await expect(uploadScenesOverUsbAfterFlash("flasher", scenes, {} as SerialPort, () => undefined)).rejects.toThrow(
      /waiting to be applied/,
    );
    expect(sent.filter((entry) => entry.command === "restart")).toHaveLength(1);
  });

  it("sends nothing when there is nothing to send", async () => {
    await expect(uploadScenesOverUsbAfterFlash("flasher", [], {} as SerialPort, () => undefined)).resolves.toBe(
      false,
    );
    expect(sent).toEqual([]);
  });
});
