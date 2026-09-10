import { describe, expect, it } from "vitest";
import { parseImportedFrameJson } from "../../../../../../frontend/src/utils/frameJsonImport";
import type { FrameType } from "../../../../../../frontend/src/types";

// "Import frame .json" loads an exported frame row into the settings form.
// The export is the whole row — id, deploy baseline, secret fingerprints,
// status — so the import keeps only what the form edits, and the id above
// all never moves from one frame to another.

const formKeys: (keyof FrameType)[] = ["name", "mode", "ssh_pass", "network", "scenes"];

describe("parseImportedFrameJson", () => {
  it("keeps the form keys, secrets included, and drops the server-owned rest", () => {
    const text = JSON.stringify({
      id: 7,
      name: "Kitchen",
      mode: "rpios",
      ssh_pass: "raspberry",
      network: { wifiSSID: "home", wifiPassword: "hunter2" },
      scenes: [],
      status: "deployed",
      last_successful_deploy: { name: "Kitchen" },
      secret_fingerprints: { ssh_pass: "fp" },
    });
    const { values, ignoredKeys } = parseImportedFrameJson(text, formKeys);
    expect(values).toEqual({
      name: "Kitchen",
      mode: "rpios",
      ssh_pass: "raspberry",
      network: { wifiSSID: "home", wifiPassword: "hunter2" },
      scenes: [],
    });
    expect(ignoredKeys.sort()).toEqual(["id", "last_successful_deploy", "secret_fingerprints", "status"]);
  });

  it("rejects malformed input with a message meant for the user", () => {
    expect(() => parseImportedFrameJson("{not json", formKeys)).toThrow("not valid JSON");
    expect(() => parseImportedFrameJson("[1, 2]", formKeys)).toThrow("expected one JSON object");
    expect(() => parseImportedFrameJson("null", formKeys)).toThrow("expected one JSON object");
    expect(() => parseImportedFrameJson('{"id": 3, "status": "x"}', formKeys)).toThrow(
      "does not contain any frame settings",
    );
  });
});
