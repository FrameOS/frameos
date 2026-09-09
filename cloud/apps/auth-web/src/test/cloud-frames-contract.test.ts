// The conformance corpus (docs/cloud-frames-fixtures.json) against the cloud's
// walker of the verb contract. The Linux runtime (test_cloud_contract.nim)
// and the ESP32 firmware (test_fos_cloud_contract.c) run the same file —
// three implementations, one verdict per case.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  allContractSettingKeys,
  checkContractSettings,
  contractSettingKeys,
  contractVerbs,
  type ContractProfile,
} from "../lib/cloud-frames-contract";
import { allowedFrameCommandTypes, allowedFrameSettings, esp32SettableKeys, validateFrameSettings } from "../lib/frames";
import {
  allCloudFrameSettingKeys,
  esp32CloudFrameSettingKeysForVersion,
} from "../../../../../frontend/src/utils/cloudFrameSettings";

interface SettingsFixture {
  name: string;
  settings: Record<string, unknown>;
  expect: Record<ContractProfile, string>;
}

const fixtures = JSON.parse(
  readFileSync(new URL("../../../../../docs/cloud-frames-fixtures.json", import.meta.url), "utf8"),
) as { settings: SettingsFixture[]; verbs: { name: string; type: string; expect: string }[] };

interface ContractSettingSpec {
  profiles: Record<string, unknown>;
  parity?: { only: string; why: string };
}
interface ContractVerbSpec {
  type: string;
  scope: string | null;
  profiles: string[];
  parity?: { only: string; why: string };
}
const contract = JSON.parse(
  readFileSync(new URL("../../../../../docs/cloud-frames-contract.json", import.meta.url), "utf8"),
) as { profiles: string[]; settings: Record<string, ContractSettingSpec>; verbs: ContractVerbSpec[] };

// Every non-test, non-generated source the cloud queues commands from. A
// verb is "issued" when some code path names it as a command type.
function providerSources(): string[] {
  const roots = [
    new URL("../../app/api/", import.meta.url),
    new URL("../lib/", import.meta.url),
    new URL("../../../frame-hub/src/", import.meta.url),
    new URL("../../../../packages/mcp/src/", import.meta.url),
  ];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "test") walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$|\.gen\.ts$/.test(entry.name)) {
        out.push(readFileSync(full, "utf8"));
      }
    }
  };
  for (const root of roots) walk(fileURLToPath(root));
  return out;
}

describe("settings parity between the device planes", () => {
  // docs/convergence-todo.md item 6: a key one plane accepts and the other
  // does not is the measured parity gap, and every such key must say why.
  it("every single-plane key carries a parity reason, and no both-planes key does", () => {
    const every = new Set(contract.profiles);
    for (const [name, spec] of Object.entries(contract.settings)) {
      const present = Object.keys(spec.profiles);
      const isSingle = present.length !== every.size;
      if (isSingle) {
        expect(spec.parity, `${name} is single-plane without a parity entry`).toBeDefined();
        expect(present, name).toEqual([spec.parity!.only]);
        expect(spec.parity!.why.trim().length, name).toBeGreaterThanOrEqual(20);
      } else {
        expect(spec.parity, `${name} is both-planes and must not carry parity`).toBeUndefined();
      }
    }
  });

  it("the gap does not grow past today's measurement", () => {
    const counts: Record<string, number> = {};
    for (const spec of Object.values(contract.settings)) {
      if (spec.parity) counts[spec.parity.only] = (counts[spec.parity.only] ?? 0) + 1;
    }
    expect(counts.linux ?? 0).toBeLessThanOrEqual(8);
    expect(counts.esp32 ?? 0).toBeLessThanOrEqual(7);
  });
});

