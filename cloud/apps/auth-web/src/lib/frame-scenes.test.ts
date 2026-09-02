import { describe, expect, it } from "vitest";
import {
  normalizeSettingsGroups,
  readSettingsGroupsField,
  resolveGrantedSettingsGroups,
} from "./frame-scenes";
import {
  grantedServiceSettingGroupsUnion,
  grantedSettingsGroupsForAssignment,
} from "./frames";

// The grant model (docs/cloud-frames.md, "Service settings"): a scene's
// declaration is a request, the owner's grant per assignment is the answer,
// and the device is served the union of the grants. Pure helpers, so the
// rules are pinned here without a database.

describe("resolveGrantedSettingsGroups", () => {
  const declared = ["unsplash", "openAI"];

  it("stores an explicit grant narrowed to what the version declares", () => {
    expect(
      resolveGrantedSettingsGroups({
        declared,
        explicit: ["openAI", "homeAssistant", "unsplash"],
      }),
    ).toEqual(["openAI", "unsplash"]);
    expect(
      resolveGrantedSettingsGroups({ declared, explicit: ["homeAssistant"] }),
    ).toEqual([]);
  });

  it("grants a NEW assignment nothing when the caller names nothing", () => {
    expect(resolveGrantedSettingsGroups({ declared })).toEqual([]);
  });

  it("keeps an assigned scene's grant, narrowed to the current declaration", () => {
    expect(
      resolveGrantedSettingsGroups({
        declared: ["unsplash"],
        existing: { grantedSettingsGroups: ["unsplash", "openAI"] },
      }),
    ).toEqual(["unsplash"]);
  });

  it("leaves a legacy NULL grant NULL when the caller does not touch it", () => {
    // A pre-grant row keeps reading as "all it declares" until the owner
    // posts a list — an unrelated save must not silently drop its keys.
    expect(
      resolveGrantedSettingsGroups({
        declared,
        existing: { grantedSettingsGroups: null },
      }),
    ).toBeNull();
  });

  it("drops names no device can be served", () => {
    expect(normalizeSettingsGroups(["unsplash", "toString", "posthog"])).toEqual([
      "unsplash",
    ]);
  });
});

describe("grantedSettingsGroupsForAssignment", () => {
  it("reads a legacy row as granted = declared", () => {
    expect(
      grantedSettingsGroupsForAssignment({
        declaredSettingsGroups: ["unsplash", "openAI"],
        grantedSettingsGroups: null,
      }),
    ).toEqual(["unsplash", "openAI"]);
  });

  it("never lets a grant outrun the declaration", () => {
    expect(
      grantedSettingsGroupsForAssignment({
        declaredSettingsGroups: ["unsplash"],
        grantedSettingsGroups: ["unsplash", "openAI"],
      }),
    ).toEqual(["unsplash"]);
  });

  it("treats an explicit empty grant as nothing, whatever is declared", () => {
    expect(
      grantedSettingsGroupsForAssignment({
        declaredSettingsGroups: ["unsplash"],
        grantedSettingsGroups: [],
      }),
    ).toEqual([]);
  });

  it("unions grants across assignments in order, without duplicates", () => {
    expect(
      grantedServiceSettingGroupsUnion([
        { declaredSettingsGroups: ["openAI"], grantedSettingsGroups: ["openAI"] },
        { declaredSettingsGroups: ["unsplash", "openAI"], grantedSettingsGroups: null },
        { declaredSettingsGroups: ["immich"], grantedSettingsGroups: [] },
      ]),
    ).toEqual(["openAI", "unsplash"]);
  });
});

describe("readSettingsGroupsField", () => {
  it("is absent when omitted, the list when well-formed, malformed otherwise", () => {
    expect(readSettingsGroupsField(undefined)).toBeUndefined();
    expect(readSettingsGroupsField(null)).toBeUndefined();
    expect(readSettingsGroupsField(["unsplash"])).toEqual(["unsplash"]);
    expect(readSettingsGroupsField([])).toEqual([]);
    expect(readSettingsGroupsField("unsplash")).toBe(false);
    expect(readSettingsGroupsField([1])).toBe(false);
    expect(readSettingsGroupsField(["a b"])).toBe(false);
    expect(readSettingsGroupsField(Array.from({ length: 17 }, () => "x"))).toBe(false);
  });
});
