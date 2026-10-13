import { describe, expect, it } from "vitest";
import {
  isPhotoPathInside,
  parentPhotoPath,
  photoAlbumOf,
  photoNameProblem,
  sortPhotoEntries,
} from "../../../../../../frontend/src/scenes/photos/photoPaths";
import { shareUrlForFrame, type PhotoEntry } from "../../../../../../frontend/src/scenes/photos/photosApi";
import {
  PHOTO_ALBUM_APP_ORIGIN,
  buildPhotoAlbumScene,
} from "../../../../../../frontend/src/scenes/photos/photoAlbumScene";

// The SPA side of docs/photos.md: the path rules the dialogs enforce before
// asking the server, the share link a frame is given, and the scene that
// plays it.

function entry(name: string, kind: PhotoEntry["kind"]): PhotoEntry {
  return {
    path: name,
    name,
    kind,
    size: 0,
    mtime: 0,
    content_type: null,
    width: null,
    height: null,
  };
}

describe("photo paths", () => {
  it("refuses the names the contract refuses", () => {
    expect(photoNameProblem("Summer 2026")).toBeNull();
    expect(photoNameProblem("")).not.toBeNull();
    expect(photoNameProblem("  ")).not.toBeNull();
    expect(photoNameProblem(".hidden")).not.toBeNull();
    expect(photoNameProblem("..")).not.toBeNull();
    expect(photoNameProblem("a/b")).not.toBeNull();
    expect(photoNameProblem("a\\b")).not.toBeNull();
    expect(photoNameProblem("tab\there")).not.toBeNull();
    expect(photoNameProblem("x".repeat(256))).not.toBeNull();
    // 255 bytes is the limit in UTF-8, not 255 characters.
    expect(photoNameProblem("é".repeat(128))).not.toBeNull();
  });

  it("knows what is inside what", () => {
    expect(isPhotoPathInside("Summer/beach.jpg", "Summer")).toBe(true);
    expect(isPhotoPathInside("Summer", "Summer")).toBe(true);
    expect(isPhotoPathInside("Summer 2026/a.jpg", "Summer")).toBe(false);
    expect(isPhotoPathInside("anything", "")).toBe(true);
    expect(parentPhotoPath("Summer/beach/a.jpg")).toBe("Summer/beach");
    expect(parentPhotoPath("a.jpg")).toBe("");
    expect(photoAlbumOf("Summer/beach/a.jpg")).toBe("Summer");
  });

  it("sorts folders first and numbers naturally", () => {
    const sorted = sortPhotoEntries([
      entry("img10.jpg", "file"),
      entry("img2.jpg", "file"),
      entry("Zoo", "folder"),
      entry("album", "folder"),
    ]);
    expect(sorted.map((item) => item.name)).toEqual(["album", "Zoo", "img2.jpg", "img10.jpg"]);
  });
});

describe("shareUrlForFrame", () => {
  const share = { token: "pk_x", path: "Summer", url: "/api/photos/shared/pk_x", created_at: 0 };

  it("passes an absolute cloud link through", () => {
    const cloud = { ...share, url: "https://cloud.frameos.net/api/photos/shared/pk_x" };
    expect(shareUrlForFrame(cloud, { server_host: "" })).toBe(cloud.url);
  });

  it("puts the address the frame uses for the backend in front of a backend path", () => {
    expect(shareUrlForFrame(share, { server_host: "10.0.0.5", server_port: 8989 })).toBe(
      "http://10.0.0.5:8989/api/photos/shared/pk_x",
    );
    expect(
      shareUrlForFrame(share, { server_host: "frames.example.com", server_port: 443, server_scheme: "https" }),
    ).toBe("https://frames.example.com:443/api/photos/shared/pk_x");
    expect(shareUrlForFrame(share, { server_host: "fd00::5", server_port: 8989 })).toBe(
      "http://[fd00::5]:8989/api/photos/shared/pk_x",
    );
  });

  it("has nothing to offer a frame that does not know the backend", () => {
    expect(shareUrlForFrame(share, { server_host: "" })).toBeNull();
    expect(shareUrlForFrame(share, {})).toBeNull();
  });
});

describe("buildPhotoAlbumScene", () => {
  const scene = buildPhotoAlbumScene({
    name: "Summer",
    albumUrl: "http://10.0.0.5:8989/api/photos/shared/pk_x",
    seconds: 600,
    order: "newest",
    fit: "contain",
  });
  type TestNode = { id: string; type: string; data: { keyword?: string; config?: unknown; cache?: unknown } };
  type TestEdge = { source: string; sourceHandle: string; target: string; targetHandle: string };
  const nodes = scene.nodes as unknown as TestNode[];
  const edges = scene.edges as unknown as TestEdge[];
  const nodeId = (predicate: (node: TestNode) => boolean): string => nodes.find(predicate)?.id ?? "";

  it("embeds the photoAlbum app with its sources", () => {
    const app = scene.apps?.photoAlbum;
    expect(app?.origin).toBe(PHOTO_ALBUM_APP_ORIGIN);
    expect(app?.sources?.["app.ts"]).toContain("export function get");
    expect(scene.settings?.execution).toBe("interpreted");
    expect(scene.settings?.refreshInterval).toBe(600);
  });

  it("keeps the link in the node config and the position in a disk-persisted field", () => {
    const albumNode = nodes.find((node) => node.data?.keyword === "photoAlbum");
    expect(albumNode?.data.config).toEqual({
      album: "http://10.0.0.5:8989/api/photos/shared/pk_x",
      counterStateKey: "photoIndex",
    });
    expect(albumNode?.data.cache).toEqual({ enabled: false });
    const position = scene.fields?.find((field) => field.name === "photoIndex");
    expect(position).toMatchObject({ type: "integer", persist: "disk", access: "private" });
    const seconds = scene.fields?.find((field) => field.name === "seconds");
    expect(seconds).toMatchObject({ role: "refreshInterval", value: "600" });
    expect(scene.fields?.find((field) => field.name === "order")?.value).toBe("newest");
    expect(scene.fields?.find((field) => field.name === "fit")?.value).toBe("contain");
  });

  it("wires render → image ← album, the order into the app and the fit into the placement", () => {
    const render = nodeId((node) => node.type === "event" && node.data.keyword === "render");
    const image = nodeId((node) => node.data?.keyword === "render/image");
    const album = nodeId((node) => node.data?.keyword === "photoAlbum");
    const order = nodeId((node) => node.type === "state" && node.data.keyword === "order");
    const fit = nodeId((node) => node.type === "state" && node.data.keyword === "fit");
    const has = (source: string, sourceHandle: string, target: string, targetHandle: string): boolean =>
      edges.some(
        (edge) =>
          edge.source === source &&
          edge.sourceHandle === sourceHandle &&
          edge.target === target &&
          edge.targetHandle === targetHandle,
      );
    expect(has(render, "next", image, "prev")).toBe(true);
    expect(has(album, "fieldOutput", image, "fieldInput/image")).toBe(true);
    expect(has(order, "fieldOutput", album, "fieldInput/order")).toBe(true);
    expect(has(fit, "fieldOutput", image, "fieldInput/placement")).toBe(true);
  });

  it("gives every scene its own ids", () => {
    const other = buildPhotoAlbumScene({
      name: "Summer",
      albumUrl: "http://10.0.0.5:8989/api/photos/shared/pk_x",
      seconds: 600,
      order: "random",
      fit: "cover",
    });
    expect(other.id).not.toBe(scene.id);
    expect((other.nodes as unknown as TestNode[])[0]?.id).not.toBe(nodes[0]?.id);
  });
});
