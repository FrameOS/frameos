// "Button actions" reads the frame's event map into rows and writes rows
// back as rules; the iOS app does the same with its port
// (ios/FrameOSKit/Sources/FrameOSKit/Contracts/ButtonBindings.swift). Both
// replay docs/button-map-fixtures.json.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bindingOfRule,
  bindingRule,
  frameActionTitle,
  frameGestureTitle,
} from "../../../../../../frontend/src/utils/frameEventMap";

const fixtures = JSON.parse(readFileSync(join(__dirname, "../../../../../../docs/button-map-fixtures.json"), "utf8")) as {
  cases: { rule: any; expect: { binding: any; gestureTitle: string; actionTitle: string; rule: any } | null }[];
};
const scenes = [{ id: "weather", name: "Weather" }] as any;

describe("docs/button-map-fixtures.json", () => {
  for (const [index, kase] of fixtures.cases.entries()) {
    it(`rule ${index}: ${JSON.stringify(kase.rule.match)} ${kase.rule.emit ?? "(rewrite)"}`, () => {
      const binding = bindingOfRule(kase.rule);
      if (!kase.expect) {
        expect(binding).toBeNull();
        return;
      }
      expect(binding).toEqual(kase.expect.binding);
      expect(frameGestureTitle(binding!.gesture)).toBe(kase.expect.gestureTitle);
      expect(frameActionTitle(binding!.action, scenes)).toBe(kase.expect.actionTitle);
      expect(bindingRule(binding!)).toEqual(kase.expect.rule);
    });
  }
});
