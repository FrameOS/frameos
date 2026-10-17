import { describe, expect, it } from "vitest";
import { cloudFramesContract } from "./cloud-frames-contract.gen";
import { waitForFrameCommand } from "./frame-command-wait";
import {
  frameLanAccess,
  lanAccessOutcomeResponse,
  lanAccessRefusal,
  parseLanAccessSetBody,
  type FrameCommandOutcome,
} from "./frame-lan-access";

describe("frameLanAccess", () => {
  it("reads the device's boolean and nothing else", () => {
    expect(frameLanAccess({ lanAccess: true, platform: "esp32s3" })).toBe(true);
    expect(frameLanAccess({ lanAccess: false })).toBe(false);
    for (const hardware of [null, undefined, "x", [], [true], {}, { lanAccess: "true" }, { lanAccess: 1 }, { lanAccess: null }]) {
      expect(frameLanAccess(hardware), JSON.stringify(hardware)).toBeNull();
    }
  });
});

describe("parseLanAccessSetBody", () => {
  it("needs a boolean enabled", () => {
    for (const body of [{}, { enabled: "true" }, { enabled: 1 }, { enabled: null }, { code: "123456" }]) {
      const parsed = parseLanAccessSetBody(body);
      expect(parsed, JSON.stringify(body)).toMatchObject({ error: "invalid_lan_access", ok: false, status: 400 });
    }
  });

  it("turns off without a code, and does not forward one that came along", () => {
    expect(parseLanAccessSetBody({ enabled: false })).toEqual({ ok: true, payload: { enabled: false } });
    expect(parseLanAccessSetBody({ code: "123456", enabled: false })).toEqual({ ok: true, payload: { enabled: false } });
    expect(parseLanAccessSetBody({ code: "garbage", enabled: false })).toEqual({ ok: true, payload: { enabled: false } });
  });

  it("turns on only with a six-digit code, spaces dropped", () => {
    expect(parseLanAccessSetBody({ code: "123456", enabled: true })).toEqual({
      ok: true,
      payload: { code: "123456", enabled: true },
    });
    expect(parseLanAccessSetBody({ code: " 123 456 ", enabled: true })).toEqual({
      ok: true,
      payload: { code: "123456", enabled: true },
    });
    for (const code of [undefined, null, "", "   "]) {
      expect(parseLanAccessSetBody({ code, enabled: true }), String(code)).toMatchObject({
        error: "code_required",
        ok: false,
        status: 400,
      });
    }
    for (const code of ["12345", "1234567", "12a456", "１２３４５６", 123456, ["123456"]]) {
      expect(parseLanAccessSetBody({ code, enabled: true }), String(code)).toMatchObject({
        error: "invalid_code",
        ok: false,
        status: 400,
      });
    }
  });

  it("gives every refusal a short plain detail", () => {
    for (const body of [{}, { enabled: true }, { code: "1", enabled: true }]) {
      const parsed = parseLanAccessSetBody(body);
      if (parsed.ok) throw new Error("expected a refusal");
      expect(parsed.detail.length).toBeGreaterThan(0);
      expect(parsed.detail).not.toMatch(/[—–]/);
    }
  });
});

