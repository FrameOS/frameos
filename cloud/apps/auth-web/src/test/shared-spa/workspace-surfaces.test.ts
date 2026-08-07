import { describe, expect, it } from "vitest";
import {
  addFrameFlows,
  allowedFrameMenuActions,
  allowedFrameSettingsSections,
  allowedFrameToolPanels,
  allowedSceneToolPanels,
  allowedSceneUtilityPanels,
  frameCapabilities,
  frameMenuActionDisabledReason,
  frameMenuActionIsAllowed,
  frameSettingsSectionIsAllowed,
  frameSupportsUsbSerialConsole,
  frameToolPanelDisabledReason,
  frameToolPanelIsAllowed,
  isEmbeddedHardwareFrame,
  isVirtualFrame,
  sceneToolPanelDisabledReason,
  sceneToolPanelIsAllowed,
  sceneUtilityPanelIsAllowed,
} from "../../../../../../frontend/src/scenes/workspace/workspaceSurfaces";

// The shared SPA (frontend/src) renders the cloud fleet UI as well as the
// self-hosted backend and the on-device admin panel. Cloud-managed frames
// speak a four-verb protocol over an outbound WebSocket: no shell, no files,
// no deploy, no SSH. Gating used to be `isCloudMode()` sprinkled across eight
// components — a deny-list, so anything new was cloud-visible by default and
// shipped a button that always errored.
//
// These tests pin the allow-list. They live here because frontend/ has no
// test runner; the module under test is free of React, kea and the DOM.

const shellSurfaces = ["terminal", "ping", "debug"] as const;

describe("cloud mode hides everything the protocol cannot do", () => {
  it("offers no Terminal, Ping or Debug frame tool", () => {
    for (const panel of shellSurfaces) {
      expect(frameToolPanelIsAllowed("cloud", panel)).toBe(false);
      expect(allowedFrameToolPanels.cloud).not.toContain(panel);
    }
  });

  it("offers no Terminal or Ping scene-tool shortcut", () => {
    for (const panel of ["terminal", "ping"] as const) {
      expect(sceneToolPanelIsAllowed("cloud", panel)).toBe(false);
    }
  });

  it("offers the Assets panel (the read-only assets_list/asset_get pair)", () => {
    expect(frameToolPanelIsAllowed("cloud", "assets")).toBe(true);
    expect(sceneToolPanelIsAllowed("cloud", "assets")).toBe(true);
  });

  it("offers no generated-Nim Source panel (cloud frames are interpreted)", () => {
    expect(sceneUtilityPanelIsAllowed("cloud", "source")).toBe(false);
    expect(allowedSceneUtilityPanels.cloud).not.toContain("source");
  });

  it("offers no deploy, SD-card build, stop or archive action", () => {
    for (const action of [
      "archive",
      "buildSdCard",
      "cancelDeploy",
      "deploy",
      "deployRemote",
      "localDeploy",
      "restartRemote",
      "stop",
    ] as const) {
      expect(frameMenuActionIsAllowed("cloud", action)).toBe(false);
    }
  });

  it("offers delete (revoke + drop the row, DELETE /api/frames/{id})", () => {
    expect(frameMenuActionIsAllowed("cloud", "delete")).toBe(true);
  });

  it("links to no SSH, Remote-agent or backend-access settings section", () => {
    for (const section of [
      "frame-settings-ssh",
      "frame-settings-agent",
      "frame-settings-backend",
    ]) {
      expect(frameSettingsSectionIsAllowed("cloud", section)).toBe(false);
      expect(allowedFrameSettingsSections.cloud).not.toContain(section);
    }
  });
});

describe("cloud mode keeps what the protocol does implement", () => {
  // allowedFrameCommandTypes in src/lib/frames.ts: reboot, render,
  // restart_runtime, set_current_scene. Reboot and restart used to be hidden
  // behind the same deny-list as deploy even though the cloud supports them.
  it("offers render, reboot, restart and rename", () => {
    for (const action of ["reboot", "rename", "render", "restart"] as const) {
      expect(frameMenuActionIsAllowed("cloud", action)).toBe(true);
    }
  });

  it("keeps the scenes, settings, preview, schedule, logs and metrics tools", () => {
    for (const panel of [
      "overview",
      "settings",
      "preview",
      "schedule",
      "logs",
      "metrics",
    ] as const) {
      expect(frameToolPanelIsAllowed("cloud", panel)).toBe(true);
    }
  });
});

