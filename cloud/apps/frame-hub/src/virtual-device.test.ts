import { describe, expect, it } from "vitest";
import type { SceneRenderOptions, SceneRenderResult } from "../../auth-web/src/lib/scene-render";
import { createVirtualRenderQueue, localMinute, scheduleWeekdayMatches } from "./virtual-device";

describe("the schedule's clock", () => {
  it("reads the wall clock of the frame's time zone", () => {
    // A Tuesday morning in UTC is still Monday evening in Los Angeles.
    const at = new Date("2026-11-03T06:30:00Z");
    expect(localMinute(at, "UTC")).toEqual({ hour: 6, minute: 30, weekday: 2 });
    expect(localMinute(at, "Europe/Tallinn")).toEqual({ hour: 8, minute: 30, weekday: 2 });
    expect(localMinute(at, "America/Los_Angeles")).toEqual({ hour: 22, minute: 30, weekday: 1 });
    // Midnight is hour 0, not 24.
    expect(localMinute(new Date("2026-11-08T00:05:00Z"), "UTC")).toEqual({ hour: 0, minute: 5, weekday: 7 });
    // A zone nobody has heard of falls back to UTC instead of throwing.
    expect(localMinute(at, "Mars/Olympus_Mons")).toEqual({ hour: 6, minute: 30, weekday: 2 });
  });

  it("matches the schedule's weekday numbers", () => {
    for (let weekday = 1; weekday <= 7; weekday += 1) {
      expect(scheduleWeekdayMatches(0, weekday)).toBe(true);
      expect(scheduleWeekdayMatches(weekday, weekday)).toBe(true);
      expect(scheduleWeekdayMatches(8, weekday)).toBe(weekday <= 5);
      expect(scheduleWeekdayMatches(9, weekday)).toBe(weekday >= 6);
    }
    expect(scheduleWeekdayMatches(3, 4)).toBe(false);
  });
});

describe("the render queue", () => {
  function deferredRender() {
    const started: string[] = [];
    const finish = new Map<string, () => void>();
    const render = (options: SceneRenderOptions) =>
      new Promise<SceneRenderResult>((resolve) => {
        const key = `${options.owner}:${options.sceneId}`;
        started.push(key);
        finish.set(key, () => resolve({ png: Buffer.alloc(0) } as SceneRenderResult));
      });
    return { finish, render, started };
  }
  const job = (owner: string, sceneId: string) => ({ height: 1, owner, sceneId, scenes: [], width: 1 });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("runs two at a time, and one per account", async () => {
    const { finish, render, started } = deferredRender();
    const queue = createVirtualRenderQueue(render, 2);
    const done: string[] = [];
    for (const [owner, scene] of [
      ["a", "1"],
      ["a", "2"],
      ["b", "1"],
      ["c", "1"],
    ] as const) {
      void queue(job(owner, scene)).then(() => done.push(`${owner}:${scene}`));
    }
    await tick();
    // a's second frame waits for its first; b takes the other slot ahead of it.
    expect(started).toEqual(["a:1", "b:1"]);
    finish.get("b:1")!();
    await tick();
    expect(started).toEqual(["a:1", "b:1", "c:1"]);
    finish.get("a:1")!();
    await tick();
    expect(started).toEqual(["a:1", "b:1", "c:1", "a:2"]);
    finish.get("c:1")!();
    finish.get("a:2")!();
    await tick();
    expect(done.sort()).toEqual(["a:1", "a:2", "b:1", "c:1"]);
  });

  it("frees the slot of a render that failed", async () => {
    let calls = 0;
    const queue = createVirtualRenderQueue(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("boom");
      }
      return { png: Buffer.alloc(0) } as SceneRenderResult;
    }, 1);
    await expect(queue(job("a", "1"))).rejects.toThrow("boom");
    await expect(queue(job("a", "2"))).resolves.toBeDefined();
  });
});
