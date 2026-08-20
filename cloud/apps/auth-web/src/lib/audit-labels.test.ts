import { describe, expect, it } from "vitest";
import {
  auditEventDetail,
  auditEventLabel,
  summarizeAuditActor,
} from "./audit-labels";

// Every frame.* event type the cloud writes (auth-web routes + frame-hub)
// must have a human label: the Activity panel renders what this returns,
// and an unlabeled event shows up as its raw type — readable, but a
// regression. Keep this list in sync with the writers.
const frameEventTypes = [
  "frame.asset_deleted",
  "frame.asset_mkdir",
  "frame.asset_renamed",
  "frame.asset_uploaded",
  "frame.assets_synced",
  "frame.claim_token_created",
  "frame.claim_tokens_recycled",
  "frame.command_cancelled",
  "frame.command_sent",
  "frame.confirmed",
  "frame.connected",
  "frame.deleted",
  "frame.disconnected",
  "frame.enrolled",
  "frame.firmware_version_changed",
  "frame.re_enrolled",
  "frame.rebind_token_created",
  "frame.renamed",
  "frame.revoked",
  "frame.scenes_applied",
  "frame.scenes_assigned",
  "frame.schedule_pushed",
  "frame.service_settings_scope_changed",
  "frame.session_kicked",
  "frame.settings_pushed",
  "frame.telemetry_scope_changed",
];

describe("auditEventLabel", () => {
  it("labels every frame event the cloud records", () => {
    for (const eventType of frameEventTypes) {
      expect(auditEventLabel(eventType), eventType).not.toBe(eventType);
    }
  });

  it("falls back to the raw type for unknown events", () => {
    expect(auditEventLabel("frame.something_new")).toBe("frame.something_new");
  });
});

describe("auditEventDetail for frame metadata", () => {
  it("renders a command type, and prefers the event name for event sends", () => {
    expect(auditEventDetail({ type: "set_current_scene" })).toBe(
      "set current scene",
    );
    expect(auditEventDetail({ event: "nextScene", type: "event" })).toBe(
      "event nextScene",
    );
  });

  it("renders a rename as old → new", () => {
    expect(auditEventDetail({ from: "Kitchen", to: "Hallway" })).toBe(
      "Kitchen → Hallway",
    );
    expect(auditEventDetail({ from: "2026.8.1", to: "2026.8.31" })).toBe(
      "2026.8.1 → 2026.8.31",
    );
  });

  it("renders pushed settings keys", () => {
    expect(auditEventDetail({ keys: ["name", "interval"] })).toBe(
      "name, interval",
    );
  });

  it("prefers scene names over the count", () => {
    expect(
      auditEventDetail({
        checksum: "abc",
        sceneCount: 2,
        sceneNames: ["Clock", "Weather"],
      }),
    ).toBe("Clock, Weather");
    expect(auditEventDetail({ checksum: "abc", sceneCount: 3 })).toBe(
      "3 scenes",
    );
  });

  it("renders asset paths, never contents", () => {
    expect(auditEventDetail({ bytes: 12, path: "fonts/Foo.ttf" })).toBe(
      "fonts/Foo.ttf",
    );
    expect(auditEventDetail({ dst: "b.png", src: "a.png" })).toBe(
      "a.png → b.png",
    );
    expect(
      auditEventDetail({ failed: 0, path: "fonts", skipped: 3, uploaded: 2 }),
    ).toBe("fonts · 2 uploaded, 3 skipped");
  });

  it("renders the connect version and a disconnect reason", () => {
    expect(
      auditEventDetail({ frameosVersion: "2026.8.31", scenesChecksum: "x" }),
    ).toBe("FrameOS 2026.8.31");
    expect(auditEventDetail({ reason: "connection_lost" })).toBe(
      "connection_lost",
    );
  });

  it("renders schedule and scope pushes", () => {
    expect(auditEventDetail({ disabled: true, events: 1 })).toBe(
      "1 event (disabled)",
    );
    expect(auditEventDetail({ enabled: false })).toBe("disabled");
    expect(auditEventDetail({ via: "claim_token" })).toBe("via claim token");
  });

  it("returns undefined when there is nothing to say", () => {
    expect(auditEventDetail(undefined)).toBeUndefined();
    expect(auditEventDetail({})).toBeUndefined();
    expect(auditEventDetail([1, 2])).toBeUndefined();
  });
});

describe("summarizeAuditActor", () => {
  it("reduces actors to account / device / system, keeping the IP", () => {
    expect(
      summarizeAuditActor({
        accountId: "acc-1",
        ip: "203.0.113.9",
        providerSubject: "sub",
      }),
    ).toEqual({ accountId: "acc-1", ip: "203.0.113.9", kind: "account" });
    expect(summarizeAuditActor({ frameId: "f", kind: "device" })).toEqual({
      kind: "device",
    });
    expect(
      summarizeAuditActor({ claimTokenId: "t", kind: "frame_enrollment" }),
    ).toEqual({ kind: "device" });
    expect(summarizeAuditActor(null)).toEqual({ kind: "system" });
    expect(summarizeAuditActor({ kind: "sweep" })).toEqual({ kind: "system" });
  });
});
