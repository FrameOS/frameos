import { describe, expect, it } from "vitest";
import { isRenderError } from "./render-check";

describe("isRenderError", () => {
  it("flags JSON log lines whose event starts with error", () => {
    expect(isRenderError(JSON.stringify({ event: "error", message: "x" }))).toBe(true);
    expect(isRenderError(JSON.stringify({ event: "error:render", scene: "s" }))).toBe(true);
    expect(isRenderError(JSON.stringify({ event: "errorApp", app: "a" }))).toBe(true);
  });

  it("flags JSON log lines carrying an error key", () => {
    expect(isRenderError(JSON.stringify({ event: "render", error: "boom" }))).toBe(true);
    expect(isRenderError(JSON.stringify({ event: "http", error: null }))).toBe(true);
  });

  it("passes ordinary JSON log lines", () => {
    expect(isRenderError(JSON.stringify({ event: "render:done", ms: 12 }))).toBe(false);
    expect(isRenderError(JSON.stringify({ event: "log", message: "no errors here" }))).toBe(false);
    expect(isRenderError(JSON.stringify({ event: "app:error_handler" }))).toBe(false);
  });

  it("does not treat JSON arrays or scalars as error payloads", () => {
    expect(isRenderError("[1, 2, 3]")).toBe(false);
    expect(isRenderError("42")).toBe(false);
    expect(isRenderError('"error"')).toBe(true);
  });

  it("matches the whole word error in plain-text lines, case-insensitively", () => {
    expect(isRenderError("http request failed: Error: connection refused")).toBe(true);
    expect(isRenderError("ERROR while loading image")).toBe(true);
    expect(isRenderError("rendering 800x480 in 12ms")).toBe(false);
    expect(isRenderError("no errors yet")).toBe(false);
  });
});
