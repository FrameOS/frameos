import { describe, expect, it } from "vitest";
import { cloudFramesContract } from "./cloud-frames-contract.gen";
import {
  assetStoragePayload,
  commandAssetStorage,
  defaultAssetStorage,
  defaultAssetStorages,
  knownAssetStorageIds,
  parseAssetStorageId,
  parseAssetStorages,
  resolveAssetStorage,
} from "./frame-asset-storages";

// docs/cloud-frames.md "Asset storages": the optional `storage` of the asset
// verbs. What the routes accept, what a device's listing may say, and the
// rule that keeps a frame that does not know the field from writing to its
// assets folder what was meant for somewhere else.

// The newest frame_assets row's `storages`, as frameAssetStorages reads it.
function fakeDb(storages: unknown) {
  const rows = storages === undefined ? [] : [{ storages }];
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: () => Promise.resolve(rows) }),
        }),
      }),
    }),
  } as never;
}

describe("the contract's storages", () => {
  it("are the assets folder by default and an ESP32's internal storage", () => {
    expect(defaultAssetStorage).toBe("assets");
    expect(knownAssetStorageIds).toEqual(["assets", "internal"]);
    expect(cloudFramesContract.assetStorages.ids.internal.profiles).toEqual(["esp32"]);
    expect(defaultAssetStorages).toEqual([{ id: "assets", name: "Internal storage" }]);
    expect(cloudFramesContract.errors.asset_storage).toContain("storage_unavailable");
  });

  it("covers every asset verb", () => {
    expect([...cloudFramesContract.assetStorages.verbs].sort()).toEqual([
      "asset_delete",
      "asset_get",
      "asset_mkdir",
      "asset_put",
      "asset_put_chunk",
      "asset_rename",
      "assets_list",
    ]);
  });
});

describe("the wire field", () => {
  it("is never sent for the default", () => {
    expect(assetStoragePayload("assets")).toEqual({});
    expect(assetStoragePayload("internal")).toEqual({ storage: "internal" });
  });

  it("reads a command's storage, absent meaning the default", () => {
    expect(commandAssetStorage({ path: "a.png" })).toBe("assets");
    expect(commandAssetStorage({ path: "a.png", storage: "internal" })).toBe("internal");
    expect(commandAssetStorage(null)).toBe("assets");
    expect(commandAssetStorage({ storage: "../etc" })).toBe("assets");
  });
});

describe("a device's storages", () => {
  it("keeps the ids and names a device sent", () => {
    expect(
      parseAssetStorages([
        { id: "assets", name: "TF card" },
        { id: "internal", name: "Internal storage" },
      ]),
    ).toEqual([
      { id: "assets", name: "TF card" },
      { id: "internal", name: "Internal storage" },
    ]);
    // No card: internal alone.
    expect(parseAssetStorages([{ id: "internal", name: "Internal storage" }])).toEqual([
      { id: "internal", name: "Internal storage" },
    ]);
  });

  it("is nothing when the device said nothing (older firmware, Linux)", () => {
    expect(parseAssetStorages(undefined)).toBeNull();
    expect(parseAssetStorages("internal")).toBeNull();
    expect(parseAssetStorages([])).toBeNull();
  });

  it("drops what is not an id, repeats, control characters and excess", () => {
    expect(
      parseAssetStorages([
        { id: "Bad Id", name: "x" },
        { id: "internal", name: "Flash\n<b>" },
        { id: "internal", name: "again" },
        { id: "assets" },
        "assets",
        null,
      ]),
    ).toEqual([
      { id: "internal", name: "Flash <b>" },
      { id: "assets", name: "assets" },
    ]);
    const many = Array.from({ length: 20 }, (_, index) => ({ id: `s${index}`, name: "x".repeat(200) }));
    const parsed = parseAssetStorages(many)!;
    expect(parsed).toHaveLength(8);
    expect(parsed[0]!.name).toHaveLength(64);
  });

  it("reads an echoed id only in the id alphabet", () => {
    expect(parseAssetStorageId("internal")).toBe("internal");
    expect(parseAssetStorageId("INTERNAL")).toBeUndefined();
    expect(parseAssetStorageId(3)).toBeUndefined();
  });
});

describe("the storage a route is asked for", () => {
  const both = [
    { id: "assets", name: "TF card" },
    { id: "internal", name: "Internal storage" },
  ];

  it("is the default when absent, without reading anything", async () => {
    const db = {
      select: () => {
        throw new Error("no read for the default");
      },
    } as never;
    expect(await resolveAssetStorage(db, "f", null)).toEqual({ ok: true, storage: "assets" });
    expect(await resolveAssetStorage(db, "f", "")).toEqual({ ok: true, storage: "assets" });
    expect(await resolveAssetStorage(db, "f", "assets")).toEqual({ ok: true, storage: "assets" });
  });

  it("refuses an id the contract does not know", async () => {
    expect(await resolveAssetStorage(fakeDb(both), "f", "sdcard")).toEqual({
      error: "invalid_storage",
      ok: false,
      status: 400,
    });
    expect(await resolveAssetStorage(fakeDb(both), "f", "../internal")).toMatchObject({
      error: "invalid_storage",
    });
  });

  it("names internal only for a frame whose newest listing reported it", async () => {
    expect(await resolveAssetStorage(fakeDb(both), "f", "internal")).toEqual({
      ok: true,
      storage: "internal",
    });
    // Never listed, a listing without storages (a Linux frame, older
    // firmware), or one that stopped reporting it: a frame that does not
    // know the field would act on its assets folder instead.
    for (const storages of [undefined, null, [{ id: "assets", name: "TF card" }]]) {
      expect(await resolveAssetStorage(fakeDb(storages), "f", "internal")).toEqual({
        error: "storage_unavailable",
        ok: false,
        status: 400,
      });
    }
  });
});
