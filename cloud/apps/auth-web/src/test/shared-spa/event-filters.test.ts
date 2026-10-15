// The event node's filter rows (frontend/src/utils/eventFilters.ts): what the
// catalog folds (`filter: "more"`, docs/events.md "Payloads, units and the
// wire") stays off screen until set, and a field the contract gives values to
// is a select rather than a free text.
import { describe, expect, it } from "vitest";
import {
  eventFilterControl,
  eventFilterFieldsToShow,
  foldedEventFilterCount,
} from "../../../../../../frontend/src/utils/eventFilters";
import { buttonActions, buttonRoles } from "../../../../../../frontend/src/utils/eventsContract.gen";
import catalog from "../../../../../../frontend/schema/events.json";
import type { AppConfigField, FrameEvent } from "../../../../../../frontend/src/types";

const events = catalog as FrameEvent[];
const fieldsOf = (name: string): AppConfigField[] => events.find((event) => event.name === name)?.fields ?? [];
const names = (fields: AppConfigField[]): string[] => fields.map((field) => field.name);

describe("event node filters", () => {
  it("a button listener shows role and action; the rest is folded until set", () => {
    const fields = fieldsOf("button");
    expect(names(eventFilterFieldsToShow(fields, {}, false))).toEqual(["role", "action"]);
    expect(foldedEventFilterCount(fields, {})).toBe(4);
    expect(names(eventFilterFieldsToShow(fields, { label: "A" }, false))).toEqual(["label", "role", "action"]);
    expect(foldedEventFilterCount(fields, { label: "A" })).toBe(3);
    expect(names(eventFilterFieldsToShow(fields, {}, true))).toEqual(names(fields));
  });

  it("pointer positions and ids are folded, the pointer type and button are not", () => {
    expect(names(eventFilterFieldsToShow(fieldsOf("pointerDown"), {}, false))).toEqual(["button", "pointerType"]);
    expect(names(eventFilterFieldsToShow(fieldsOf("swipe"), {}, false))).toEqual(["direction", "pointerType"]);
    expect(names(eventFilterFieldsToShow(fieldsOf("keyDown"), {}, false))).toEqual([
      "code", "key", "shift", "ctrl", "alt", "meta",
    ]);
  });

  it("the contract's lists are selects, starting with any", () => {
    const fields = fieldsOf("button");
    const role = eventFilterControl("button", fields.find((f) => f.name === "role")!);
    expect(role).toEqual({
      kind: "select",
      options: [{ value: "", label: "any" }, ...buttonRoles.map((value) => ({ value, label: value }))],
    });
    const action = eventFilterControl("button", fields.find((f) => f.name === "action")!);
    expect(action.kind === "select" && action.options.map((o) => o.value)).toEqual(["", ...buttonActions]);
    const direction = eventFilterControl("swipe", fieldsOf("swipe").find((f) => f.name === "direction")!);
    expect(direction.kind === "select" && direction.options.map((o) => o.value)).toEqual([
      "", "left", "right", "up", "down",
    ]);
  });

  it("a boolean is yes/no, a number is a number box, a string is text", () => {
    const fields = fieldsOf("button");
    expect(eventFilterControl("button", fields.find((f) => f.name === "wake")!)).toEqual({
      kind: "select",
      options: [{ value: "", label: "any" }, { value: "true", label: "yes" }, { value: "false", label: "no" }],
    });
    expect(eventFilterControl("button", fields.find((f) => f.name === "durationMs")!)).toEqual({ kind: "number" });
    expect(eventFilterControl("button", fields.find((f) => f.name === "pin")!)).toEqual({ kind: "number" });
    expect(eventFilterControl("button", fields.find((f) => f.name === "label")!)).toEqual({ kind: "text" });
    expect(eventFilterControl("keyDown", fieldsOf("keyDown").find((f) => f.name === "code")!)).toEqual({ kind: "text" });
  });

  it("a frame whose buttons are known offers them for label and pin, and names them on the roles", () => {
    const fields = fieldsOf("button");
    const buttons = [{ pin: 5, label: "A" }, { pin: 6, label: "B" }, { pin: 7, label: "Odd" }];
    const label = eventFilterControl("button", fields.find((f) => f.name === "label")!, buttons);
    expect(label.kind === "select" && label.options).toEqual([
      { value: "", label: "any" }, { value: "A", label: "A" }, { value: "B", label: "B" }, { value: "Odd", label: "Odd" },
    ]);
    const pin = eventFilterControl("button", fields.find((f) => f.name === "pin")!, buttons);
    expect(pin.kind === "select" && pin.options.map((o) => o.label)).toEqual(["any", "5 (A)", "6 (B)", "7 (Odd)"]);
    const role = eventFilterControl("button", fields.find((f) => f.name === "role")!, buttons);
    expect(role.kind === "select" && role.options.map((o) => o.label)).toEqual([
      "any", "primary (A)", "secondary", "next (B)", "prev", "up", "down", "back", "menu", "refresh",
    ]);
    // An empty list (a frame with no buttons) and an unknown frame draw the plain controls.
    expect(eventFilterControl("button", fields.find((f) => f.name === "label")!, []).kind).toBe("text");
    expect(eventFilterControl("button", fields.find((f) => f.name === "pin")!, null).kind).toBe("number");
  });
});
