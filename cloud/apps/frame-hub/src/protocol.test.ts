import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashSecret } from "../../auth-web/src/lib/secrets";
import { verifyFrameSignature } from "../../auth-web/src/lib/frames";
import {
  commandMessage,
  deviceAuthError,
  frameUpdateEvent,
  isAcceptableChecksum,
  jsonByteLength,
  maxChecksumChars,
  maxSceneIdChars,
  maxStateBytes,
  newLogEvent,
  newMetricsEvent,
  parseJsonMessage,
  parseLogEntries,
  parseLogTimestamp,
  stateWithActiveScene,
  withinJsonByteLimit,
  type FrameRow,
} from "./protocol";

describe("hashSecret (device token hashing)", () => {
  it("is sha256 base64url, matching how link tokens are stored at rest", () => {
    const token = "fc_link_example-token";
    expect(hashSecret(token)).toBe(
      createHash("sha256").update(token).digest("base64url"),
    );
  });
});

describe("verifyFrameSignature (Ed25519 challenge)", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  const publicKeyBase64 = Buffer.from(String(jwk.x), "base64url").toString(
    "base64",
  );
  const nonce = Buffer.from("a".repeat(32));

  it("accepts a signature over the raw nonce bytes", () => {
    const signature = sign(null, nonce, privateKey).toString("base64");
    expect(verifyFrameSignature(publicKeyBase64, nonce, signature)).toBe(true);
  });

  it("rejects a signature over different bytes", () => {
    const signature = sign(null, Buffer.from("b".repeat(32)), privateKey);
    expect(
      verifyFrameSignature(publicKeyBase64, nonce, signature.toString("base64")),
    ).toBe(false);
  });

  it("rejects a signature from another key", () => {
    const other = generateKeyPairSync("ed25519");
    const signature = sign(null, nonce, other.privateKey).toString("base64");
    expect(verifyFrameSignature(publicKeyBase64, nonce, signature)).toBe(false);
  });

  it("rejects malformed inputs without throwing", () => {
    expect(verifyFrameSignature("not-a-key", nonce, "nope")).toBe(false);
    expect(verifyFrameSignature(publicKeyBase64, nonce, "")).toBe(false);
  });
});

describe("deviceAuthError", () => {
  const frame = { status: "active" } as FrameRow;
  const client = (kind: string, scopes: string[]) => ({
    clientKind: kind,
    providerClientMetadata: { requestedScopes: scopes },
  });

  it("rejects a missing linked client", () => {
    expect(deviceAuthError(undefined, frame)).toBe("invalid_link_token");
  });

  it("rejects a backend-kind client even with the scope", () => {
    expect(deviceAuthError(client("backend", ["frame:managed"]), frame)).toBe(
      "not_a_frame",
    );
  });

  it("rejects a frame client without frame:managed", () => {
    expect(deviceAuthError(client("frame", ["telemetry:logs"]), frame)).toBe(
      "insufficient_scope",
    );
  });

  it("rejects when no frames row exists for the linked client", () => {
    expect(deviceAuthError(client("frame", ["frame:managed"]), undefined)).toBe(
      "frame_not_enrolled",
    );
  });

  it("rejects a revoked frame", () => {
    expect(
      deviceAuthError(client("frame", ["frame:managed"]), {
        status: "revoked",
      } as FrameRow),
    ).toBe("frame_revoked");
  });

  it("accepts a frame client with frame:managed", () => {
    expect(
      deviceAuthError(client("frame", ["frame:managed"]), frame),
    ).toBeUndefined();
  });
});

