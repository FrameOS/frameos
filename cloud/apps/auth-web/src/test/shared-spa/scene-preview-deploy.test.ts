import { describe, expect, it } from "vitest";
import {
  chooseSceneDeployPath,
  describeRenderRate,
  formatFps,
  livePreviewStatusText,
  type ChooseSceneDeployPathInput,
  type SceneDeployPath,
} from "../../../../../../frontend/src/utils/scenePreviewDeploy";
import { normalizeSceneActionKey } from "../../../../../../frontend/src/utils/sceneActions";

// The scene editor's Preview drawer has one primary button, "Deploy to
// frame", and it picks what to actually do on its own: send the whole edited
// scene when there are pending edits, activate by id when there are none.
// The mechanism only ever shows up in the tooltip (docs/ui-vocabulary.md:
// the label stays a verb from the list). These two modules are pure so both
// the button and its tooltip read the same rule — and so this test can
// import them without dragging the component graph into auth-web's tsc.

type Mode = ChooseSceneDeployPathInput["mode"];

const MODES: Mode[] = ["backend", "cloud", "frameAdmin"];
const BOOLS = [false, true];

describe("chooseSceneDeployPath", () => {
  it("covers every mode × changes × active combination with a path and a tooltip", () => {
    const seen: Array<[Mode, boolean, boolean, SceneDeployPath]> = [];
    for (const mode of MODES) {
      for (const sceneHasChanges of BOOLS) {
        for (const isActiveScene of BOOLS) {
          const choice = chooseSceneDeployPath({ mode, sceneHasChanges, isActiveScene });
          expect(choice.description.length).toBeGreaterThan(0);
          seen.push([mode, sceneHasChanges, isActiveScene, choice.path]);
        }
      }
    }
    expect(seen).toEqual([
      ["backend", false, false, "activate"],
      ["backend", false, true, "apply"],
      ["backend", true, false, "uploadScenes"],
      ["backend", true, true, "uploadScenes"],
      ["cloud", false, false, "activate"],
      ["cloud", false, true, "apply"],
      ["cloud", true, false, "cloudDeployScenes"],
      ["cloud", true, true, "cloudDeployScenes"],
      ["frameAdmin", false, false, "activate"],
      ["frameAdmin", false, true, "apply"],
      ["frameAdmin", true, false, "saveThenUploadScenes"],
      ["frameAdmin", true, true, "saveThenUploadScenes"],
    ]);
  });

  it("sends the edited scene to a backend frame without saving it", () => {
    for (const isActiveScene of BOOLS) {
      const choice = chooseSceneDeployPath({
        mode: "backend",
        sceneHasChanges: true,
        isActiveScene,
      });
      expect(choice.path).toBe("uploadScenes");
      // D2: the point of this path is that it does NOT save or deploy.
      expect(choice.description).toMatch(/without saving/i);
    }
  });

  it("uses the cloud's own durable push for a cloud frame", () => {
    for (const isActiveScene of BOOLS) {
      const choice = chooseSceneDeployPath({
        mode: "cloud",
        sceneHasChanges: true,
        isActiveScene,
      });
      // The cloud push replaces the frame's scene list, so it is not the
      // backend's fire-and-forget upload and must not claim to skip saving.
      expect(choice.path).toBe("cloudDeployScenes");
      expect(choice.description).toMatch(/deploys/i);
      expect(choice.description).not.toMatch(/without saving/i);
    }
  });

  it("saves first on the device, and each mode says so differently", () => {
    const pending = { sceneHasChanges: true, isActiveScene: false };
    const device = chooseSceneDeployPath({ mode: "frameAdmin", ...pending });
    const backend = chooseSceneDeployPath({ mode: "backend", ...pending });
    const cloud = chooseSceneDeployPath({ mode: "cloud", ...pending });
    expect(device.path).toBe("saveThenUploadScenes");
    // On the device the scene lives on the frame, so "preview" IS a save.
    expect(device.description).toMatch(/saves/i);
    expect(device.description).not.toMatch(/without saving/i);
    // Three mechanisms, three tooltips — the label is the same on all three.
    expect(new Set([device.description, backend.description, cloud.description]).size).toBe(3);
  });

  it("activates by id when nothing is pending, and re-applies on the active scene", () => {
    for (const mode of MODES) {
      const activate = chooseSceneDeployPath({
        mode,
        sceneHasChanges: false,
        isActiveScene: false,
      });
      expect(activate.path).toBe("activate");
      expect(activate.description).toMatch(/active scene/i);

      const apply = chooseSceneDeployPath({ mode, sceneHasChanges: false, isActiveScene: true });
      expect(apply.path).toBe("apply");
      // Already active: the button re-sends the state fields instead.
      expect(apply.description).toMatch(/state fields/i);
      expect(apply.description).not.toBe(activate.description);
    }
  });

  it("never leaks the mechanism into a label-shaped string", () => {
    for (const mode of MODES) {
      for (const sceneHasChanges of BOOLS) {
        for (const isActiveScene of BOOLS) {
          const { description } = chooseSceneDeployPath({ mode, sceneHasChanges, isActiveScene });
          expect(description).not.toMatch(/\b(push|upgrade|redeploy)\b/i);
        }
      }
    }
  });
});

