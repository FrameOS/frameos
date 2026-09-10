import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildrootPlatforms,
  embeddedPlatforms,
  normalizeBuildrootPlatform,
  virtualColorModes,
} from "../../../../../../frontend/src/devices";

// The frontend's device catalog (frontend/src/devices.ts) is a hand-copied
// mirror of three backend tables: the Buildroot platforms
// (backend/app/tasks/buildroot_platforms.py), the embedded platforms
// (backend/app/tasks/embedded_firmware.py) and the virtual frame colour
// modes (backend/app/api/virtual_frame.py). They agreed at the 2026-09
// review, by inspection; this reads the Python sources so CI notices the
// next time one side moves.

const repoRoot = resolve(__dirname, "../../../../../..");
const read = (path: string): string => readFileSync(resolve(repoRoot, path), "utf8").replace(/#[^\n]*/g, "");

interface BackendBuildrootPlatform {
  key: string;
  label: string;
  enabled: boolean;
  aliases: string[];
}

function backendBuildrootPlatforms(): BackendBuildrootPlatform[] {
  const source = read("backend/app/tasks/buildroot_platforms.py");
  const platforms: BackendBuildrootPlatform[] = [];
  for (const block of source.split(/^[A-Z0-9_]+ = BuildrootPlatform\($/m).slice(1)) {
    const key = block.match(/^\s*key="([^"]+)"/m)?.[1];
    const label = block.match(/^\s*label="([^"]+)"/m)?.[1];
    if (!key || !label) {
      throw new Error("BuildrootPlatform without key/label");
    }
    const aliasBody = block.match(/aliases=frozenset\(\s*\{([\s\S]*?)\}\s*\)/)?.[1] ?? "";
    platforms.push({
      key,
      label,
      enabled: !/^\s*enabled=False/m.test(block),
      aliases: [...aliasBody.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? ""),
    });
  }
  // The table itself lists which declarations are live.
  const table = source.match(/BUILDROOT_PLATFORMS: dict\[str, BuildrootPlatform\] = \{[\s\S]*?\n\}/)?.[0] ?? "";
  const listed = [...table.matchAll(/^\s+([A-Z0-9_]+),$/gm)].map((m) => m[1]);
  expect(listed.length).toBe(platforms.length);
  return platforms;
}

function backendEmbeddedPlatforms(): { key: string; label: string }[] {
  const source = read("backend/app/tasks/embedded_firmware.py");
  const table = source.match(/EMBEDDED_PLATFORMS: dict\[str, dict\[str, Any\]\] = \{([\s\S]*?)\n\}/)?.[1];
  if (!table) {
    throw new Error("EMBEDDED_PLATFORMS not found");
  }
  return [...table.matchAll(/^\s{4}"([^"]+)": \{\s*\n\s*"label": "([^"]+)"/gm)].map((m) => ({
    key: m[1] ?? "",
    label: m[2] ?? "",
  }));
}

function backendVirtualColorModes(): string[] {
  const source = read("backend/app/api/virtual_frame.py");
  const tuple = source.match(/^VIRTUAL_COLOR_MODES = \(([^)]*)\)/m)?.[1];
  if (!tuple) {
    throw new Error("VIRTUAL_COLOR_MODES not found");
  }
  return [...tuple.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
}

describe("devices.ts mirrors the backend device catalog", () => {
  it("offers exactly the enabled Buildroot platforms, with the backend's labels", () => {
    const enabled = backendBuildrootPlatforms()
      .filter((platform) => platform.enabled)
      .map(({ key, label }) => ({ value: key, label }))
      .sort((a, b) => a.value.localeCompare(b.value));
    const frontend = [...buildrootPlatforms].sort((a, b) => a.value.localeCompare(b.value));
    expect(frontend).toEqual(enabled);
  });

  it("maps every legacy Buildroot key the frontend knows onto the platform the backend maps it to", () => {
    const platforms = backendBuildrootPlatforms();
    const backendAlias = new Map<string, string>();
    for (const platform of platforms) {
      for (const alias of platform.aliases) {
        backendAlias.set(alias, platform.key);
      }
    }
    // The two keys the UI ever wrote before the consolidation.
    for (const legacy of ["raspberry-pi-zero-2-w", "raspberry-pi-zero-w"]) {
      expect(backendAlias.get(legacy), legacy).toBeDefined();
      expect(normalizeBuildrootPlatform(legacy)).toBe(backendAlias.get(legacy));
    }
    // A canonical key passes through on both sides.
    for (const platform of platforms.filter((candidate) => candidate.enabled)) {
      expect(normalizeBuildrootPlatform(platform.key)).toBe(platform.key);
    }
    expect(normalizeBuildrootPlatform("")).toBe(backendAlias.get(""));
  });

  it("lists every embedded platform the backend knows, under the same key", () => {
    const backend = backendEmbeddedPlatforms();
    expect(backend.length).toBeGreaterThan(0);
    expect(embeddedPlatforms.map((option) => option.value).sort()).toEqual(
      backend.map((platform) => platform.key).sort(),
    );
    // The frontend may append a "(thin client)" tag; the backend label is the prefix.
    for (const platform of backend) {
      const option = embeddedPlatforms.find((candidate) => candidate.value === platform.key);
      expect(option?.label.startsWith(platform.label), `${platform.key}: ${option?.label}`).toBe(true);
    }
  });

  it("offers exactly the virtual frame colour modes the backend quantizes to", () => {
    expect(virtualColorModes.map((option) => option.value)).toEqual(backendVirtualColorModes());
  });
});
