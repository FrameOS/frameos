// The flasher's list of samples (cloud-frontend/src/flasher/sampleList.ts
// flasherSampleGroups): each row's picture and its store page.
import { describe, expect, it } from "vitest";
import type { FlasherSample } from "../../../../../../cloud-frontend/src/flasher/sampleCatalog";
import { flasherSampleGroups, type StoreCover } from "../../../../../../cloud-frontend/src/flasher/sampleList";

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

  it("finds a sample by its folder's name too", () => {
    const found = rows([sample("Books", { title: "ePub reader" }), sample("Clock")], [], {}, "books");
    expect(found.map((row) => row.sample.title)).toEqual(["ePub reader"]);
  });
});
