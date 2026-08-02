import { describe, expect, it } from "vitest";
import {
  allowedFrameMenuActions,
  allowedFrameSettingsSections,
  allowedFrameToolPanels,
  allowedSceneToolPanels,
  allowedSceneUtilityPanels,
  frameMenuActionIsAllowed,
  frameSettingsSectionIsAllowed,
  frameToolPanelIsAllowed,
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
