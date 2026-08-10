import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The cloud workspace waits for the frame list before rendering. It used to
// wait on `framesLoaded`, which is a selector meaning "has at least one frame"
// — so an account with no frames yet, i.e. every brand-new account, sat on
// "Loading..." forever and could never reach the Add frame button.
//
// framesModel and Cloud.tsx live outside this package and there is no test
// runner in either, so this pins the contract by reading the source. Crude,
// but it fails loudly if someone swaps the gate back.

const repoRoot = join(__dirname, "..", "..", "..", "..", "..", "..");
const framesModel = readFileSync(
  join(repoRoot, "frontend", "src", "models", "framesModel.tsx"),
  "utf8",
);
const cloudScene = readFileSync(
  join(repoRoot, "cloud-frontend", "src", "scenes", "cloud", "Cloud.tsx"),
  "utf8",
);

describe("cloud workspace loading gate", () => {
  it("framesLoaded still means 'has at least one frame'", () => {
    // If this ever stops being true, the comment on the gate below is wrong
    // and this whole test should be revisited rather than patched.
    expect(framesModel).toContain(
      "framesLoaded: [(s) => [s.frames], (frames) => Object.keys(frames).length > 0]",
    );
  });

  it("exposes a separate flag for 'the list came back'", () => {
    expect(framesModel).toContain("framesEverLoaded: [");
    expect(framesModel).toContain("loadFramesSuccess: () => true");
  });

  it("gates the cloud scene on the list arriving, not on it being non-empty", () => {
    expect(cloudScene).toContain("framesEverLoaded");
    // The empty fleet must render, so the gate cannot be framesLoaded.
    expect(cloudScene).not.toMatch(/if \(!framesLoaded\)/);
  });
});
