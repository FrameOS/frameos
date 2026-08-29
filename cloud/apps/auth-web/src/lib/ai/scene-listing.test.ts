import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool, toolDefinitions, type ToolContext } from "./tools";
import type { JsonObject } from "./scene-utils";

const moderate = vi.hoisted(() =>
  vi.fn(async () => ({ checked: true, ok: true }) as never),
);
vi.mock("../moderation", () => ({ moderateStoreContent: moderate }));

const audit = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../audit", () => ({ recordAuditEvent: audit }));

const sceneId = "11111111-2222-3333-4444-555555555555";
const owner = "acct-1";

type Row = Record<string, unknown> | undefined;

// The two drizzle chains the tool walks: one ownership select, one update.
function fakeDb(row: Row) {
  const set = vi.fn();
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (row ? [row] : []) }) }),
    }),
    update: () => ({
      set: (changes: Record<string, unknown>) => {
        set(changes);
        return {
          where: () => ({ returning: async () => [{ ...row, ...changes }] }),
        };
      },
    }),
  };
  return { db: db as unknown as ToolContext["db"], set };
}

function context(row: Row): ToolContext & { set: ReturnType<typeof vi.fn> } {
  const { db, set } = fakeDb(row);
  return {
    accountId: owner,
    db,
    emitScenes: () => undefined,
    prompt: "update the description",
    set,
    storeSceneId: sceneId,
  } as unknown as ToolContext & { set: ReturnType<typeof vi.fn> };
}

const listing = {
  accountId: owner,
  category: "art",
  description: "The old blurb",
  id: sceneId,
  name: "Visited world map",
  tags: ["maps"],
};

async function call(args: JsonObject, ctx: ToolContext): Promise<JsonObject> {
  return JSON.parse(await executeTool("update_scene_listing", args, ctx)) as JsonObject;
}

describe("update_scene_listing", () => {
  beforeEach(() => {
    audit.mockClear();
    moderate.mockClear();
    moderate.mockResolvedValue({ checked: true, ok: true } as never);
  });

  it("is registered with a label and an object schema", () => {
    const definition = toolDefinitions.find(
      (tool) => tool.name === "update_scene_listing",
    );
    expect(definition).toBeDefined();
    const parameters = definition!.parameters as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(parameters.required ?? []).toEqual([]);
    expect(Object.keys(parameters.properties).sort()).toEqual([
      "category",
      "description",
      "scene_id",
      "tags",
    ]);
  });

  it("writes the description of the scene the user has open, and says it is already saved", async () => {
    const ctx = context(listing);
    const output = await call({ description: "A map of everywhere I have been." }, ctx);
    expect(output.ok).toBe(true);
    expect(ctx.set).toHaveBeenCalledWith(
      expect.objectContaining({ description: "A map of everywhere I have been." }),
    );
    // Only what was named: tags and category are untouched.
    expect(Object.keys(ctx.set.mock.calls[0]![0] as object).sort()).toEqual([
      "description",
      "updatedAt",
    ]);
    expect(String(output.note)).toMatch(/does not need to press Save/);
    expect((output.listing as JsonObject).description).toBe(
      "A map of everywhere I have been.",
    );
    // Nobody pressed a button, so the edit leaves a trail.
    expect(audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "store.listing_edited",
        metadata: expect.objectContaining({ fields: ["description"], via: "ai_chat" }),
      }),
    );
  });

  it("refuses a scene the user does not own, and says not to edit the scene instead", async () => {
    const output = await call({ description: "mine now" }, context(undefined));
    expect(output.ok).toBe(false);
    expect(String(output.error)).toMatch(/not in the user's account/);
    expect(String(output.error)).toMatch(/do not edit the scene's contents/i);
  });

  it("needs a scene and something to change", async () => {
    const ctx = context(listing);
    expect((await call({}, ctx)).error).toMatch(/nothing_to_update/);
    expect(ctx.set).not.toHaveBeenCalled();

    const loose = context(listing);
    (loose as { storeSceneId?: string | null }).storeSceneId = null;
    expect(String((await call({ description: "x" }, loose)).error)).toMatch(
      /search_store_scenes/,
    );

    expect(
      String((await call({ description: "x", scene_id: "nope" }, ctx)).error),
    ).toMatch(/uuid/);
  });

  it("bounces bad tags and categories back before touching the row", async () => {
    const ctx = context(listing);
    expect((await call({ tags: ["not a tag"] }, ctx)).error).toBe("invalid_tags");
    expect((await call({ category: "nonsense" }, ctx)).error).toBe(
      "invalid_category",
    );
    expect(ctx.set).not.toHaveBeenCalled();
  });

  it("passes the store's moderation refusal back instead of writing", async () => {
    moderate.mockResolvedValue({
      categories: ["hate"],
      error: "content_rejected",
      ok: false,
    } as never);
    const ctx = context(listing);
    const output = await call({ description: "something vile" }, ctx);
    expect(output.ok).toBe(false);
    expect(String(output.error)).toMatch(/moderation refused/i);
    expect(String(output.error)).toMatch(/hate/);
    expect(ctx.set).not.toHaveBeenCalled();
  });
});
