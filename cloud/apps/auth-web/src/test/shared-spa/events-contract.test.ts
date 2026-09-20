// The shared SPA's and the frameos-wasm package's reading of the scene event
// contract (docs/events-contract.json, docs/events.md). Every list this file
// looks at used to be kept by hand, two or three times, and had drifted
// (docs/event-system-analysis.md §3.1); they are generated now, and what is
// tested here is that the readers agree with the contract and each other.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LIFECYCLE_EVENTS, POINTER_EVENTS, sceneEventButtons } from "frameos-wasm";
import {
  appContextKeys,
  codeContextKeys,
  codeContextMembers,
  contractEventSpecs,
  eventTypeDeclarations,
} from "../../../../../../frontend/src/utils/eventsContract.gen";
import {
  contractEventSpec,
  eventOffersSceneState,
  eventPayloadIsSceneState,
  isHostEvent,
  isPointerEvent,
  logEventIsSceneChange,
  logEventIsSceneStateChange,
  schedulableContractEvents,
} from "../../../../../../frontend/src/utils/eventsContract";
import catalog from "../../../../../../frontend/schema/events.json";

const repoFile = (path: string): string =>
  readFileSync(new URL(`../../../../../../${path}`, import.meta.url), "utf8");

interface ContractEvent {
  name: string;
  class: string;
  device?: string;
  listen: boolean;
  dispatch: boolean;
  sceneState?: string;
}
const contract = JSON.parse(repoFile("docs/events-contract.json")) as {
  events: ContractEvent[];
  context: { keys: { name: string; sandboxes: string[] }[] };
  logEvents: { sceneChanged: string[]; sceneStateChanged: string[] };
};

describe("the editor catalog", () => {
  it("is the contract's listenable and dispatchable events, in order", () => {
    const offered = contract.events.filter((event) => event.listen || event.dispatch);
    expect(catalog.map((event) => event.name)).toEqual(offered.map((event) => event.name));
    for (const event of catalog as { name: string; canListen?: boolean; canDispatch?: boolean }[]) {
      const spec = contractEventSpecs[event.name as keyof typeof contractEventSpecs];
      expect(Boolean(event.canListen), event.name).toBe(spec.listen);
      expect(Boolean(event.canDispatch), event.name).toBe(spec.dispatch);
    }
  });

  it("never offers a device command to a scene", () => {
    const names = new Set(catalog.map((event) => event.name));
    for (const event of contract.events.filter((e) => e.class === "device-command")) {
      expect(names.has(event.name), event.name).toBe(false);
      expect(contractEventSpec(event.name)?.class).toBe("device-command");
    }
  });
});

describe("the helpers", () => {
  it("know a custom event from a contract one, prototype keys included", () => {
    expect(contractEventSpec("nextPage")).toBeUndefined();
    expect(contractEventSpec("constructor")).toBeUndefined();
    expect(contractEventSpec(null)).toBeUndefined();
    expect(contractEventSpec("button")?.device).toBe("button");
  });

  it("read the scene-state events from one column", () => {
    const offers = contract.events.filter((e) => e.sceneState).map((e) => e.name);
    expect(offers).toEqual(["init", "render", "setSceneState"]);
    for (const event of contract.events) {
      expect(eventOffersSceneState(event.name), event.name).toBe(event.sceneState !== undefined);
      expect(eventPayloadIsSceneState(event.name), event.name).toBe(event.sceneState === "payload");
    }
    expect(eventOffersSceneState("nextPage")).toBe(false);
  });

  it("offer the schedule panel a scene change, then what ends the runtime", () => {
    expect(schedulableContractEvents().map(({ name }) => name)).toEqual(["setCurrentScene", "restart", "reboot"]);
  });

  it("read the log lines a control plane follows a frame by", () => {
    for (const line of contract.logEvents.sceneChanged) {
      expect(logEventIsSceneChange(line)).toBe(true);
    }
    for (const line of contract.logEvents.sceneStateChanged) {
      expect(logEventIsSceneStateChange(line)).toBe(true);
    }
    expect(logEventIsSceneChange("render:done")).toBe(false);
    expect(logEventIsSceneChange(undefined)).toBe(false);
  });
});

