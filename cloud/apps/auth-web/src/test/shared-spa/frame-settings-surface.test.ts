import { describe, expect, it } from "vitest";
import {
  frameSettingsNavAnchorsForMode,
  frameSettingsNavDrift,
  frameSettingsSectionRenders,
  frameSettingsSections,
  frameSettingsSurfaceFor,
  surfacesForWorkspaceMode,
  type FrameSettingsSurface,
} from "../../../../../../frontend/src/scenes/frame/panels/FrameSettings/frameSettingsSurface";
import {
  allowedFrameSettingsSections,
  type WorkspaceMode,
} from "../../../../../../frontend/src/scenes/workspace/workspaceSurfaces";

// FrameSettings.tsx used to be one 4,300-line component whose surface gating
// was forty nested ternaries over `cloudProfile`, `esp32CloudProfile`,
// `inFrameAdminMode` and `hideForCloud`. Nobody could read it, and it drifted:
// commit 97c8c750 swept the cloud's "SSH keys" section into the
// `!cloudProfile` branch, so the settings nav offered a link to an anchor no
// cloud frame rendered — and a cloud frame's SD-card keys could not be edited
// at all. That is the bug this file exists to make impossible.
//
// frameSettingsSurface.ts is now the panel's only gate. These tests pin it
// against the nav list in workspaceSurfaces.ts, in both directions.

const modes: WorkspaceMode[] = ["backend", "frameAdmin", "cloud"];
const surfaces: FrameSettingsSurface[] = ["backend", "frameAdmin", "cloudLinux", "cloudEsp32"];

describe("the settings nav and the settings panel agree", () => {
  for (const mode of modes) {
    it(`${mode}: every nav link points at a section this mode renders`, () => {
      expect(frameSettingsNavDrift(mode).extra).toEqual([]);
    });

    it(`${mode}: every linkable section the panel renders has a nav link`, () => {
      // A section may opt out with `nav: []` — that is a decision, and it has
      // to be written down in `navNote` next to it, not discovered by
      // scrolling a component.
      expect(frameSettingsNavDrift(mode).missing).toEqual([]);
    });

    it(`${mode}: the two lists are exactly equal`, () => {
      expect([...frameSettingsNavAnchorsForMode(mode)].sort()).toEqual(
        [...allowedFrameSettingsSections[mode]].sort(),
      );
    });
  }
});

describe("the section table is well formed", () => {
  it("has a unique key per section", () => {
    const keys = frameSettingsSections.map((section) => section.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("renders every section on at least one surface", () => {
    for (const section of frameSettingsSections) {
      expect(section.surfaces.length, `${section.key} renders nowhere`).toBeGreaterThan(0);
    }
  });

  it("links a section only on a surface that renders it", () => {
    for (const section of frameSettingsSections) {
      for (const surface of section.nav ?? []) {
        expect(
          section.surfaces.includes(surface),
          `${section.key} is linked on ${surface} but not rendered there`,
        ).toBe(true);
      }
    }
  });

  it("explains every section that renders without a nav link", () => {
    for (const section of frameSettingsSections) {
      if (section.anchor && section.nav?.length === 0) {
        expect(section.navNote, `${section.key} opts out of the nav without saying why`).toBeTruthy();
      }
    }
  });

  it("gives an anchor to every section a nav could link", () => {
    for (const section of frameSettingsSections) {
      if (!section.anchor) {
        expect(section.nav ?? [], `${section.key} has no anchor but claims nav links`).toEqual([]);
      }
    }
  });
});

describe("surfaces", () => {
  it("resolves a cloud-managed ESP32 to its own narrower surface", () => {
    const esp32 = { managed_by: "cloud", hardware: { platform: "esp32-s3" } };
    expect(frameSettingsSurfaceFor("cloud", esp32 as never)).toBe("cloudEsp32");
    expect(frameSettingsSurfaceFor("cloud", { hardware: { platform: "raspberry-pi-64" } } as never)).toBe(
      "cloudLinux",
    );
    expect(frameSettingsSurfaceFor("backend", null)).toBe("backend");
    expect(frameSettingsSurfaceFor("frameAdmin", null)).toBe("frameAdmin");
  });

  it("covers every surface with the mode that reaches it", () => {
    const reachable = new Set(modes.flatMap((mode) => surfacesForWorkspaceMode[mode]));
    expect([...reachable].sort()).toEqual([...surfaces].sort());
  });
});

describe("what each surface may render", () => {
  it("keeps SSH keys on a cloud Linux frame and off a cloud ESP32", () => {
    // The regression above: the account's SSH keys are written into SD cards
    // built for a cloud Linux frame, so the section belongs there. An ESP32 is
    // flashed, not imaged, and has no sshd.
    expect(frameSettingsSectionRenders("cloud-ssh-keys", "cloudLinux")).toBe(true);
    expect(frameSettingsSectionRenders("cloud-ssh-keys", "cloudEsp32")).toBe(false);
    expect(frameSettingsSectionRenders("cloud-ssh-keys", "backend")).toBe(false);
  });

  it("keeps Power off a cloud Linux frame", () => {
    // The Pi runtime's CLOUD_SETTINGS_ALLOWLIST has no power keys, and
    // set_settings refuses the whole push on the first unknown key.
    expect(frameSettingsSectionRenders("cloud-esp32-power", "cloudLinux")).toBe(false);
    expect(frameSettingsSectionRenders("cloud-esp32-power", "cloudEsp32")).toBe(true);
  });

  it("keeps the device-owned sections off both cloud surfaces", () => {
    for (const key of [
      "device-settings",
      "network",
      "mountpoints",
      "palette",
      "assets",
      "logs",
      "reboot",
      "http-api",
      "https-proxy",
      "backend-access",
      "frame-admin-panel",
      "ssh",
      "remote-agent",
    ]) {
      expect(frameSettingsSectionRenders(key, "cloudLinux"), `${key} on cloudLinux`).toBe(false);
      expect(frameSettingsSectionRenders(key, "cloudEsp32"), `${key} on cloudEsp32`).toBe(false);
    }
  });

  it("keeps SSH and the remote agent off the on-device panel", () => {
    // The frame is the thing being administered; it does not SSH into itself.
    expect(frameSettingsSectionRenders("ssh", "frameAdmin")).toBe(false);
    expect(frameSettingsSectionRenders("remote-agent", "frameAdmin")).toBe(false);
  });
});
