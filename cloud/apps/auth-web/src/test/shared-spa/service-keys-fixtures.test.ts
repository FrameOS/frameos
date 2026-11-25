// Which key each scene on a frame may use, and what the frame is sent
// (docs/service-keys.md): the SPA and the cloud server decide it with
// frontend/src/utils/serviceKeys.ts, the backend with its Python port, both
// pinned by docs/service-keys-fixtures.json. The `runtime` and `inject`
// sections are the frame's half and run in the Nim suite.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildServiceKeysWire,
  deliverableServiceValues,
  isServiceId,
  resolveSceneKeyBindings,
  serviceFieldSecrecy,
  type ServiceCredential,
  type ServiceKeysScene,
} from "../../../../../../frontend/src/utils/serviceKeys";

type Fixtures = {
  serviceId: { id: string; isService: boolean }[];
  secrecy: { service: string; field: string; secret: boolean | null }[];
  deliverable: { name: string; service: string; stored: unknown; values: Record<string, string> | null }[];
  resolve: {
    name: string;
    declared: string[];
    keys: unknown;
    legacyGranted: string[];
    credentials: Record<string, ServiceCredential>;
    bindings: Record<string, string | null>;
  }[];
  wire: {
    name: string;
    scenes: ServiceKeysScene[];
    settings: Record<string, unknown>;
    expect: unknown;
  }[];
};

const fixtures = JSON.parse(
  readFileSync(join(__dirname, "../../../../../../docs/service-keys-fixtures.json"), "utf8"),
) as Fixtures;

describe("docs/service-keys-fixtures.json", () => {
  describe("serviceId", () => {
    for (const kase of fixtures.serviceId) {
      it(`${JSON.stringify(kase.id)} ${kase.isService ? "is" : "is not"} a service id`, () => {
        expect(isServiceId(kase.id)).toBe(kase.isService);
      });
    }
  });

  describe("secrecy", () => {
    for (const kase of fixtures.secrecy) {
      it(`${kase.service}.${kase.field}`, () => {
        expect(serviceFieldSecrecy(kase.service, kase.field)).toBe(kase.secret);
      });
    }
  });

  describe("deliverable", () => {
    for (const kase of fixtures.deliverable) {
      it(kase.name, () => {
        expect(deliverableServiceValues(kase.service, kase.stored)).toEqual(kase.values);
      });
    }
  });

  describe("resolve", () => {
    for (const kase of fixtures.resolve) {
      it(kase.name, () => {
        expect(
          resolveSceneKeyBindings({
            credentials: kase.credentials,
            declared: kase.declared,
            keys: kase.keys,
            legacyGranted: kase.legacyGranted,
          }),
        ).toEqual(kase.bindings);
      });
    }
  });

  describe("wire", () => {
    for (const kase of fixtures.wire) {
      it(kase.name, () => {
        expect(buildServiceKeysWire({ scenes: kase.scenes, settings: kase.settings })).toEqual(kase.expect);
      });
    }
  });
});
