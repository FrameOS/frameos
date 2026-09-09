// The store's error-code wording (frontend/src/utils/storeSceneErrors.ts):
// one table read by the cloud's owner buttons, upload forms and editor Save
// (through @frameos/cloud-frontend/src/storeSceneErrors) and by the SPA's
// cloud scene calls. Pins that the codes owners actually hit surface the
// server's reason instead of "Failed", that an unknown code still names the
// action, and that the two import paths are the same function.

import { describe, expect, it } from "vitest";
import { storeSceneErrorMessage as viaCloudFrontend } from "../../../../../../cloud-frontend/src/storeSceneErrors";
import {
  storeSceneErrorCode,
  storeSceneErrorMessage,
} from "../../../../../../frontend/src/utils/storeSceneErrors";
import { ownerActionErrorMessage } from "../../components/ownerActionError";

describe("storeSceneErrorMessage", () => {
  it("is one function behind every import path", () => {
    expect(viaCloudFrontend).toBe(storeSceneErrorMessage);
    expect(ownerActionErrorMessage({ error: "scene_pulled" }, 410)).toBe(
      storeSceneErrorMessage({ error: "scene_pulled" }, 410),
    );
  });

  it("surfaces the refusals owners hit instead of a bare Failed", () => {
    expect(storeSceneErrorMessage({ error: "storage_quota_exceeded" }, 403)).toMatch(
      /storage quota/,
    );
    expect(storeSceneErrorMessage({ error: "scene_pulled" }, 410)).toMatch(/pulled/);
    expect(storeSceneErrorMessage({ error: "rate_limited" }, 429)).toMatch(/wait a moment/);
    expect(storeSceneErrorMessage({ error: "cannot_yank_last_version" }, 400)).toMatch(
      /at least one published version/,
    );
    for (const code of ["storage_quota_exceeded", "scene_pulled", "rate_limited"]) {
      expect(storeSceneErrorMessage({ error: code }, 400)).not.toContain(code);
      expect(storeSceneErrorMessage({ error: code }, 400)).not.toMatch(/^Failed/);
    }
  });

  it("folds the route's details into the text", () => {
    expect(
      storeSceneErrorMessage(
        { categories: ["harassment", "violence"], error: "content_rejected" },
        400,
      ),
    ).toBe("Rejected by content moderation (harassment, violence)");
    expect(storeSceneErrorMessage({ error: "scene_name_taken", name: "Clock" }, 409)).toBe(
      "You already have another scene called “Clock” — rename this one to something else",
    );
    expect(storeSceneErrorMessage({ error: "scene_name_taken" }, 409)).toContain("“that”");
  });

  it("names the action for codes it has no wording for, and the status for no code at all", () => {
    expect(storeSceneErrorMessage({ error: "brand_new_code" }, 400, "Saving failed")).toBe(
      "Saving failed (brand_new_code)",
    );
    expect(storeSceneErrorMessage({ error: "brand_new_code" }, 400)).toBe(
      "Failed (brand_new_code)",
    );
    expect(storeSceneErrorMessage({}, 502, "Upload failed")).toBe("Upload failed (502)");
    expect(storeSceneErrorMessage(null, 500)).toBe("Failed (500)");
    expect(storeSceneErrorMessage({ error: 42 }, 500)).toBe("Failed (500)");
  });

  it("prefers a route's free-text detail over the generic fallback", () => {
    expect(
      storeSceneErrorMessage({ detail: "Prompt is required", error: "invalid_prompt" }, 400),
    ).toBe("Prompt is required");
    // …but a known code's wording wins over the detail.
    expect(
      storeSceneErrorMessage({ detail: "quota", error: "storage_quota_exceeded" }, 403),
    ).toMatch(/storage quota/);
  });

  it("exposes the code for callers that branch on it", () => {
    expect(storeSceneErrorCode({ error: "login_required" })).toBe("login_required");
    expect(storeSceneErrorCode({ error: "" })).toBeUndefined();
    expect(storeSceneErrorCode(undefined)).toBeUndefined();
  });
});
