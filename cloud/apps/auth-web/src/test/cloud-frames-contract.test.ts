// The conformance corpus (docs/cloud-frames-fixtures.json) against the cloud's
// walker of the verb contract. The Linux runtime (test_cloud_contract.nim)
// and the ESP32 firmware (test_fos_cloud_contract.c) run the same file —
// three implementations, one verdict per case.
import { readFileSync } from "node:fs";
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