// The mode allow-lists say what a control plane implements; the device
// profile says what the frame on the other end implements. A cloud-managed
// frame whose enrollment-reported hardware.platform is "esp32" answers
// `unsupported_verb` for set_schedule, get_logs, get_metrics and
// notify_update_available; set_settings it implements for the
// interval/name subset (docs/cloud-frames.md "Device profiles";
// embedded/esp32/main/fos_cloud.c).
//
// The profile DISABLES those controls with an explanation - it never hides
// them (hiding made the workspace look gutted for esp32 frames). And Logs
// stay fully functional: the cloud never uses get_logs - frames push log
// batches over the hub WS and the panel reads them back from the cloud's
// store (GET /api/frames/{id}/logs).
describe("the esp32 cloud device profile", () => {
  const esp32Frame = { hardware: { platform: "esp32" } };
  const piFrame = { hardware: { platform: "pi-zero2w" } };

  it("keeps every cloud panel visible (visibility is the mode's business)", () => {
    for (const panel of [
      "overview",
      "preview",
      "schedule",
      "settings",
      "logs",
      "metrics",
    ] as const) {
      expect(frameToolPanelIsAllowed("cloud", panel)).toBe(true);
    }
  });

  it("keeps schedule and metrics enabled — the firmware speaks set_schedule and pushes metrics", () => {
    for (const panel of ["schedule", "metrics"] as const) {
      expect(frameToolPanelDisabledReason("cloud", panel, esp32Frame)).toBeNull();
      expect(sceneToolPanelDisabledReason("cloud", panel, esp32Frame)).toBeNull();
    }
  });

  it("keeps Settings enabled - the firmware persists the interval/name subset via set_settings", () => {
    expect(frameToolPanelDisabledReason("cloud", "settings", esp32Frame)).toBeNull();
    expect(sceneToolPanelDisabledReason("cloud", "settings", esp32Frame)).toBeNull();
  });

  it("keeps Logs enabled - they are pushed to the cloud, not pulled via get_logs", () => {
    expect(frameToolPanelDisabledReason("cloud", "logs", esp32Frame)).toBeNull();
    expect(sceneToolPanelDisabledReason("cloud", "logs", esp32Frame)).toBeNull();
  });

  it("never disables overview or preview", () => {
    for (const panel of ["overview", "preview"] as const) {
      expect(frameToolPanelDisabledReason("cloud", panel, esp32Frame)).toBeNull();
    }
  });

  it("keeps Rename live (the name is provider-side data, no set_settings needed); render, reboot, restart stay live", () => {
    // Renaming updates frames.name in the cloud DB — the device never has to
    // accept anything — so the esp32 profile's missing set_settings verb no
    // longer gates it (POST /api/frames/{id}/settings applies `name`
    // server-side and skips the enqueue for esp32).
    for (const action of ["reboot", "rename", "render", "restart"] as const) {
      expect(frameMenuActionIsAllowed("cloud", action)).toBe(true);
      expect(frameMenuActionDisabledReason("cloud", action, esp32Frame)).toBeNull();
    }
  });

  it("gates esp32 variants by prefix", () => {
    // updateNotify is the one capability the esp32 profile still lacks —
    // prefix-matched so "esp32-s3"/"esp32-c3" variants gate identically.
    expect(
      frameCapabilities({ hardware: { platform: "esp32-s3" } }, "cloud").has("updateNotify"),
    ).toBe(false);
    expect(
      frameCapabilities({ hardware: { platform: "esp32-c3" } }, "cloud").has("updateNotify"),
    ).toBe(false);
  });

  it("leaves Pi/Linux cloud frames the full cloud surface", () => {
    for (const panel of ["schedule", "settings", "logs", "metrics"] as const) {
      expect(frameToolPanelDisabledReason("cloud", panel, piFrame)).toBeNull();
      expect(sceneToolPanelDisabledReason("cloud", panel, piFrame)).toBeNull();
    }
    expect(frameMenuActionDisabledReason("cloud", "rename", piFrame)).toBeNull();
  });

  it("treats a frame without a hardware report as full-profile", () => {
    // Backend frames have no hardware column, and the frame row may not have
    // loaded yet - the mode allow-list alone must keep gating then.
    for (const frame of [undefined, null, {}, { hardware: null }]) {
      expect(frameToolPanelDisabledReason("cloud", "schedule", frame)).toBeNull();
    }
  });

  it("only applies on the cloud control plane", () => {
    // A backend- or admin-managed ESP32 frame gets schedule/logs/settings
    // through its own channels (serial, the on-device admin), not the cloud WS.
    for (const mode of ["backend", "frameAdmin"] as const) {
      expect(frameToolPanelDisabledReason(mode, "schedule", esp32Frame)).toBeNull();
      expect(frameMenuActionDisabledReason(mode, "rename", esp32Frame)).toBeNull();
    }
  });

  it("derives an everything-but-updateNotify capability set for esp32 and a full one otherwise", () => {
    expect(frameCapabilities(esp32Frame, "cloud")).toEqual(
      new Set(["logs", "settings", "schedule", "metrics"]),
    );
    expect(frameCapabilities(piFrame, "cloud")).toEqual(
      new Set(["schedule", "settings", "logs", "metrics", "updateNotify"]),
    );
  });

  it("offers the USB serial console only to esp32 cloud frames", () => {
    // WebSerial log streaming is the debugging path for a board that never
    // joins WiFi. The backend/on-device planes probe frame.mode === 'embedded'
    // separately; this helper is the cloud's device-profile probe.
    expect(frameSupportsUsbSerialConsole(esp32Frame, "cloud")).toBe(true);
    expect(
      frameSupportsUsbSerialConsole(
        { hardware: { platform: "esp32-s3" } },
        "cloud",
      ),
    ).toBe(true);
    expect(frameSupportsUsbSerialConsole(piFrame, "cloud")).toBe(false);
    expect(frameSupportsUsbSerialConsole(esp32Frame, "backend")).toBe(false);
    expect(frameSupportsUsbSerialConsole(undefined, "cloud")).toBe(false);
  });
});