describe("commandMessage", () => {
  it("spreads the payload under the command id and type", () => {
    expect(
      commandMessage({
        id: "cmd-1",
        payload: { scene_id: "abc" },
        type: "set_current_scene",
      }),
    ).toEqual({ id: "cmd-1", scene_id: "abc", type: "set_current_scene" });
  });

  it("never lets the payload override id or type", () => {
    expect(
      commandMessage({
        id: "cmd-1",
        payload: { id: "evil", type: "exec_shell" },
        type: "render",
      }),
    ).toEqual({ id: "cmd-1", type: "render" });
  });

  it("tolerates null and non-object payloads", () => {
    expect(commandMessage({ id: "c", payload: null, type: "reboot" })).toEqual({
      id: "c",
      type: "reboot",
    });
    expect(commandMessage({ id: "c", payload: [1], type: "reboot" })).toEqual({
      id: "c",
      type: "reboot",
    });
  });

  it("ships notify_update_available as a bare advisory frame", () => {
    // The hub's queue is deliberately type-agnostic — the allow-list lives in
    // auth-web's allowedFrameCommandTypes, which enqueues this verb with no
    // payload; the wire frame is just id + type and the device does the rest
    // (signed manifest fetch + verification, docs/cloud-frames.md
    // "Signed OTA").
    expect(
      commandMessage({ id: "cmd-2", payload: null, type: "notify_update_available" }),
    ).toEqual({ id: "cmd-2", type: "notify_update_available" });
  });
});

describe("parseJsonMessage", () => {
  it("parses JSON objects from strings and buffers", () => {
    expect(parseJsonMessage('{"type":"hello"}')).toEqual({ type: "hello" });
    expect(parseJsonMessage(Buffer.from('{"type":"auth"}'))).toEqual({
      type: "auth",
    });
  });

  it("returns undefined for non-objects and garbage", () => {
    expect(parseJsonMessage("[1,2]")).toBeUndefined();
    expect(parseJsonMessage('"hi"')).toBeUndefined();
    expect(parseJsonMessage("not json")).toBeUndefined();
    expect(parseJsonMessage(123)).toBeUndefined();
  });
});

describe("parseLogTimestamp", () => {
  const fallback = new Date("2026-01-01T00:00:00Z");

  it("handles epoch seconds and milliseconds", () => {
    expect(parseLogTimestamp(1_754_000_000, fallback).getTime()).toBe(
      1_754_000_000_000,
    );
    expect(parseLogTimestamp(1_754_000_000_123, fallback).getTime()).toBe(
      1_754_000_000_123,
    );
  });

  it("handles ISO strings and falls back on garbage", () => {
    expect(
      parseLogTimestamp("2026-08-01T12:00:00.000Z", fallback).toISOString(),
    ).toBe("2026-08-01T12:00:00.000Z");
    expect(parseLogTimestamp("nope", fallback)).toBe(fallback);
    expect(parseLogTimestamp(undefined, fallback)).toBe(fallback);
    expect(parseLogTimestamp(-5, fallback)).toBe(fallback);
  });
});