describe("livePreviewStatusText", () => {
  it("reports size, time and the runtime version while the browser preview runs", () => {
    expect(
      livePreviewStatusText({
        surface: "live",
        previewStatus: "running",
        renderWidth: 800,
        renderHeight: 480,
        lastRenderMs: 42,
        runtimeVersion: "1.2.3",
      }),
    ).toEqual({ left: "Rendered 800×480 in 42 ms", right: "runtime 1.2.3", error: false });
  });

  it("adds the frame rate only in real-time mode, and only once measured", () => {
    const base = {
      surface: "live" as const,
      previewStatus: "running" as const,
      renderWidth: 800,
      renderHeight: 480,
      lastRenderMs: 42,
    };
    expect(livePreviewStatusText({ ...base, fastMode: true, measuredFps: 24 }).left).toBe(
      "Rendered 800×480 in 42 ms · 24 fps",
    );
    expect(livePreviewStatusText({ ...base, fastMode: true, measuredFps: 7.5 }).left).toBe(
      "Rendered 800×480 in 42 ms · 7.5 fps",
    );
    // Throttled mode, or nothing measured yet: no rate.
    expect(livePreviewStatusText({ ...base, fastMode: false, measuredFps: 24 }).left).toBe(
      "Rendered 800×480 in 42 ms",
    );
    expect(livePreviewStatusText({ ...base, fastMode: true, measuredFps: null }).left).toBe(
      "Rendered 800×480 in 42 ms",
    );
  });

  it("says it is still rendering before the first frame comes back", () => {
    const status = livePreviewStatusText({ surface: "live", previewStatus: "loading" });
    expect(status.left).toMatch(/rendering/i);
    expect(status.left).toMatch(/browser/i);
    expect(status.error).toBe(false);
    expect(status.right).toBe("");
  });

  it("shows the worker's own error in red, with a fallback when it has none", () => {
    const withError = livePreviewStatusText({
      surface: "live",
      previewStatus: "error",
      previewError: "Scene failed: boom",
      runtimeVersion: "1.2.3",
    });
    expect(withError).toEqual({
      left: "Scene failed: boom",
      right: "runtime 1.2.3",
      error: true,
    });

    const withoutError = livePreviewStatusText({ surface: "live", previewStatus: "error" });
    expect(withoutError.error).toBe(true);
    expect(withoutError.left.length).toBeGreaterThan(0);
  });

  it("waits for the frame while a deploy is pending", () => {
    expect(livePreviewStatusText({ surface: "pending" })).toEqual({
      left: "Waiting for the frame to render…",
      right: "",
      error: false,
    });
  });

  it("confirms the frame rendered, or explains why it never said so", () => {
    expect(livePreviewStatusText({ surface: "frame" })).toEqual({
      left: "Rendered on the frame",
      right: "",
      error: false,
    });
    expect(
      livePreviewStatusText({
        surface: "frame",
        deployNotice: "No render signal received from the frame",
      }),
    ).toEqual({
      left: "No render signal received from the frame",
      right: "",
      error: true,
    });
  });

  it("labels the stored snapshot, and the absence of one", () => {
    expect(livePreviewStatusText({ surface: "snapshot" })).toEqual({
      left: "Scene snapshot",
      right: "",
      error: false,
    });
    expect(livePreviewStatusText({ surface: "snapshot", hasSnapshot: false })).toEqual({
      left: "No snapshot yet",
      right: "",
      error: false,
    });
  });

  it("only names a runtime version on the live surface, and only when it has one", () => {
    expect(livePreviewStatusText({ surface: "live", previewStatus: "loading" }).right).toBe("");
    for (const surface of ["pending", "frame", "snapshot"] as const) {
      expect(livePreviewStatusText({ surface, runtimeVersion: "1.2.3" }).right).toBe("");
    }
  });
});

describe("formatFps / describeRenderRate", () => {
  it("rounds from 10 fps up and keeps one decimal below it", () => {
    expect(formatFps(24.4)).toBe("24");
    expect(formatFps(10)).toBe("10");
    expect(formatFps(7.53)).toBe("7.5");
    expect(formatFps(2)).toBe("2");
  });

  it("turns a render interval into words for the fast-render prompt", () => {
    expect(describeRenderRate(42)).toBe("every 42 ms (about 24 times a second)");
    expect(describeRenderRate(1000)).toBe("every 1000 ms (about 1 times a second)");
    // Never divides by zero, however small the interval.
    expect(describeRenderRate(0)).toBe("every 1 ms (about 1000 times a second)");
  });
});

describe("normalizeSceneActionKey", () => {
  it("passes the two real actions through", () => {
    expect(normalizeSceneActionKey("deploy")).toBe("deploy");
    expect(normalizeSceneActionKey("preview-browser")).toBe("preview-browser");
  });

  it("folds the legacy three-option keys onto Deploy to frame", () => {
    // Stored under scenes.preferredSceneAction by earlier builds.
    expect(normalizeSceneActionKey("activate")).toBe("deploy");
    expect(normalizeSceneActionKey("preview-frame")).toBe("deploy");
  });

  it("folds anything unrecognised onto Deploy to frame", () => {
    for (const value of [undefined, null, "", "nonsense", 0, 1, true, false, {}, []]) {
      expect(normalizeSceneActionKey(value)).toBe("deploy");
    }
  });
});