describe("verb parity between the device planes", () => {
  // Same rule as the settings keys: a verb one plane refuses with
  // unsupported_verb must say why, and a both-planes verb must not.
  it("every verb names its profiles, single-plane ones with a parity reason", () => {
    const every = new Set(contract.profiles);
    for (const verb of contract.verbs) {
      expect(verb.profiles.length, verb.type).toBeGreaterThan(0);
      for (const profile of verb.profiles) expect(every.has(profile), `${verb.type}: ${profile}`).toBe(true);
      if (verb.profiles.length !== every.size) {
        expect(verb.parity, `${verb.type} is single-plane without a parity entry`).toBeDefined();
        expect(verb.profiles, verb.type).toEqual([verb.parity!.only]);
        expect(verb.parity!.why.trim().length, verb.type).toBeGreaterThanOrEqual(20);
      } else {
        expect(verb.parity, `${verb.type} is both-planes and must not carry parity`).toBeUndefined();
      }
    }
  });

  // The other half of "no dead verbs": every verb the planes implement is
  // actually issued by some provider code path — either a dedicated one
  // (`type: "get_state"`) or the generic owner command route's allowlist.
  // get_state and get_logs sat in the table for weeks with both planes
  // implementing and testing them and nothing on the cloud ever sending one.
  it("every contract verb is issued by the cloud", () => {
    const sources = providerSources();
    expect(sources.length).toBeGreaterThan(20);
    // A quoted verb name in provider source: `type: "reboot"`, or the verb
    // handed to a helper (`runAssetWriteCommand(db, …, "asset_mkdir", …)`).
    // Backticks are deliberately not quotes here — prose in comments cites
    // verbs that way, and a comment is not an issuer.
    const literal = (verb: string) =>
      sources.some((source) => new RegExp(`["']${verb}["']`).test(source));
    for (const verb of contract.verbs) {
      const issued = literal(verb.type) || allowedFrameCommandTypes.has(verb.type);
      expect(issued, `${verb.type} is implemented by every device plane and sent by nobody`).toBe(true);
    }
    // The two the review found dead now have dedicated paths (the /states
    // route and the Logs panel's ring pull), not just allowlist entries.
    expect(literal("get_state")).toBe(true);
    expect(literal("get_logs")).toBe(true);
  });
});

describe("cloud verb contract fixtures", () => {
  it("has cases", () => {
    expect(fixtures.settings.length).toBeGreaterThan(50);
  });

  for (const profile of ["linux", "esp32"] as const) {
    it(`gives the contract's verdict on every settings case (${profile})`, () => {
      for (const fixture of fixtures.settings) {
        const verdict = checkContractSettings(fixture.settings, profile) ?? "ok";
        expect(verdict, `${fixture.name} [${profile}]`).toBe(fixture.expect[profile]);
      }
    });
  }

  it("validateFrameSettings with a profile is the device's verdict", () => {
    for (const fixture of fixtures.settings) {
      for (const profile of ["linux", "esp32"] as const) {
        const result = validateFrameSettings(fixture.settings, profile);
        const verdict = result.error ?? "ok";
        expect(verdict, `${fixture.name} [${profile}]`).toBe(fixture.expect[profile]);
      }
    }
  });

  it("a value some profile accepts passes the client-facing allowlist, one nobody accepts fails it", () => {
    for (const fixture of fixtures.settings) {
      const accepted = Object.values(fixture.expect).some((v) => v === "ok");
      const keys = Object.keys(fixture.settings);
      const key = keys[0];
      if (keys.length !== 1 || key === undefined) continue;
      const check = allowedFrameSettings.get(key);
      const anyProfileTakesKey = Object.values(fixture.expect).some((v) => v !== "setting_not_allowed");
      if (!anyProfileTakesKey) {
        expect(check, `${fixture.name}: ${key} must not be allowlisted`).toBeUndefined();
        continue;
      }
      if (!check) {
        // Companion keys are attached by the cloud, never sent by a client.
        expect(key, fixture.name).toBe("timezone_data");
        continue;
      }
      // A single-key push that no profile takes as-is either fails the value
      // check or needs its companion (timezone_data alone).
      if (!accepted) {
        expect(check(fixture.settings[key]), fixture.name).toBe(false);
      }
    }
  });

  it("the client-facing lists are the contract's profiles", () => {
    expect(new Set(allowedFrameSettings.keys())).toEqual(new Set(allContractSettingKeys()));
    expect(new Set(esp32SettableKeys)).toEqual(new Set(contractSettingKeys("esp32")));
    expect(new Set(allCloudFrameSettingKeys)).toEqual(new Set(allContractSettingKeys()));
    // A fully current ESP32 can be sent exactly its profile.
    expect(new Set(esp32CloudFrameSettingKeysForVersion("2099.1.1"))).toEqual(new Set(contractSettingKeys("esp32")));
  });

  it("every command the provider may queue is a contract verb, and the classic non-verbs are not", () => {
    const verbs = new Set<string>(contractVerbs.map((verb) => verb.type));
    for (const type of allowedFrameCommandTypes) {
      expect(verbs.has(type), type).toBe(true);
    }
    for (const fixture of fixtures.verbs) {
      if (fixture.expect === "unknown_verb") {
        expect(verbs.has(fixture.type), fixture.name).toBe(false);
      }
    }
    expect(contractVerbs.find((verb) => (verb.type as string) === "get_logs")?.scope).toBe("telemetry:logs");
  });
});
