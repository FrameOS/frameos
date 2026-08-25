import { describe, expect, it } from "vitest";
import { formatLogTimestamp, parsePreviewLogLine } from "./preview-log";

// Lines captured from the wasm runtime in the scene editor's Preview panel
// (analog clock face, 2026-08-25).
const captured = [
  'loadScenes: 1 scene(s) ready, default "analog-clock-face"',
  '{"event":"initInterpretedDone","sceneId":"analog-clock-face","nodes":16,"edges":15,"eventListeners":1,"apps":3,"imageFusionPlans":1,"imageBoundsPlans":0}',
  'scene "Analog clock face" initialized',
  '{"event":"render:scene","width":800,"height":600}',
  '{"event":"render:done","sceneId":"analog-clock-face","ms":208.0}',
];

const receivedAt = Date.UTC(2026, 7, 25, 10, 30, 15);

describe("parsePreviewLogLine", () => {
  it("splits a runtime JSON line into the event tag and key=value fields", () => {
    const entry = parsePreviewLogLine(captured[4]!, 4, receivedAt);
    expect(entry).toMatchObject({
      event: "render:done",
      fields: [
        ["sceneId", '"analog-clock-face"'],
        ["ms", "208"],
      ],
      id: "4",
      level: "info",
      raw: captured[4],
    });
    // No timestamp in the line: the arrival time stands in.
    expect(entry.timestamp).toBe(new Date(receivedAt).toISOString());
  });

  it("keeps every field of a wide JSON line in its own order", () => {
    const entry = parsePreviewLogLine(captured[1]!, 1);
    expect(entry.event).toBe("initInterpretedDone");
    expect(entry.fields.map(([key]) => key)).toEqual([
      "sceneId",
      "nodes",
      "edges",
      "eventListeners",
      "apps",
      "imageFusionPlans",
      "imageBoundsPlans",
    ]);
    expect(entry.timestamp).toBeUndefined();
  });

  it("keeps plain text lines raw, with no event and no fields", () => {
    for (const line of [captured[0]!, captured[2]!]) {
      const entry = parsePreviewLogLine(line, 0, receivedAt);
      expect(entry.event).toBeUndefined();
      expect(entry.fields).toEqual([]);
      expect(entry.raw).toBe(line);
      expect(entry.level).toBe("info");
    }
  });

  it("prefers a timestamp carried by the line — ISO, epoch seconds, or milliseconds", () => {
    const iso = "2026-08-25T08:00:00.000Z";
    expect(
      parsePreviewLogLine(`{"event":"a","timestamp":"${iso}"}`, 0, receivedAt).timestamp,
    ).toBe(iso);
    expect(
      parsePreviewLogLine('{"event":"a","timestamp":1787731200.5}', 0, receivedAt).timestamp,
    ).toBe("2026-08-26T08:00:00.500Z");
    expect(
      parsePreviewLogLine('{"event":"a","timestamp":1787731200500}', 0, receivedAt).timestamp,
    ).toBe("2026-08-26T08:00:00.500Z");
    expect(parsePreviewLogLine('{"event":"a","timestamp":"1787731200"}', 0).timestamp).toBe(
      "2026-08-26T08:00:00.000Z",
    );
    // The timestamp is not a field.
    expect(parsePreviewLogLine(`{"event":"a","timestamp":"${iso}"}`, 0).fields).toEqual([]);
  });

  it("shows message-like string values bare and everything else as JSON", () => {
    const entry = parsePreviewLogLine(
      '{"event":"log","message":"hello, world","value":"x","data":{"a":[1,2]},"flag":true,"nothing":null}',
      0,
    );
    expect(entry.fields).toEqual([
      ["message", "hello, world"],
      ["value", "x"],
      ["data", '{"a":[1,2]}'],
      ["flag", "true"],
      ["nothing", "null"],
    ]);
  });

  it("detects the level from the event name, an error key, or a level key", () => {
    expect(parsePreviewLogLine('{"event":"render:error","error":"boom"}', 0).level).toBe("error");
    expect(parsePreviewLogLine('{"event":"app","error":"boom"}', 0).level).toBe("error");
    expect(parsePreviewLogLine('{"event":"app","error":null}', 0).level).toBe("info");
    expect(parsePreviewLogLine('{"event":"fetch:warn","url":"x"}', 0).level).toBe("warn");
    expect(parsePreviewLogLine('{"event":"log","level":"warning","message":"m"}', 0).level).toBe(
      "warn",
    );
    expect(parsePreviewLogLine('{"event":"log","level":"error","message":"m"}', 0).level).toBe(
      "error",
    );
    expect(parsePreviewLogLine('{"event":"render:done","ms":1}', 0).level).toBe("info");
  });

  it("detects the level of plain text from how the line opens", () => {
    expect(parsePreviewLogLine("Error: scene did not render", 0).level).toBe("error");
    expect(parsePreviewLogLine("[warn] slow fetch", 0).level).toBe("warn");
    expect(parsePreviewLogLine("Warning: slow fetch", 0).level).toBe("warn");
    expect(parsePreviewLogLine("rendered without error", 0).level).toBe("info");
  });

  it("reads the panel's own `error: …` and `event: name {json}` lines", () => {
    const error = parsePreviewLogLine("error: Worker crashed", 0, receivedAt);
    expect(error).toMatchObject({
      event: "error",
      fields: [["message", "Worker crashed"]],
      level: "error",
    });
    const event = parsePreviewLogLine('event: button {"label":"A"}', 1);
    expect(event).toMatchObject({
      event: "button",
      fields: [["label", '"A"']],
      level: "info",
    });
    expect(parsePreviewLogLine("event: tick", 2)).toMatchObject({ event: "tick", fields: [] });
    expect(parsePreviewLogLine("event: tick not-json", 3)).toMatchObject({
      event: "tick",
      fields: [["payload", "not-json"]],
    });
  });

  it("treats JSON that is not an object, or malformed JSON, as plain text", () => {
    expect(parsePreviewLogLine("[1,2,3]", 0)).toMatchObject({ fields: [], raw: "[1,2,3]" });
    expect(parsePreviewLogLine('{"event":', 0)).toMatchObject({ fields: [], raw: '{"event":' });
    expect(parsePreviewLogLine("", 0)).toMatchObject({ fields: [], level: "info", raw: "" });
  });
});

describe("formatLogTimestamp", () => {
  it("formats as YYYY-MM-DD HH:mm:ss in local time, zero-padded", () => {
    const date = new Date(2026, 0, 5, 7, 8, 9);
    expect(formatLogTimestamp(date.toISOString())).toBe("2026-01-05 07:08:09");
    expect(formatLogTimestamp(date.getTime())).toBe("2026-01-05 07:08:09");
  });

  it("is empty for missing or unparseable input", () => {
    expect(formatLogTimestamp(undefined)).toBe("");
    expect(formatLogTimestamp("not a date")).toBe("");
  });
});
