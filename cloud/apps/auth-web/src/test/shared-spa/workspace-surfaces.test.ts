import { describe, expect, it } from "vitest";
import {
  addFrameFlows,
  allowedFrameMenuActions,
  allowedFrameSettingsSections,
  allowedGlobalSettingsSections,
  globalSettingsSectionIsAllowed,
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
  isEsp32CloudFrame,
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

  it("keeps only the service-key sections of the GLOBAL settings page", () => {
    // The cloud's /frames/settings page persists service API keys
    // (account_settings via /api/settings) and nothing else: no local
    // account, deploy defaults, SSH keys, build environment, font store,
    // backend PostHog or backend system info.
    expect(allowedGlobalSettingsSections.cloud).toEqual([
      "settings-gallery",
      "settings-openai",
      "settings-home-assistant",
      "settings-github",
      "settings-immich",
      "settings-unsplash",
    ]);
    for (const section of [
      "settings-account",
      "settings-cloud",
      "settings-defaults",
      "settings-ssh",
      "settings-build-environment",
      "settings-fonts",
      "settings-posthog",
      "settings-system",
    ]) {
      expect(globalSettingsSectionIsAllowed("cloud", section)).toBe(false);
    }
    // The storable groups (account-settings.ts) and the visible sections
    // must describe the same six services.
    expect(globalSettingsSectionIsAllowed("cloud", "settings-unsplash")).toBe(
      true,
    );
    // The backend keeps everything (null = all); the on-device admin never
    // mounts this page (urls.settings() routes to the frame's own panel),
    // so its list stays permissive too.
    expect(allowedGlobalSettingsSections.backend).toBeNull();
    expect(globalSettingsSectionIsAllowed("backend", "settings-ssh")).toBe(
      true,
    );
    expect(allowedGlobalSettingsSections.frameAdmin).toBeNull();
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
// frame whose enrollment-reported hardware.platform is "esp32" historically
// answered `unsupported_verb` for schedule/settings/telemetry and
// notify_update_available; the firmware has since implemented all of them —
// notify_update_available last, via the signed cloud OTA path
// (docs/cloud-frames.md "Device profiles"; embedded/esp32/main/fos_cloud.c).
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

  it("links only to the one settings section the compact form renders", () => {
    // FrameSettings replaces the whole form with a name+interval block for
    // this profile (esp32CloudProfile), so the settings sub-nav must collapse
    // to match. It used to be filtered by mode alone and offered all 15 cloud
    // sections — 14 of them scrolling to an anchor that is never rendered.
    expect(frameSettingsSectionIsAllowed("cloud", "frame-settings-info", esp32Frame)).toBe(true);
    for (const section of allowedFrameSettingsSections.cloud) {
      if (section === "frame-settings-info") continue;
      expect(frameSettingsSectionIsAllowed("cloud", section, esp32Frame)).toBe(false);
    }
    // A cloud Pi still gets the full form, so its nav is untouched.
    for (const section of allowedFrameSettingsSections.cloud) {
      expect(frameSettingsSectionIsAllowed("cloud", section, piFrame)).toBe(true);
    }
  });

  it("classifies esp32 variants by prefix", () => {
    // The old probe here (updateNotify missing from the capability set) is
    // gone for the best reason: the firmware now implements the verb via the
    // signed cloud OTA path, so the esp32 profile carries the full set.
    // Prefix matching still gates real surfaces — the Update-firmware menu
    // entry and the USB serial console are offered exactly to
    // isEsp32CloudFrame frames — so pin the classifier itself.
    for (const platform of ["esp32", "esp32-s3", "esp32-c3", "ESP32-S3"]) {
      expect(isEsp32CloudFrame({ hardware: { platform } }, "cloud")).toBe(true);
    }
    expect(isEsp32CloudFrame({ hardware: { platform: "pi-zero2w" } }, "cloud")).toBe(false);
    expect(isEsp32CloudFrame({ hardware: { platform: "esp32" } }, "backend")).toBe(false);
    expect(isEsp32CloudFrame(undefined, "cloud")).toBe(false);
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

  it("derives the FULL capability set for esp32 — updateNotify included — and for everything else", () => {
    // notify_update_available was the last unsupported verb on the esp32
    // profile; the firmware's signed OTA path implements it now, so nothing
    // is gated. The layering stays for the next verb a profile lags on.
    const fullSet = new Set(["schedule", "settings", "logs", "metrics", "updateNotify"]);
    expect(frameCapabilities(esp32Frame, "cloud")).toEqual(fullSet);
    expect(
      frameCapabilities({ hardware: { platform: "esp32-s3" } }, "cloud"),
    ).toEqual(fullSet);
    expect(
      frameCapabilities({ hardware: { platform: "esp32-c3" } }, "cloud"),
    ).toEqual(fullSet);
    expect(frameCapabilities(piFrame, "cloud")).toEqual(fullSet);
  });

  it("offers the Update firmware action on the cloud alone, enabled for esp32", () => {
    // The menu entry enqueues notify_update_available; the backend and the
    // on-device panel have their own firmware flows (deploy drawer / local
    // deploy), so the action is cloud-only.
    expect(frameMenuActionIsAllowed("cloud", "updateFirmware", esp32Frame)).toBe(true);
    expect(frameMenuActionDisabledReason("cloud", "updateFirmware", esp32Frame)).toBeNull();
    expect(frameMenuActionIsAllowed("backend", "updateFirmware")).toBe(false);
    expect(frameMenuActionIsAllowed("frameAdmin", "updateFirmware")).toBe(false);
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

  it("links to no host-OS settings sections", () => {
    // FrameSettings hides these behind its isEmbeddedMode gate — a
    // microcontroller mounts nothing, rotates no host log files, and has
    // neither a configurable assets path nor reboot-behaviour knobs. Virtual
    // frames are embedded mode too, so they lose them as well.
    for (const frame of [esp32Frame, picoFrame, virtualFrame]) {
      for (const section of [
        "frame-settings-mountpoints",
        "frame-settings-assets",
        "frame-settings-logs",
        "frame-settings-reboot",
      ]) {
        expect(frameSettingsSectionIsAllowed("backend", section, frame)).toBe(false);
      }
      // The sections a microcontroller does answer for stay linked.
      expect(frameSettingsSectionIsAllowed("backend", "frame-settings-info", frame)).toBe(true);
      expect(frameSettingsSectionIsAllowed("backend", "frame-http-api-section", frame)).toBe(true);
    }
    // A Pi on the same control plane keeps all of them.
    for (const section of allowedFrameSettingsSections.backend) {
      expect(frameSettingsSectionIsAllowed("backend", section, {})).toBe(true);
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
    // Virtual frames additionally hide metrics and reboot/restart; the
    // embedded-hardware list must not soften that. Assets stay: the backend
    // stores them (quota-limited) and feeds them to the wasm renderer.
    expect(frameToolPanelIsAllowed("backend", "assets", virtualFrame)).toBe(true);
    expect(frameToolPanelIsAllowed("backend", "metrics", virtualFrame)).toBe(false);
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
