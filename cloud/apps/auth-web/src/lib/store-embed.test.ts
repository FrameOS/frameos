// The store's embed mode (`/s/<slug>?embed=1`, framed by frameos.net): what a
// scene page's query asks of it, and that nothing else is taken from it.
import { describe, expect, it } from "vitest";
import { storeEmbedAncestors, storeEmbedFor } from "./store-embed";

describe("storeEmbedFor", () => {
  it("is a normal page without embed=1", () => {
    expect(storeEmbedFor({})).toBeNull();
    expect(storeEmbedFor({ embed: "true", file: "app.tsx" })).toBeNull();
    expect(storeEmbedFor({ embed: ["1", "1"] })).toBeNull();
  });

  it("takes a plain file name, a known device and a board's key", () => {
    expect(
      storeEmbedFor({ device: "sensecap-indicator", embed: "1", file: "app.tsx", memory: "esp32" }),
    ).toEqual({ device: "sensecap-indicator", file: "app.tsx", memory: "esp32" });
    expect(storeEmbedFor({ embed: "1" })).toEqual({});
  });

  it("drops what is not one, rather than echo it into the page", () => {
    expect(
      storeEmbedFor({
        device: "toaster",
        embed: "1",
        file: "../secrets/app.tsx",
        memory: "esp32<script>",
      }),
    ).toEqual({});
    expect(storeEmbedFor({ embed: "1", file: ".env" })).toEqual({});
    expect(storeEmbedFor({ embed: "1", file: ["app.tsx", "app.ts"] })).toEqual({});
  });

  it("is framed by frameos.net alone, over https", () => {
    expect(storeEmbedAncestors).toEqual(["https://frameos.net", "https://www.frameos.net"]);
  });
});
