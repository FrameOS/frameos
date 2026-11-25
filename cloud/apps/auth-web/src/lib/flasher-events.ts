// What flash.frameos.net counts (cloud/docs/flasher.md "What is counted"):
// anonymous events the page sends to /api/flasher/events, passed on to
// PostHog. The page has no account and stores nothing on the device, so an
// event names no person: a visit id that lives only in the page's memory,
// and facts about the board and the run. Anything else is dropped here: an
// event the page does not send, a property not on these lists, a value that
// is not one of its kind.

export const flasherEventNames = [
  "flasher opened",
  "flasher flash started",
  "flasher flash finished",
  "flasher tool used",
] as const;

export type FlasherEventName = (typeof flasherEventNames)[number];

// Properties that are one of a few words.
const choices: Record<string, readonly string[]> = {
  // How the page was reached: on its own, or opened by a backend's USB card.
  entry: ["page", "bridge"],
  // What it was doing: a standalone frame, a backend's job, a setup file.
  mode: ["standalone", "bridge", "file"],
  kind: ["setup", "update", "provision"],
  outcome: ["done", "written", "failed", "cancelled"],
  usb: ["yes", "blocked", "no"],
  tool: ["connect", "wifi", "restart"],
  // The set of scenes picked: a preset, or "hand" for one picked by hand.
  preset: ["starter", "interactive", "paper", "everything", "store", "hand"],
};

// Catalog keys and chip names (a board preset, a panel, esp32-s3, 16MB).
const keys = ["board", "panel", "platform", "flash_size"] as const;
const keyPattern = /^[A-Za-z0-9._-]{1,64}$/;

// Counts and durations.
const numbers = ["scenes", "scene_bytes", "seconds"] as const;
const maxNumber = 1_000_000_000;

const flags = ["board_from_link"] as const;

const visitPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface FlasherEvent {
  event: FlasherEventName;
  visit: string;
  properties: Record<string, string | number | boolean>;
}

/** The event in `body` as the page sent it, or null when it is not one. */
export function parseFlasherEvent(body: unknown): FlasherEvent | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const { event, visit, properties } = body as Record<string, unknown>;
  if (typeof event !== "string" || !(flasherEventNames as readonly string[]).includes(event)) {
    return null;
  }
  if (typeof visit !== "string" || !visitPattern.test(visit)) {
    return null;
  }
  const given =
    properties && typeof properties === "object" && !Array.isArray(properties)
      ? (properties as Record<string, unknown>)
      : {};
  const kept: FlasherEvent["properties"] = {};
  for (const [name, allowed] of Object.entries(choices)) {
    const value = given[name];
    if (typeof value === "string" && allowed.includes(value)) {
      kept[name] = value;
    }
  }
  for (const name of keys) {
    const value = given[name];
    if (typeof value === "string" && keyPattern.test(value)) {
      kept[name] = value;
    }
  }
  for (const name of numbers) {
    const value = given[name];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maxNumber) {
      kept[name] = Math.round(value);
    }
  }
  for (const name of flags) {
    const value = given[name];
    if (typeof value === "boolean") {
      kept[name] = value;
    }
  }
  return { event: event as FlasherEventName, visit, properties: kept };
}
