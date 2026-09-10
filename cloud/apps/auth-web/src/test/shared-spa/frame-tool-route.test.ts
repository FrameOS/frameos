import { describe, expect, it } from "vitest";
import {
  frameToolNotFoundMessage,
  frameToolPanels,
  isFrameToolPanel,
  legacyToolQueryTarget,
  resolveFrameToolRoute,
} from "../../../../../../frontend/src/scenes/workspace/frameToolRoute";
import { allowedFrameToolPanels } from "../../../../../../frontend/src/scenes/workspace/workspaceSurfaces";

// The tool segment of a frame URL (/frames/<id>/<tool>) used to be checked
// against EVERY panel and then fell back to the overview, so
// /frames/<id>/terminal on the cloud — which has no shell — quietly rendered
// the scenes page (2026-09 review, §10). The resolver now answers against
// the mode's allow-list: a foreign or unknown tool is a 404, a tool the
// device profile cannot serve is an explanation, and only a tool the control
// plane implements for this frame is a panel.

describe("resolveFrameToolRoute", () => {
  it("treats the bare frame URL as the overview", () => {
    expect(resolveFrameToolRoute(null, "cloud")).toEqual({ kind: "panel", panel: "overview" });
    expect(resolveFrameToolRoute(undefined, "backend")).toEqual({ kind: "panel", panel: "overview" });
    expect(resolveFrameToolRoute("", "frameAdmin")).toEqual({ kind: "panel", panel: "overview" });
  });

  it("is a 404, not the overview, for a tool another control plane implements", () => {
    expect(resolveFrameToolRoute("terminal", "cloud")).toEqual({ kind: "notFound", segment: "terminal" });
    expect(resolveFrameToolRoute("ping", "frameAdmin")).toEqual({ kind: "notFound", segment: "ping" });
    expect(resolveFrameToolRoute("activity", "backend")).toEqual({ kind: "notFound", segment: "activity" });
  });

  it("is a 404 for a segment that is no tool at all", () => {
    expect(resolveFrameToolRoute("nonsense", "backend")).toEqual({ kind: "notFound", segment: "nonsense" });
    expect(resolveFrameToolRoute(42, "cloud")).toEqual({ kind: "notFound", segment: "42" });
  });

  it("renders every tool the mode lists, on every mode", () => {
    for (const mode of ["backend", "cloud", "frameAdmin"] as const) {
      for (const panel of allowedFrameToolPanels[mode]) {
        expect(resolveFrameToolRoute(panel, mode)).toEqual({ kind: "panel", panel });
      }
      for (const panel of frameToolPanels) {
        if (!allowedFrameToolPanels[mode].includes(panel)) {
          expect(resolveFrameToolRoute(panel, mode)).toEqual({ kind: "notFound", segment: panel });
        }
      }
    }
  });

  it("hides a tool whose concept the device lacks (terminal on a virtual frame) as a 404", () => {
    const virtual = { embedded: { platform: "virtual" } };
    expect(resolveFrameToolRoute("terminal", "backend", virtual)).toEqual({ kind: "notFound", segment: "terminal" });
    expect(resolveFrameToolRoute("metrics", "backend", virtual)).toEqual({ kind: "notFound", segment: "metrics" });
    expect(resolveFrameToolRoute("assets", "backend", virtual)).toEqual({ kind: "panel", panel: "assets" });
  });

  it("explains, rather than swaps, a tool the device profile disables", () => {
    // The esp32 cloud profile currently gates nothing (workspaceSurfaces.ts),
    // so the disabled branch is exercised through the resolver's own contract
    // against the surfaces module: whatever the profile disables must come
    // back as `disabled` with the surfaces' reason, never as another panel.
    const esp32 = { hardware: { platform: "esp32-s3" } };
    for (const panel of allowedFrameToolPanels.cloud) {
      const resolution = resolveFrameToolRoute(panel, "cloud", esp32);
      expect(resolution.kind === "panel" || resolution.kind === "disabled").toBe(true);
      if (resolution.kind === "disabled") {
        expect(resolution.panel).toBe(panel);
        expect(resolution.reason.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("frameToolPanels", () => {
  it("covers every panel any mode lists", () => {
    for (const mode of ["backend", "cloud", "frameAdmin"] as const) {
      for (const panel of allowedFrameToolPanels[mode]) {
        expect(isFrameToolPanel(panel)).toBe(true);
      }
    }
  });
});

describe("frameToolNotFoundMessage", () => {
  it("names the control plane for a real tool it does not implement", () => {
    expect(frameToolNotFoundMessage("terminal", "cloud")).toBe(
      'There is no "terminal" tool for this frame on FrameOS Cloud.',
    );
    expect(frameToolNotFoundMessage("ping", "frameAdmin")).toContain("admin panel");
  });

  it("says plainly that an unknown segment is no page", () => {
    expect(frameToolNotFoundMessage("nonsense", "backend")).toBe('This frame has no "nonsense" page.');
  });
});

// Old links carried the tool as `?tool=`; the router moves it into the path
// and comes back through the route. It used to move `frameToolFromRoute`'s
// answer — the overview for anything unknown — so /frames/1?tool=bogus
// canonicalised to a page the path form 404s on.
describe("legacyToolQueryTarget", () => {
  it("moves the query value into the path verbatim, unknown tools included", () => {
    expect(legacyToolQueryTarget(undefined, "logs")).toBe("logs");
    expect(legacyToolQueryTarget(null, "bogus")).toBe("bogus");
    expect(legacyToolQueryTarget("", "terminal")).toBe("terminal");
    expect(resolveFrameToolRoute(legacyToolQueryTarget(null, "bogus"), "backend")).toEqual({
      kind: "notFound",
      segment: "bogus",
    });
  });

  it("treats an empty query as the overview", () => {
    expect(legacyToolQueryTarget(undefined, "")).toBe("overview");
  });

  it("has nothing to move when the path already names a tool or there is no query", () => {
    expect(legacyToolQueryTarget("logs", "metrics")).toBeNull();
    expect(legacyToolQueryTarget("logs", null)).toBeNull();
    expect(legacyToolQueryTarget(undefined, null)).toBeNull();
  });
});
