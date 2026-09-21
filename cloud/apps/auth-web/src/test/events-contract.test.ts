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
import {
  cloudCustomEventRoute,
  cloudEventRouteVerbs,
  contractEventNames,
} from "../lib/events-contract.gen";
import {
  cloudEventRouting,
  cloudEventVerb,
  customEventRouting,
  isContractEventName,
  sceneEventCommand,
  type CloudEventRouting,
} from "../lib/frame-events";
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
  /** What the frame reports; absent = nothing, which is older than any `since`. */
  frameosVersion?: string;
  /** What the scene the frame is showing declares. */
  customEvents?: unknown[];
  /** The refusal where there is no verb; absent = unsupported_event. */
  error?: string;
}
interface SceneEventCase {
  name: string;
  payload?: unknown;
  error: string | null;
}

const repoFile = (path: string): string =>
  readFileSync(new URL(`../../../../../${path}`, import.meta.url), "utf8");

const fixtures = JSON.parse(repoFile("docs/event-fixtures.json")) as {
  origins: { cases: OriginCase[] };
  cloudEventRoute: { cases: CloudRouteCase[]; sceneEventCases: SceneEventCase[] };
};
const contract = JSON.parse(repoFile("docs/events-contract.json")) as {
  customEvents: { maxNameLength: number; cloud?: { verb: string; since?: string } };
  events: {
    name: string;
    class: string;
    origins: string[];
    cloud?: { verb: string; eventRoute?: boolean; since?: string; before?: { verb: string } };
  }[];
};

const profiles: ContractProfile[] = ["linux", "esp32"];

function schedule(event: string): unknown {
  return { events: [{ event, hour: 1, id: "a", minute: 2, payload: {}, weekday: 0 }] };
}

// The route's own decision: a contract event by the contract's table, any
// other name as a custom event of the scene the frame is showing.
function routeCase(c: CloudRouteCase, profile: ContractProfile): CloudEventRouting {
  return isContractEventName(c.event)
    ? cloudEventRouting(c.event, profile, c.frameosVersion)
    : customEventRouting({
        activeSceneId: "uploaded/showing",
        eventName: c.event,
        frameosVersion: c.frameosVersion,
        profile,
        scenes: [{ customEvents: c.customEvents, id: "showing" }],
      });
}

describe("the frame event route", () => {
  it("turns an event into the verb the fixtures name, on the profiles and firmware they name", () => {
    expect(fixtures.cloudEventRoute.cases.length).toBeGreaterThan(20);
    for (const c of fixtures.cloudEventRoute.cases) {
      for (const profile of profiles) {
        const what = `${c.event} on ${profile} ${c.frameosVersion ?? "(no version)"}`;
        const routed = routeCase(c, profile);
        if (c.verb !== null && (c.profiles ?? profiles).includes(profile)) {
          expect(routed, what).toEqual({ ok: true, verb: c.verb });
        } else {
          expect(routed.ok, what).toBe(false);
          expect(routed.ok ? undefined : routed.error, what).toBe(c.error ?? "unsupported_event");
        }
        if (isContractEventName(c.event)) {
          expect(cloudEventVerb(c.event, profile, c.frameosVersion), what).toEqual(
            routed.ok ? { verb: routed.verb } : undefined,
          );
        }
      }
    }
  });

  it("says which release a frame needs when only its firmware is in the way", () => {
    expect(cloudEventRouting("button", "esp32", "2026.9.20")).toEqual({
      error: "frame_update_required",
      minFrameosVersion: "2026.9.21",
      ok: false,
      status: 409,
    });
    // The raw command route names the verb itself: no stand-in.
    expect(cloudEventRouting("setSceneState", "linux", "2026.9.20", { allowBefore: false })).toMatchObject({
      error: "frame_update_required",
    });
  });

  it("lets scene_event carry what the fixtures say, and nothing else", () => {
    expect(fixtures.cloudEventRoute.sceneEventCases.length).toBeGreaterThan(10);
    for (const c of fixtures.cloudEventRoute.sceneEventCases) {
      const built = sceneEventCommand(c.name, c.payload);
      expect(built.ok ? null : built.error, `scene_event ${c.name}`).toBe(c.error);
      if (built.ok) {
        expect(built.payload).toEqual({
          name: c.name,
          ...(c.payload === undefined ? {} : { payload: c.payload }),
        });
      }
    }
  });

  it("never lets a device command ride scene_event", () => {
    const deviceCommands = contract.events.filter((event) => event.class === "device-command");
    expect(deviceCommands.length).toBeGreaterThan(3);
    for (const event of deviceCommands) {
      expect(sceneEventCommand(event.name), event.name).toMatchObject({ error: "event_not_allowed" });
    }
    // …and what does ride it is what the contract routes there.
    for (const event of contract.events) {
      expect(sceneEventCommand(event.name).ok, event.name).toBe(event.cloud?.verb === "scene_event");
    }
  });

  it("knows the contract's names, and its custom event route", () => {
    expect([...contractEventNames]).toEqual(contract.events.map((event) => event.name));
    expect(cloudCustomEventRoute).toEqual(contract.customEvents.cloud);
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
