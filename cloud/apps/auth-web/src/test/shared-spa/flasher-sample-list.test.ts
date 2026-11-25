// The flasher's list of samples (cloud-frontend/src/flasher/sampleList.ts
// flasherSampleGroups): each row's picture and its store page.
import { describe, expect, it } from "vitest";
import type { FlasherSample } from "../../../../../../cloud-frontend/src/flasher/sampleCatalog";
import {
  flasherSampleGroups,
  withGroupPicked,
  type StoreCover,
} from "../../../../../../cloud-frontend/src/flasher/sampleList";

function rows(...args: Parameters<typeof flasherSampleGroups>) {
  return flasherSampleGroups(...args).flatMap((group) => group.rows);
}

function sample(name: string, overrides: Partial<FlasherSample> = {}): FlasherSample {
  return {
    name,
    title: name,
    description: "",
    category: "Notes & tools",
    needs: [],
    bytes: 1024,
    scenes: 1,
    file: `${name.toLowerCase().replace(/\W+/g, "-")}.json`,
    thumb: `${name.toLowerCase().replace(/\W+/g, "-")}.jpg`,
    store: false,
    ...overrides,
  };
}

const cover = (slug: string): StoreCover => ({
  image: `https://flash.frameos.net/api/store/scenes/${slug}/image`,
  url: `https://scenes.frameos.net/s/${slug}`,
});

describe("the flasher's list of samples", () => {
  it("finds a sample's store page by what the scene is called, not its folder", () => {
    const [row] = rows([sample("Books", { title: "ePub reader" })], [], { "epub reader": cover("books") }, "");
    expect(row?.cover).toEqual(cover("books"));
  });

  it("shows the sample's own picture, the store's cover only when it has none", () => {
    const covers = { clock: cover("clock") };
    const list = rows(
      [sample("Clock"), sample("Counter"), sample("Clock face", { thumb: null })],
      [],
      { ...covers, "clock face": cover("clock-face") },
      "",
    );
    const pictures = Object.fromEntries(list.map((row) => [row.sample.name, row.picture]));
    expect(pictures).toEqual({
      Clock: "/frames-app/flasher-scenes/clock.jpg",
      // Not on the store: its own picture all the same, and no store page.
      Counter: "/frames-app/flasher-scenes/counter.jpg",
      "Clock face": cover("clock-face").image,
    });
    expect(list.find((row) => row.sample.name === "Counter")?.cover).toBeNull();
  });

  it("ticks a category's box when every scene in it is picked, half when some are", () => {
    const samples = [
      sample("Clock", { category: "Clocks & time" }),
      sample("World clock", { category: "Clocks & time" }),
      sample("Counter"),
      sample("Notes"),
      sample("Photos", { category: "Photos" }),
    ];
    const groups = Object.fromEntries(
      flasherSampleGroups(samples, ["Clock", "World clock", "Counter"], {}, "").map((group) => [
        group.category,
        { pickable: group.pickable, picked: group.picked },
      ]),
    );
    expect(groups).toEqual({
      "Clocks & time": { pickable: ["Clock", "World clock"], picked: "all" },
      "Notes & tools": { pickable: ["Counter", "Notes"], picked: "some" },
      Photos: { pickable: ["Photos"], picked: "none" },
    });
  });

  it("leaves the Scene store out of its category's box: it is always in", () => {
    const [group] = flasherSampleGroups(
      [sample("Scene store", { store: true, category: "Store" }), sample("Files", { category: "Store" })],
      [],
      {},
      "",
    );
    expect(group?.pickable).toEqual(["Files"]);
    expect(group?.picked).toBe("none");
    const [alone] = flasherSampleGroups([sample("Scene store", { store: true })], [], {}, "");
    expect(alone?.pickable).toEqual([]);
    expect(alone?.picked).toBe("all");
  });

  it("ticks only the scenes a search shows", () => {
    const [group] = flasherSampleGroups([sample("Counter"), sample("Notes")], [], {}, "counter");
    expect(group?.pickable).toEqual(["Counter"]);
  });

  it("adds a category's scenes once, keeping the order, and takes them all out", () => {
    expect(withGroupPicked(["Clock", "Notes"], ["Notes", "Counter"], true)).toEqual(["Clock", "Notes", "Counter"]);
    expect(withGroupPicked(["Clock", "Notes", "Counter"], ["Notes", "Counter"], false)).toEqual(["Clock"]);
  });

  it("finds a sample by its folder's name too", () => {
    const found = rows([sample("Books", { title: "ePub reader" }), sample("Clock")], [], {}, "books");
    expect(found.map((row) => row.sample.title)).toEqual(["ePub reader"]);
  });
});
