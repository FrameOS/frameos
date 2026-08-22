import { describe, expect, it } from "vitest";
import { activeHeaderSection } from "./header-nav";

describe("activeHeaderSection", () => {
  it("maps every workspace path to Frames", () => {
    expect(activeHeaderSection("/frames")).toBe("frames");
    expect(activeHeaderSection("/frames/abc/scenes/def")).toBe("frames");
    expect(activeHeaderSection("/frames/apps/system/data%2Fx")).toBe("frames");
  });

  it("maps account and admin subpages", () => {
    expect(activeHeaderSection("/account/security")).toBe("account");
    expect(activeHeaderSection("/admin/scenes")).toBe("admin");
  });

  it("maps the store surfaces to Scenes", () => {
    expect(activeHeaderSection("/")).toBe("scenes");
    expect(activeHeaderSection("/s/some-slug")).toBe("scenes");
    expect(activeHeaderSection("/my-scenes")).toBe("scenes");
    expect(activeHeaderSection("/publishers/123")).toBe("scenes");
  });

  it("highlights nothing on auth pages", () => {
    expect(activeHeaderSection("/login")).toBeUndefined();
    expect(activeHeaderSection(null)).toBeUndefined();
  });
});
