// "Update scene from repository" (sceneUpdatesLogic) replaced a scene's
// `fields` with the template's, so every default the user had changed on the
// installed copy — an API key, a city — reverted on each update (2026-09
// review). mergeInstalledFieldValues carries the installed values over.

import { describe, expect, it } from "vitest";
import { mergeInstalledFieldValues } from "../../../../../../frontend/src/utils/sceneUpdateFields";
import type { StateField } from "../../../../../../frontend/src/types";

const field = (name: string, value: unknown, type: StateField["type"] = "string"): StateField => ({
  name,
  label: name,
  type,
  value,
});

describe("mergeInstalledFieldValues", () => {
  it("keeps the value the user set when the template still has that field", () => {
    const merged = mergeInstalledFieldValues(
      [field("apiKey", "sk-mine"), field("city", "Tallinn")],
      [field("apiKey", ""), field("city", "Berlin"), field("units", "metric")]
    );
    expect(merged).toEqual([field("apiKey", "sk-mine"), field("city", "Tallinn"), field("units", "metric")]);
  });

  it("takes the template's definition for everything but the value", () => {
    const merged = mergeInstalledFieldValues(
      [{ ...field("city", "Tallinn"), label: "Old label", persist: "disk" }],
      [{ ...field("city", "Berlin"), label: "City name", access: "public" }]
    );
    expect(merged).toEqual([{ ...field("city", "Tallinn"), label: "City name", access: "public" }]);
  });

  it("follows the template when a field changed type or was never set", () => {
    const merged = mergeInstalledFieldValues(
      [field("count", "3", "string"), { name: "unset", label: "unset", type: "string" }],
      [field("count", 5, "integer"), field("unset", "default")]
    );
    expect(merged).toEqual([field("count", 5, "integer"), field("unset", "default")]);
  });

  it("returns the template's array untouched when nothing carries over", () => {
    const template = [field("a", 1)];
    expect(mergeInstalledFieldValues(undefined, template)).toBe(template);
    expect(mergeInstalledFieldValues([], template)).toBe(template);
    expect(mergeInstalledFieldValues([field("a", 1)], undefined)).toBeUndefined();
    expect(mergeInstalledFieldValues([field("b", 2)], template)).toEqual(template);
  });

  it("drops fields the template removed", () => {
    expect(mergeInstalledFieldValues([field("gone", "x")], [field("kept", "y")])).toEqual([field("kept", "y")]);
  });
});
