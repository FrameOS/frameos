import { afterEach, describe, expect, it } from "vitest";
import {
  getLegalEntity,
  isLegalEntityConfigured,
  placeholder,
  processors,
} from "./legal";

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("FRAMEOS_LEGAL_")) {
      delete process.env[key];
    }
  }
});

describe("legal entity", () => {
  it("renders a visible placeholder rather than blank fields", () => {
    // A privacy policy with a quietly missing controller name is worse than
    // one that says out loud it is incomplete — the missing name is exactly
    // the part art. 13 requires, and the pages render a warning off this.
    const entity = getLegalEntity();
    expect(entity.name).toBe(placeholder);
    expect(entity.companyNumber).toBe(placeholder);
    expect(entity.address).toEqual([placeholder]);
    expect(isLegalEntityConfigured()).toBe(false);
  });

  it("splits a one-line address env var into lines", () => {
    process.env.FRAMEOS_LEGAL_ENTITY_ADDRESS = "Somestraat 1|1000 Brussels";

    expect(getLegalEntity().address).toEqual(["Somestraat 1", "1000 Brussels"]);
  });

  it("defaults the country to Belgium but lets a self-hoster override it", () => {
    expect(getLegalEntity().country).toBe("Belgium");

    process.env.FRAMEOS_LEGAL_ENTITY_COUNTRY = "Netherlands";
    expect(getLegalEntity().country).toBe("Netherlands");
  });

  it("counts as configured once the entity name is set", () => {
    process.env.FRAMEOS_LEGAL_ENTITY_NAME = "Example Frames BV";

    expect(isLegalEntityConfigured()).toBe(true);
    expect(getLegalEntity().name).toBe("Example Frames BV");
  });
});

describe("processor list", () => {
  // This list IS the promise the privacy policy makes. A processor that
  // appears in the code but not here is a straightforward GDPR breach, so
  // keep the shape enforced and re-audit outbound hosts when adding one.
  it("describes every processor completely", () => {
    expect(processors.length).toBeGreaterThan(0);
    for (const processor of processors) {
      expect(processor.name).toBeTruthy();
      expect(processor.purpose).toBeTruthy();
      expect(processor.data).toBeTruthy();
      expect(processor.location).toBeTruthy();
      expect(processor.privacyUrl).toMatch(/^https:\/\//);
    }
  });

  it("names the analytics and email processors the code actually calls", () => {
    const names = processors.map((processor) => processor.name);
    expect(names.some((name) => name.includes("PostHog"))).toBe(true);
    expect(names.some((name) => name.includes("Postmark"))).toBe(true);
    expect(names.some((name) => name.includes("Hetzner"))).toBe(true);
  });
});