// Embedded-hardware frames (backend-managed ESP32/Pico boards, i.e.
// mode === 'embedded' with any platform except the no-hardware 'virtual')
// HIDE the surfaces whose concepts don't exist on a microcontroller: there is
// no shell to open and no SSH to ping over, no SD card to build, no FrameOS
// Remote agent, and no "stop" when the firmware IS the runtime. Everything
// the firmware's HTTP API serves — assets, logs, metrics, schedule, settings,
// reboot/restart/render/deploy — stays visible.
describe("embedded-hardware frames on the backend control plane", () => {
  const esp32Frame = { embedded: { platform: "esp32-s3" } };
  const esp32c3Frame = { embedded: { platform: "esp32-c3" } };
  const picoFrame = { embedded: { platform: "pico-w" } };
  const virtualFrame = { embedded: { platform: "virtual" } };

  it("classifies platforms", () => {
    expect(isEmbeddedHardwareFrame(esp32Frame)).toBe(true);
    expect(isEmbeddedHardwareFrame(esp32c3Frame)).toBe(true);
    expect(isEmbeddedHardwareFrame(picoFrame)).toBe(true);
    expect(isEmbeddedHardwareFrame(virtualFrame)).toBe(false);
    expect(isVirtualFrame(virtualFrame)).toBe(true);
    for (const frame of [undefined, null, {}, { embedded: null }, { embedded: {} }]) {
      expect(isEmbeddedHardwareFrame(frame)).toBe(false);
    }
  });

  it("hides the Terminal and Ping panels (no shell, no SSH)", () => {
    for (const panel of ["terminal", "ping"] as const) {
      expect(frameToolPanelIsAllowed("backend", panel, esp32Frame)).toBe(false);
      expect(sceneToolPanelIsAllowed("backend", panel, esp32Frame)).toBe(false);
    }
  });

  it("keeps assets, logs, metrics, schedule and settings (served by the firmware HTTP API)", () => {
    for (const panel of ["assets", "logs", "metrics", "schedule", "settings"] as const) {
      expect(frameToolPanelIsAllowed("backend", panel, esp32Frame)).toBe(true);
      expect(frameToolPanelDisabledReason("backend", panel, esp32Frame)).toBeNull();
    }
  });

  it("hides SD-card build, Remote deploy/restart and stop", () => {
    for (const action of [
      "buildSdCard",
      "deployRemote",
      "restartRemote",
      "stop",
    ] as const) {
      expect(frameMenuActionIsAllowed("backend", action, esp32Frame)).toBe(false);
      expect(frameMenuActionIsAllowed("backend", action, picoFrame)).toBe(false);
    }
  });

  it("keeps reboot, restart, render and deploy", () => {
    for (const action of ["reboot", "restart", "render", "deploy"] as const) {
      expect(frameMenuActionIsAllowed("backend", action, esp32Frame)).toBe(true);
      expect(frameMenuActionDisabledReason("backend", action, esp32Frame)).toBeNull();
    }
  });

  it("leaves virtual frames to the stricter virtual gating", () => {
    // Virtual frames additionally hide assets/metrics and reboot/restart;
    // the embedded-hardware list must not soften that.
    expect(frameToolPanelIsAllowed("backend", "assets", virtualFrame)).toBe(false);
    expect(frameMenuActionIsAllowed("backend", "reboot", virtualFrame)).toBe(false);
  });

  it("leaves Linux frames the full backend surface", () => {
    for (const frame of [undefined, {}, { embedded: null }]) {
      expect(frameToolPanelIsAllowed("backend", "terminal", frame)).toBe(true);
      expect(frameMenuActionIsAllowed("backend", "stop", frame)).toBe(true);
    }
  });
});

