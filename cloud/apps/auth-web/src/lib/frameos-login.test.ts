import { describe, expect, it } from "vitest";
import {
  maxLoginRedirectToChars,
  safeFrameosRedirectTo,
  safeFrameosRedirectUri,
} from "./frameos-login";

describe("safeFrameosRedirectTo", () => {
  it("is absent for nothing, unusable for anything but a relative path", () => {
    expect(safeFrameosRedirectTo(undefined)).toBeUndefined();
    expect(safeFrameosRedirectTo("")).toBeUndefined();
    expect(safeFrameosRedirectTo(null)).toBeUndefined();
    expect(safeFrameosRedirectTo("/frames/1?x=y#top")).toBe("/frames/1?x=y#top");
    expect(safeFrameosRedirectTo("frames/1")).toBeNull();
    expect(safeFrameosRedirectTo("https://evil.example/")).toBeNull();
    expect(safeFrameosRedirectTo("//evil.example/")).toBeNull();
    expect(safeFrameosRedirectTo("/\\evil.example/")).toBeNull();
    expect(safeFrameosRedirectTo("javascript:alert(1)")).toBeNull();
    expect(safeFrameosRedirectTo("/ok\r\nSet-Cookie: x")).toBeNull();
    expect(safeFrameosRedirectTo(42)).toBeNull();
  });

  it("caps the length", () => {
    expect(safeFrameosRedirectTo(`/${"a".repeat(maxLoginRedirectToChars - 1)}`)).not.toBeNull();
    expect(safeFrameosRedirectTo(`/${"a".repeat(maxLoginRedirectToChars)}`)).toBeNull();
  });
});

describe("safeFrameosRedirectUri", () => {
  it("keeps http(s) URLs without credentials and drops the fragment", () => {
    expect(safeFrameosRedirectUri("http://10.1.1.2:8989/cb#frag")).toBe(
      "http://10.1.1.2:8989/cb",
    );
    expect(safeFrameosRedirectUri("ftp://10.1.1.2/cb")).toBeUndefined();
    expect(safeFrameosRedirectUri("http://user:pw@10.1.1.2/cb")).toBeUndefined();
    expect(safeFrameosRedirectUri("not a url")).toBeUndefined();
  });
});
