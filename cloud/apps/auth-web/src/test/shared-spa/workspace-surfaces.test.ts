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

const shellSurfaces = ["terminal", "assets", "ping", "debug"] as const;

describe("cloud mode hides everything the protocol cannot do", () => {
  it("offers no Terminal, Assets, Ping or Debug frame tool", () => {
    for (const panel of shellSurfaces) {
      expect(frameToolPanelIsAllowed("cloud", panel)).toBe(false);
      expect(allowedFrameToolPanels.cloud).not.toContain(panel);
    }
  });

  it("offers no Terminal, Assets or Ping scene-tool shortcut", () => {
    for (const panel of ["terminal", "assets", "ping"] as const) {
      expect(sceneToolPanelIsAllowed("cloud", panel)).toBe(false);
    }
  });

  it("offers no generated-Nim Source panel (cloud frames are interpreted)", () => {
    expect(sceneUtilityPanelIsAllowed("cloud", "source")).toBe(false);
    expect(allowedSceneUtilityPanels.cloud).not.toContain("source");
  });

  it("offers no deploy, SD-card build, stop, delete or archive action", () => {
    for (const action of [
      "archive",
      "buildSdCard",
      "cancelDeploy",
      "delete",
      "deploy",
      "deployRemote",
      "localDeploy",
      "restartRemote",
      "stop",
    ] as const) {
      expect(frameMenuActionIsAllowed("cloud", action)).toBe(false);
    }
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
// `unsupported_verb` for set_schedule, set_settings, get_logs, get_metrics
// and notify_update_available (docs/cloud-frames.md "Device profiles";
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

  it("disables schedule, settings and metrics with a reason", () => {
    for (const panel of ["schedule", "settings", "metrics"] as const) {
      expect(frameToolPanelDisabledReason("cloud", panel, esp32Frame)).toEqual(
        expect.stringContaining("ESP32"),
      );
      expect(sceneToolPanelDisabledReason("cloud", panel, esp32Frame)).toEqual(
        expect.stringContaining("ESP32"),
      );
    }
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

  it("keeps Rename visible but disabled (it rides set_settings); render, reboot, restart stay live", () => {
    expect(frameMenuActionIsAllowed("cloud", "rename")).toBe(true);
    expect(frameMenuActionDisabledReason("cloud", "rename", esp32Frame)).toEqual(
      expect.stringContaining("ESP32"),
    );
    for (const action of ["reboot", "render", "restart"] as const) {
      expect(frameMenuActionIsAllowed("cloud", action)).toBe(true);
      expect(frameMenuActionDisabledReason("cloud", action, esp32Frame)).toBeNull();
    }
  });

  it("gates esp32 variants by prefix", () => {
    expect(
      frameToolPanelDisabledReason("cloud", "schedule", {
        hardware: { platform: "esp32-s3" },
      }),
    ).not.toBeNull();
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

  it("derives a logs-only capability set for esp32 and a full one otherwise", () => {
    expect(frameCapabilities(esp32Frame, "cloud")).toEqual(new Set(["logs"]));
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
