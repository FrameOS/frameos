import { describe, expect, it } from "vitest";
import {
  frameDeleteCopy,
  frameDeleteCopyByMode,
} from "../../../../../../frontend/src/scenes/workspace/frameDeleteCopy";
import { allowedFrameMenuActions } from "../../../../../../frontend/src/scenes/workspace/workspaceSurfaces";

// The "Delete frame" confirmation used to say the same thing on every
// control plane: "…and all of its scenes … Archive it instead". On the cloud
// neither exists — there is no archive, the scenes live in the account's
// store, and DELETE /api/frames/{id} revokes the device's link so it drops
// back to standalone while still showing what it has (2026-09 review, §10).

describe("frameDeleteCopy", () => {
  it("describes the backend's delete: the frame and its scenes go, archive is the alternative", () => {
    const copy = frameDeleteCopy("backend");
    const question = copy.confirm("Kitchen");
    expect(question).toContain('"Kitchen"');
    expect(question).toContain("all of its scenes");
    expect(question).toContain("Archive it instead");
    expect(copy.title).toContain("all of its scenes");
  });

  it("describes the cloud's delete: the device is unlinked and keeps running, scenes stay", () => {
    const copy = frameDeleteCopy("cloud");
    const question = copy.confirm("Kitchen");
    expect(question).toContain('"Kitchen"');
    expect(question).toContain("standalone");
    expect(question).toContain("keeps showing the scenes it has");
    expect(question).toContain("scenes stay in your account");
    expect(question).toContain("cannot be undone");
    expect(question).not.toContain("all of its scenes");
    expect(question).not.toContain("Archive");
    expect(copy.title).not.toContain("scenes");
  });

  it("only promises an archive where the mode's menu has one", () => {
    for (const mode of ["backend", "cloud", "frameAdmin"] as const) {
      const mentionsArchive = frameDeleteCopyByMode[mode].confirm("x").includes("Archive");
      // frameAdmin hides Delete altogether (its menu allows neither verb),
      // so its copy is only required to be consistent with itself.
      if (allowedFrameMenuActions[mode].includes("delete")) {
        expect(mentionsArchive).toBe(allowedFrameMenuActions[mode].includes("archive"));
      }
    }
  });
});
