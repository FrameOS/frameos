// The cloud's runner of docs/event-fixtures.json, the conformance corpus of
// the scene event contract (docs/events-contract.json, docs/events.md). The
// Nim runtime (test_event_fixtures.nim), the firmware's C table
// (test_fos_events.c) and the backend (test_events_contract.py) run the same
// file. The cloud owns two origins: `cloud` — which events the frame event
// route turns into a hub verb — and the `schedule` it validates before a
// device ever sees it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contractVerbs, type ContractProfile } from "../lib/cloud-frames-contract";
import { cloudEventRouteVerbs } from "../lib/events-contract.gen";
import { cloudEventVerb } from "../lib/frame-events";
import { validateFrameSchedule } from "../lib/frames";

interface OriginCase {
  origin: string;
  event: string;
  allowed: boolean;
}
interface CloudRouteCase {
  event: string;
  verb: string | null;
  profiles?: ContractProfile[];
}

const repoFile = (path: string): string =>
  readFileSync(new URL(`../../../../../${path}`, import.meta.url), "utf8");

const fixtures = JSON.parse(repoFile("docs/event-fixtures.json")) as {
  origins: { cases: OriginCase[] };
  cloudEventRoute: { cases: CloudRouteCase[] };
};
const contract = JSON.parse(repoFile("docs/events-contract.json")) as {
  customEvents: { maxNameLength: number };
  events: { name: string; origins: string[]; cloud?: { verb: string; eventRoute?: boolean } }[];
};

const profiles: ContractProfile[] = ["linux", "esp32"];

function schedule(event: string): unknown {
  return { events: [{ event, hour: 1, id: "a", minute: 2, payload: {}, weekday: 0 }] };
}

describe("the frame event route", () => {
  it("turns an event into the verb the fixtures name, on the profiles they name", () => {
    expect(fixtures.cloudEventRoute.cases.length).toBeGreaterThan(10);
    for (const c of fixtures.cloudEventRoute.cases) {
      for (const profile of profiles) {
        const expected =
          c.verb !== null && (c.profiles ?? profiles).includes(profile) ? { verb: c.verb } : undefined;
        expect(cloudEventVerb(c.event, profile), `${c.event} on ${profile}`).toEqual(expected);
      }
    }
  });

  it("covers every event the contract gives the cloud origin on this route", () => {
    const routed = contract.events
      .filter((event) => event.cloud && event.cloud.eventRoute !== false)
      .map((event) => event.name);
    expect(Object.keys(cloudEventRouteVerbs)).toEqual(routed);
    const covered = new Set(fixtures.cloudEventRoute.cases.map((c) => c.event));
    expect(routed.filter((name) => !covered.has(name))).toEqual([]);
  });

  it("only names verbs the hub contract has", () => {
    const verbs = new Set<string>(contractVerbs.map((verb) => verb.type));
    for (const event of contract.events) {
      if (event.cloud) {
        expect(verbs.has(event.cloud.verb), `${event.name} -> ${event.cloud.verb}`).toBe(true);
      }
    }
  });

  it("is not a way around prototype keys", () => {
    expect(cloudEventVerb("constructor", "linux")).toBeUndefined();
    expect(cloudEventVerb("__proto__", "linux")).toBeUndefined();
  });

  it("has a case in the route for each event it accepts", () => {
    const route = repoFile("cloud/apps/auth-web/app/api/frames/[frameId]/event/[eventName]/route.ts");
    for (const name of Object.keys(cloudEventRouteVerbs)) {
      expect(route, name).toContain(`case "${name}":`);
    }
  });
});

describe("the schedule validator", () => {
  it("refuses what the schedule origin may not emit, and nothing else", () => {
    const cases = fixtures.origins.cases.filter((c) => c.origin === "schedule");
    expect(cases.length).toBeGreaterThan(5);
    for (const c of cases) {
      const result = validateFrameSchedule(schedule(c.event));
      expect(result.error === undefined, `schedule / ${c.event}`).toBe(c.allowed);
    }
  });

  it("holds an event name to the contract's length", () => {
    const limit = contract.customEvents.maxNameLength;
    expect(validateFrameSchedule(schedule("x".repeat(limit))).error).toBeUndefined();
    expect(validateFrameSchedule(schedule("x".repeat(limit + 1))).error).toBe("invalid_schedule");
  });
});