describe("preview buttons", () => {
  // A preview offers a button for what a person would press: not for what the
  // host sends on its own, and not for pointer input (the canvas sends that).
  it("the SPA and the frameos-wasm package leave out the same events", () => {
    for (const event of contract.events) {
      expect(LIFECYCLE_EVENTS.has(event.name), event.name).toBe(isHostEvent(event.name));
      expect(POINTER_EVENTS.has(event.name), event.name).toBe(isPointerEvent(event.name));
    }
    expect([...POINTER_EVENTS]).toEqual(["mouseMove", "mouseDown", "mouseUp", "wheel"]);
    // turnOn / turnOff are scene commands: both lists used to forget them.
    expect(isHostEvent("turnOn") && isHostEvent("turnOff")).toBe(true);
  });

  it("a button, a key and a custom event get a button; host and pointer events do not", () => {
    const node = (id: string, keyword: string) => ({ id, type: "event", data: { keyword } });
    const names = ["init", "render", "open", "close", "setSceneState", "turnOn", "mouseMove", "wheel", "button", "keyDown", "nextPage"];
    const buttons = sceneEventButtons({
      id: "s",
      name: "s",
      nodes: names.map((name, index) => node(String(index), name)),
      edges: [],
    } as unknown as Parameters<typeof sceneEventButtons>[0]);
    expect(buttons.map((button) => button.keyword)).toEqual(["button", "keyDown", "nextPage"]);
  });
});

describe("the JavaScript `context`", () => {
  const keysOf = (sandbox: string): string[] =>
    contract.context.keys.filter((key) => key.sandboxes.includes(sandbox)).map((key) => key.name);

  it("has one generated shape per sandbox, read by both Monaco declaration files", () => {
    expect([...codeContextKeys]).toEqual(keysOf("code"));
    expect([...appContextKeys]).toEqual(keysOf("app"));
    for (const key of codeContextKeys) {
      expect(codeContextMembers).toContain(`  ${key}: `);
    }
    expect(repoFile("frontend/src/utils/codeNodeTypeDeclarations.ts")).toContain("${codeContextMembers}");
    expect(repoFile("frontend/src/utils/appTypeDeclarations.ts")).toContain("${appContextMembers}");
  });

  it("declares a payload for every event the editor offers, with interfaces only", () => {
    for (const event of catalog) {
      expect(eventTypeDeclarations).toContain(`  ${event.name}: `);
    }
    // Both editors add their declarations to ONE Monaco TypeScript program:
    // a second `type` alias of a name is a duplicate identifier, a second
    // identical interface merges.
    expect(eventTypeDeclarations).not.toMatch(/^type /m);
  });

  it("is what the runtime hands a code node and an app", () => {
    const codeRuntime = repoFile("frameos/src/frameos/js_runtime/runtime.nim");
    const getter = codeRuntime.slice(codeRuntime.indexOf("proc jsGetContext"), codeRuntime.indexOf("# Chrono proxies"));
    expect([...getter.matchAll(/^ {2}of "(\w+)":/gm)].map((m) => m[1]).sort()).toEqual([...codeContextKeys].sort());
    const appRuntime = repoFile("frameos/src/frameos/js_runtime/app_runtime.nim");
    const appGetter = appRuntime.slice(appRuntime.indexOf("proc jsGetAppContext"));
    const appKeys = [...appGetter.slice(0, appGetter.indexOf("\nproc ", 10)).matchAll(/^ {2}of "(\w+)":/gm)].map((m) => m[1]);
    expect(appKeys.sort()).toEqual([...appContextKeys].sort());
  });

  it("is spelled with at least the code-node keys wherever prose repeats it", () => {
    // Prose cannot import a table; these are the places that repeat the shape
    // (docs/event-system-analysis.md §3.1 #11). scene-convert's prompt also
    // lists imageWidth/imageHeight, which a code node does not have — known,
    // and the converter's to fix.
    for (const path of [
      "docs/js-apps-and-code-nodes.md",
      "cloud/packages/scene-convert/src/prompt.ts",
      "cloud/apps/auth-web/src/lib/ai/prompts.ts",
    ]) {
      const text = repoFile(path);
      for (const key of codeContextKeys) {
        expect(text, `${path}: ${key}`).toContain(key);
      }
    }
  });
});