describe("parseLogEntries", () => {
  it("keeps payloads and skips non-object entries", () => {
    const entries = parseLogEntries([
      { payload: { event: "render", line: "ok" }, timestamp: 1_754_000_000 },
      "junk",
      { timestamp: "2026-08-01T12:00:00Z" },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.payload).toEqual({ event: "render", line: "ok" });
    expect(entries[1]?.payload).toBeNull();
  });

  it("returns [] for non-arrays", () => {
    expect(parseLogEntries({ logs: [] })).toEqual([]);
    expect(parseLogEntries(undefined)).toEqual([]);
  });

  // The contract's log_batch entries are {"timestamp", "scene"?, "payload"};
  // frame_logs has no scene column, so the value is folded into the payload
  // rather than dropped.
  it("preserves the optional per-entry scene", () => {
    const entries = parseLogEntries([
      { payload: { line: "ok" }, scene: "clock", timestamp: 1_754_000_000 },
      { payload: "plain text", scene: "weather", timestamp: 1_754_000_000 },
      { payload: { line: "ok", scene: "explicit" }, scene: "outer" },
      { payload: { line: "ok" }, scene: 42 },
    ]);
    expect(entries[0]?.payload).toEqual({ line: "ok", scene: "clock" });
    expect(entries[1]?.payload).toEqual({
      payload: "plain text",
      scene: "weather",
    });
    // An explicit payload.scene wins over the envelope's.
    expect(entries[2]?.payload).toEqual({ line: "ok", scene: "explicit" });
    // A non-string scene is not part of the contract and is ignored.
    expect(entries[3]?.payload).toEqual({ line: "ok" });
  });

  it("caps an absurdly long scene name", () => {
    const [entry] = parseLogEntries([
      { payload: {}, scene: "s".repeat(maxSceneIdChars + 100) },
    ]);
    expect((entry?.payload as { scene: string }).scene).toHaveLength(
      maxSceneIdChars,
    );
  });
});

describe("persisted-value size caps", () => {
  it("measures the serialized JSON size", () => {
    expect(jsonByteLength({ a: 1 })).toBe(7);
    expect(jsonByteLength(undefined)).toBe(4);
    expect(jsonByteLength("ä")).toBe(4);
  });

  it("accepts states within the cap and rejects oversized ones", () => {
    expect(withinJsonByteLimit({ active_scene: "clock" }, maxStateBytes)).toBe(
      true,
    );
    expect(
      withinJsonByteLimit({ blob: "x".repeat(maxStateBytes) }, maxStateBytes),
    ).toBe(false);
  });

  it("treats an over-long checksum as malformed rather than truncating it", () => {
    expect(isAcceptableChecksum("a".repeat(64))).toBe(true);
    expect(isAcceptableChecksum("a".repeat(maxChecksumChars))).toBe(true);
    expect(isAcceptableChecksum("a".repeat(maxChecksumChars + 1))).toBe(false);
    expect(isAcceptableChecksum(undefined)).toBe(false);
    expect(isAcceptableChecksum(12345)).toBe(false);
  });
});

describe("folding the top-level active_scene into last_state", () => {
  // hello/state carry active_scene as a SIBLING of `states`, but only the
  // `states` object is stored — without the fold the id is lost and the
  // workspace cannot name the frame's active scene until a scene_ack.
  it("copies the sibling active_scene into the stored states", () => {
    expect(stateWithActiveScene({ brightness: 1 }, "df0e3976")).toEqual({
      active_scene: "df0e3976",
      brightness: 1,
    });
  });

  it("leaves the states alone when the device put the id inside them", () => {
    const states = { active_scene: "inner" };
    expect(stateWithActiveScene(states, "outer")).toBe(states);
  });

  it("ignores missing, empty and non-string ids", () => {
    const states = { brightness: 1 };
    expect(stateWithActiveScene(states, undefined)).toBe(states);
    expect(stateWithActiveScene(states, "")).toBe(states);
    expect(stateWithActiveScene(states, 42)).toBe(states);
  });

  it("caps a runaway id at the stored scene-id ceiling", () => {
    const folded = stateWithActiveScene({}, "x".repeat(maxSceneIdChars + 50));
    expect((folded.active_scene as string).length).toBe(maxSceneIdChars);
  });
});

describe("browser event shaping", () => {
  it("maps a stored log row to the SPA's new_log shape", () => {
    const event = newLogEvent("frame-uuid", {
      id: 42,
      payload: { event: "render:done", line: "rendered scene", scene: "s1" },
      timestamp: new Date("2026-08-01T12:00:00.000Z"),
    });
    // Structured payloads ship backend-style: type "webhook" with the whole
    // object as the line, which the SPA pretty-renders (event + key=value)
    // instead of showing raw JSON.
    expect(event).toEqual({
      frame_id: "frame-uuid",
      id: 42,
      line: '{"event":"render:done","line":"rendered scene","scene":"s1"}',
      timestamp: "2026-08-01T12:00:00.000Z",
      type: "webhook",
    });
  });

  it("maps a stored metrics row to the SPA's MetricsType shape", () => {
    const event = newMetricsEvent("frame-uuid", {
      id: 7,
      metrics: { load: [0.5] },
      timestamp: new Date("2026-08-01T12:00:00.000Z"),
    });
    expect(event).toEqual({
      frame_id: "frame-uuid",
      id: "7",
      metrics: { load: [0.5] },
      timestamp: "2026-08-01T12:00:00.000Z",
    });
  });

  it("omits the id when the sample was not retained", () => {
    const event = newMetricsEvent("frame-uuid", {
      id: null,
      metrics: { load: [0.5] },
      timestamp: new Date("2026-08-01T12:00:00.000Z"),
    });
    expect("id" in event).toBe(false);
    expect(event.frame_id).toBe("frame-uuid");
  });

  it("falls back to a plain 'log' line for non-object payloads", () => {
    const event = newLogEvent("frame-uuid", {
      id: 1,
      payload: "plain text line",
      timestamp: new Date("2026-08-01T12:00:00.000Z"),
    });
    expect(event.type).toBe("log");
    expect(event.line).toBe('"plain text line"');
  });

  it("builds update_frame data as the frame summary plus live state", () => {
    const now = new Date("2026-08-01T12:00:00.000Z");
    const frame = {
      accountId: "acct",
      assignedChecksum: "want",
      connected: true,
      createdAt: now,
      frameosVersion: "2026.8.1",
      hardware: { platform: "pi-zero2w" },
      hubSessionId: "hub-1",
      id: "frame-uuid",
      lastMetrics: { cpu: 1 },
      lastSeenAt: now,
      lastState: { active_scene: "s1" },
      linkedClientId: "lc-1",
      name: "Kitchen frame",
      publicKey: "pk",
      schedule: { events: [] },
      scenesChecksum: "have",
      assignedSceneState: { "store-a": { checksum: "aaa", version: 1 } },
      deployedSceneState: { "store-a": { checksum: "aaa", version: 1 } },
      // Denormalized scene-declared service settings groups. Group NAMES
      // travel to the browser (so the workspace can say which keys this
      // frame's scenes want); no field or value ever does.
      serviceSettingGroups: ["unsplash"],
      settings: { interval: 300, rotate: 90 },
      status: "active",
      updatedAt: now,
    } satisfies FrameRow;
    expect(frameUpdateEvent(frame)).toEqual({
      assigned_checksum: "want",
      assigned_scene_state: { "store-a": { checksum: "aaa", version: 1 } },
      connected: true,
      created_at: now,
      deployed_scene_state: { "store-a": { checksum: "aaa", version: 1 } },
      frameos_version: "2026.8.1",
      hardware: { platform: "pi-zero2w" },
      id: "frame-uuid",
      // The last-pushed settings ride along as top-level fields, in the
      // device's spelling — that is what the SPA's frameForm hydrates from.
      interval: 300,
      last_metrics: { cpu: 1 },
      last_seen_at: now,
      last_state: { active_scene: "s1" },
      linked_client_id: "lc-1",
      name: "Kitchen frame",
      rotate: 90,
      scenes_checksum: "have",
      schedule: { events: [] },
      service_setting_groups: ["unsplash"],
      status: "active",
    });
  });

  it("reports the service-settings switch only when the link is supplied", () => {
    const now = new Date("2026-08-01T12:00:00.000Z");
    const frame = {
      accountId: "acct",
      assignedChecksum: null,
      connected: false,
      createdAt: now,
      frameosVersion: null,
      hardware: null,
      hubSessionId: null,
      id: "frame-uuid",
      lastMetrics: null,
      lastSeenAt: null,
      lastState: null,
      linkedClientId: "lc-1",
      name: "Kitchen frame",
      publicKey: "pk",
      schedule: null,
      scenesChecksum: null,
      assignedSceneState: null,
      deployedSceneState: null,
      serviceSettingGroups: null,
      settings: null,
      status: "active",
      updatedAt: now,
    } satisfies FrameRow;

    // No link: the field is absent, not false. The SPA merges update_frame
    // over the frame it holds, so absent means "unchanged" rather than
    // "switched off".
    expect("service_settings_enabled" in frameUpdateEvent(frame)).toBe(false);
    // A NULL column reads as "declares nothing" on the wire.
    expect(frameUpdateEvent(frame).service_setting_groups).toEqual([]);

    expect(
      frameUpdateEvent(frame, {
        providerClientMetadata: {
          requestedScopes: ["frame:managed", "settings:services"],
        },
      }).service_settings_enabled,
    ).toBe(true);
    expect(
      frameUpdateEvent(frame, {
        providerClientMetadata: { requestedScopes: ["frame:managed"] },
      }).service_settings_enabled,
    ).toBe(false);
  });
});
