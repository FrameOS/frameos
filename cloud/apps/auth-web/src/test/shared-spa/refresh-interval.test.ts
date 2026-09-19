// The refresh interval is a state field (frontend/src/utils/refreshInterval.ts):
// a scene that declares none gets an implicit "Refresh interval (seconds)" as
// its last control; one that declares its own (by role, or a numeric field by
// name) keeps it where the author put it. The
// runtime applies the same rules (frameos/src/frameos/refresh_interval.nim,
// pinned by test_refresh_interval.nim); the cases here mirror those.

import { describe, expect, it } from "vitest";
import {
  REFRESH_INTERVAL_LABEL,
  parseRefreshSeconds,
  resolveRefreshInterval,
  scenePublicStateFields,
  sceneRefreshSeconds,
  sceneStateFields,
} from "../../../../../../frontend/src/utils/refreshInterval";
import type { StateField } from "../../../../../../frontend/src/types";

const field = (name: string, extra: Partial<StateField> = {}): StateField => ({
  name,
  label: name,
  type: "string",
  access: "public",
  ...extra,
});

describe("parseRefreshSeconds", () => {
  it("takes positive finite numbers, as numbers or form strings", () => {
    expect(parseRefreshSeconds(60)).toBe(60);
    expect(parseRefreshSeconds(0.5)).toBe(0.5);
    expect(parseRefreshSeconds(" 90 ")).toBe(90);
  });

  it("answers 0 for anything else", () => {
    for (const value of ["", "soon", 0, -5, NaN, Infinity, null, undefined, true, {}]) {
      expect(parseRefreshSeconds(value)).toBe(0);
    }
  });
});

describe("resolveRefreshInterval", () => {
  it("appends an implicit public field seeded from settings.refreshInterval", () => {
    const resolved = resolveRefreshInterval({ fields: [field("search")], settings: { refreshInterval: 900 } });
    expect(resolved.implicit).toBe(true);
    expect(resolved.key).toBe("refreshInterval");
    expect(resolved.defaultSeconds).toBe(900);
    expect(resolved.fields.map((f) => f.name)).toEqual(["search", "refreshInterval"]);
    expect(resolved.fields[1]).toMatchObject({
      label: REFRESH_INTERVAL_LABEL,
      type: "float",
      value: "900",
      access: "public",
      persist: "disk",
      role: "refreshInterval",
    });
  });

  it("falls back to 300 seconds when the scene says nothing", () => {
    expect(resolveRefreshInterval(null).defaultSeconds).toBe(300);
    expect(resolveRefreshInterval({ fields: [], settings: {} }).defaultSeconds).toBe(300);
  });

  it("takes over a numeric field named refreshInterval where the scene put it", () => {
    const resolved = resolveRefreshInterval({
      fields: [field("refreshInterval", { type: "float", value: "120", label: "Every" }), field("search")],
      settings: { refreshInterval: 900 },
    });
    expect(resolved.implicit).toBe(false);
    expect(resolved.defaultSeconds).toBe(120);
    // Where the control goes is the author's call; only the implicit one is last.
    expect(resolved.fields.map((f) => f.name)).toEqual(["refreshInterval", "search"]);
    expect(resolved.fields[0]).toMatchObject({ label: "Every", role: "refreshInterval" });
  });

  it("leaves a refreshInterval field of another type alone, with no implicit twin", () => {
    for (const type of ["string", "select", "boolean"] as const) {
      const fields = [field("refreshInterval", { type, value: "hourly" }), field("search")];
      const resolved = resolveRefreshInterval({ fields, settings: { refreshInterval: 555 } });
      expect(resolved).toEqual({ fields, key: "", defaultSeconds: 555, implicit: false });
      expect(sceneRefreshSeconds({ fields, settings: { refreshInterval: 555 } }, { refreshInterval: 60 })).toBe(555);
    }
    expect(
      resolveRefreshInterval({ fields: [field("refreshInterval", { type: "integer", value: "60" })] }).key
    ).toBe("refreshInterval");
  });

  it("lets an explicit role beat the name", () => {
    const resolved = resolveRefreshInterval({
      fields: [
        field("refreshInterval", { type: "float", value: "120" }),
        field("seconds", { type: "float", value: "3600", role: "refreshInterval" }),
        field("search"),
      ],
    });
    expect(resolved.key).toBe("seconds");
    expect(resolved.defaultSeconds).toBe(3600);
    expect(resolved.fields.map((f) => f.name)).toEqual(["refreshInterval", "seconds", "search"]);
  });

  it("uses settings.refreshInterval when the declared field has no usable default", () => {
    const resolved = resolveRefreshInterval({
      fields: [field("seconds", { type: "float", value: "", role: "refreshInterval" })],
      settings: { refreshInterval: 777 },
    });
    expect(resolved.defaultSeconds).toBe(777);
  });

  it("does not mutate the scene's own fields", () => {
    const fields = [field("refreshInterval", { type: "float" }), field("search")];
    const snapshot = JSON.stringify(fields);
    expect(sceneStateFields({ fields })[0]?.role).toBe("refreshInterval");
    expect(JSON.stringify(fields)).toBe(snapshot);
  });
});

describe("scenePublicStateFields", () => {
  it("drops private fields, including a private refresh interval", () => {
    expect(
      scenePublicStateFields({
        fields: [field("counter", { access: "private" }), field("search")],
      }).map((f) => f.name)
    ).toEqual(["search", "refreshInterval"]);
    expect(
      scenePublicStateFields({
        fields: [field("refreshInterval", { access: "private", type: "float", value: "45" }), field("search")],
      }).map((f) => f.name)
    ).toEqual(["search"]);
  });
});

describe("sceneRefreshSeconds", () => {
  const scene = { fields: [field("seconds", { type: "float", value: "600", role: "refreshInterval" })] };

  it("reads the live state first and the scene's default otherwise", () => {
    expect(sceneRefreshSeconds(scene, { seconds: 30 })).toBe(30);
    expect(sceneRefreshSeconds(scene, { seconds: "45" })).toBe(45);
    expect(sceneRefreshSeconds(scene, { seconds: 0 })).toBe(600);
    expect(sceneRefreshSeconds(scene, { refreshInterval: 5 })).toBe(600);
    expect(sceneRefreshSeconds(scene)).toBe(600);
  });
});