describe("the other two control planes are unchanged", () => {
  it("keeps the backend's full surface", () => {
    for (const panel of shellSurfaces) {
      expect(frameToolPanelIsAllowed("backend", panel)).toBe(true);
    }
    expect(frameMenuActionIsAllowed("backend", "deploy")).toBe(true);
    expect(frameSettingsSectionIsAllowed("backend", "frame-settings-ssh")).toBe(
      true,
    );
  });

  it("keeps the on-device panel's shell-free surface", () => {
    expect(frameToolPanelIsAllowed("frameAdmin", "terminal")).toBe(false);
    expect(frameToolPanelIsAllowed("frameAdmin", "ping")).toBe(false);
    expect(frameToolPanelIsAllowed("frameAdmin", "assets")).toBe(true);
    expect(frameMenuActionIsAllowed("frameAdmin", "localDeploy")).toBe(true);
    expect(frameMenuActionIsAllowed("frameAdmin", "deploy")).toBe(false);
  });
});

describe("allow-list hygiene", () => {
  // The whole point: a surface is invisible until someone lists it. Guard
  // against a mode's list silently becoming a superset of the backend's.
  it("never grants a restricted mode more than the backend has", () => {
    const lists = [
      [allowedFrameToolPanels, "frame tools"],
      [allowedSceneToolPanels, "scene tools"],
      [allowedSceneUtilityPanels, "scene utilities"],
      [allowedFrameSettingsSections, "settings sections"],
    ] as const;
    for (const [list, label] of lists) {
      for (const mode of ["cloud", "frameAdmin"] as const) {
        const extra = (list[mode] as readonly string[]).filter(
          (entry) => !(list.backend as readonly string[]).includes(entry),
        );
        expect(extra, `${label} allowed in ${mode} but not backend`).toEqual(
          [],
        );
      }
    }
  });

  it("lists no duplicates", () => {
    for (const list of [
      allowedFrameToolPanels,
      allowedSceneToolPanels,
      allowedSceneUtilityPanels,
      allowedFrameMenuActions,
      allowedFrameSettingsSections,
    ]) {
      for (const entries of Object.values(list)) {
        expect(new Set(entries).size).toBe(entries.length);
      }
    }
  });
});

describe("Add frame opens the flow its control plane implements", () => {
  // The cloud has no POST /api/frames/new — a frame gets there by enrolling
  // itself with a claim code — so the workspace's "Add frame" button used to
  // open the self-hosted creation form and 405 on submit. The cloud bundle
  // registers its own enrollment panel instead (claim codes, SD images, ESP32
  // flashing); everything else keeps the backend form.
  it("sends cloud mode to the enrollment panel", () => {
    expect(addFrameFlows.cloud).toBe("cloudPanel");
  });

  it("leaves the backend and the on-device panel on the creation form", () => {
    expect(addFrameFlows.backend).toBe("backendForm");
    expect(addFrameFlows.frameAdmin).toBe("backendForm");
  });
});
