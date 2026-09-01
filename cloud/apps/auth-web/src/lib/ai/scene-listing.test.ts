import { describe, expect, it, vi } from "vitest";
import { executeTool, toolDefinitions, type ListingEvent, type ToolContext } from "./tools";
import type { JsonObject } from "./scene-utils";

// update_scene_listing delivers to the editor's draft, like patch_scene: it
// never touches the database. The listing is part of a version, and the
// user's Save publishes it.
function context(overrides: Partial<ToolContext> = {}): ToolContext & { events: ListingEvent[] } {
  const events: ListingEvent[] = [];
  return {
    accountId: "acct-1",
    db: {} as ToolContext["db"],
    emitListing: (event) => {
      events.push(event);
    },
    emitScenes: () => undefined,
    events,
    prompt: "update the description",
    storeSceneId: "11111111-2222-3333-4444-555555555555",
    ...overrides,
  };
}

async function call(args: JsonObject, ctx: ToolContext): Promise<JsonObject> {
  return JSON.parse(await executeTool("update_scene_listing", args, ctx)) as JsonObject;
}

describe("update_scene_listing", () => {
  it("is registered with a label and an object schema", () => {
    const definition = toolDefinitions.find((tool) => tool.name === "update_scene_listing");
    expect(definition).toBeDefined();
    const parameters = definition!.parameters as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(parameters.required ?? []).toEqual([]);
    expect(Object.keys(parameters.properties).sort()).toEqual([
      "category",
      "description",
      "frameos_version",
      "tags",
    ]);
  });

  it("delivers the named fields to the draft and says Save publishes them", async () => {
    const ctx = context({ currentListing: { description: "Old", tags: ["maps"] } });
    const output = await call({ description: "A map of everywhere I have been." }, ctx);
    expect(output.ok).toBe(true);
    expect(ctx.events).toEqual([
      { listing: { description: "A map of everywhere I have been." }, type: "listing" },
    ]);
    // What the draft holds now, as the model should describe it.
    expect(output.listing).toEqual({ description: "A map of everywhere I have been.", tags: ["maps"] });
    expect(String(output.note)).toMatch(/Save publishes it/);
    expect(String(output.note)).toMatch(/unsaved/);
  });

  it("normalizes tags, category and the FrameOS version the way the store does", async () => {
    const ctx = context();
    const output = await call(
      { category: "art", frameos_version: "2026.7.5", tags: ["Maps", "maps", "travel"] },
      ctx,
    );
    expect(output.ok).toBe(true);
    expect(ctx.events[0]!.listing).toEqual({
      category: "art",
      frameosVersion: "2026.7.5",
      tags: ["maps", "travel"],
    });
  });

  it("bounces bad tags, categories and versions back without delivering", async () => {
    const ctx = context();
    expect((await call({ tags: ["not a tag"] }, ctx)).error).toBe("invalid_tags");
    expect((await call({ category: "nonsense" }, ctx)).error).toBe("invalid_category");
    expect((await call({ frameos_version: "not a version!" }, ctx)).error).toBe("invalid_frameos_version");
    expect((await call({}, ctx)).error).toMatch(/nothing_to_update/);
    expect(ctx.events).toEqual([]);
  });

  it("refuses when there is no editor to hold the edit", async () => {
    const ctx = context({ emitListing: undefined });
    const output = await call({ description: "x" }, ctx);
    expect(output.ok).toBe(false);
    expect(String(output.error)).toMatch(/no scene editor/i);
  });

  it("never touches the database", async () => {
    const db = { select: vi.fn(), update: vi.fn() };
    const ctx = context({ db: db as unknown as ToolContext["db"] });
    await call({ description: "x" }, ctx);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });
});