describe("lanAccessOutcomeResponse", () => {
  const failed = (error: string | null): FrameCommandOutcome => ({ error, state: "failed" });

  it("says shown / applied on an ack", () => {
    expect(lanAccessOutcomeResponse("lan_access_challenge", { state: "acked" })).toEqual({
      body: { expires_in_seconds: 300, status: "shown" },
      status: 200,
    });
    expect(lanAccessOutcomeResponse("lan_access_set", { state: "acked" }, true)).toEqual({
      body: { lan_access: true, status: "applied" },
      status: 200,
    });
    expect(lanAccessOutcomeResponse("lan_access_set", { state: "acked" }, false)).toEqual({
      body: { lan_access: false, status: "applied" },
      status: 200,
    });
  });

  it("says queued while the frame has not answered", () => {
    for (const verb of ["lan_access_challenge", "lan_access_set"] as const) {
      expect(lanAccessOutcomeResponse(verb, { state: "waiting" }, true)).toEqual({ body: { status: "queued" }, status: 200 });
    }
  });

  it("maps an old firmware's refusal to unsupported", () => {
    for (const error of ["unknown_verb", "unsupported_verb"]) {
      expect(lanAccessOutcomeResponse("lan_access_set", failed(error), true)).toEqual({
        body: { detail: "Update this frame's FrameOS first.", error: "unsupported" },
        status: 409,
      });
    }
  });

  it("maps every contract token to its status", () => {
    const expected: Record<string, number> = {
      challenge_failed: 500,
      code_expired: 403,
      code_required: 403,
      invalid_code: 403,
      invalid_lan_access: 400,
      no_panel: 409,
      persist_failed: 500,
      rate_limited: 429,
      too_many_attempts: 403,
    };
    const tokens = [...cloudFramesContract.errors.lan_access_challenge, ...cloudFramesContract.errors.lan_access_set];
    expect(new Set(tokens)).toEqual(new Set(Object.keys(expected)));
    for (const token of tokens) {
      const { body, status } = lanAccessOutcomeResponse("lan_access_set", failed(token), true);
      expect(status, token).toBe(expected[token]);
      expect(body.error, token).toBe(token);
      expect(typeof body.detail, token).toBe("string");
      expect(body.detail as string, token).not.toMatch(/[—–]|colour/);
    }
  });

  it("passes another device token through as a 502, and never echoes free text", () => {
    expect(lanAccessOutcomeResponse("lan_access_challenge", failed("no_memory"))).toMatchObject({
      body: { error: "no_memory" },
      status: 502,
    });
    expect(lanAccessOutcomeResponse("lan_access_challenge", failed("display busy: <b>"))).toMatchObject({
      body: { error: "frame_error" },
      status: 502,
    });
    expect(lanAccessOutcomeResponse("lan_access_challenge", failed(null))).toMatchObject({
      body: { error: "error" },
      status: 502,
    });
  });

  it("calls an expired command a timeout and a vanished one a missing frame", () => {
    expect(lanAccessOutcomeResponse("lan_access_set", { error: "superseded", state: "expired" }, true)).toEqual({
      body: { detail: "The frame did not answer in time. Try again.", error: "timeout" },
      status: 504,
    });
    expect(lanAccessOutcomeResponse("lan_access_challenge", { state: "missing" })).toEqual({
      body: { error: "invalid_frame" },
      status: 404,
    });
  });

  it("lets the route override a refusal's status for its own checks", () => {
    expect(lanAccessRefusal("code_required", { status: 400 })).toMatchObject({ error: "code_required", status: 400 });
  });
});

describe("waitForFrameCommand", () => {
  // A db stand-in whose single row walks through `statuses`, one per read,
  // and a clock that only moves when the helper sleeps.
  function harness(rows: ({ status: string; error: string | null } | undefined)[]) {
    let reads = 0;
    let clock = 0;
    const sleeps: number[] = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => {
              const row = rows[Math.min(reads, rows.length - 1)];
              reads += 1;
              return Promise.resolve(row ? [row] : []);
            },
          }),
        }),
      }),
    };
    const options = {
      now: () => clock,
      pollMs: 500,
      sleep: (ms: number) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
      timeoutMs: 2000,
    };
    return {
      get reads() {
        return reads;
      },
      run: () => waitForFrameCommand(db as never, "cmd-1", options),
      sleeps,
    };
  }

  it("returns the ack once the row says so", async () => {
    const h = harness([
      { error: null, status: "pending" },
      { error: null, status: "sent" },
      { error: null, status: "acked" },
    ]);
    await expect(h.run()).resolves.toEqual({ state: "acked" });
    expect(h.reads).toBe(3);
  });

  it("returns the device's refusal and an expiry with their reasons", async () => {
    await expect(harness([{ error: "invalid_code", status: "failed" }]).run()).resolves.toEqual({
      error: "invalid_code",
      state: "failed",
    });
    await expect(harness([{ error: "superseded", status: "expired" }]).run()).resolves.toEqual({
      error: "superseded",
      state: "expired",
    });
    await expect(harness([undefined]).run()).resolves.toEqual({ state: "missing" });
  });

  it("gives up at the deadline and reads the row one last time there", async () => {
    const h = harness([{ error: null, status: "sent" }]);
    await expect(h.run()).resolves.toEqual({ state: "waiting" });
    expect(h.sleeps).toEqual([500, 500, 500, 500]);
    expect(h.reads).toBe(4);
  });
});
