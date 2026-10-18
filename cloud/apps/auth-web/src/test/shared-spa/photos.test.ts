// @vitest-environment jsdom
//
// jsdom for the library's own screens at the end (the location pin, the
// viewer's Info panel, the selection bar's removals); the rest is pure.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Fragment, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// apiFetch resolves a project id over the network in backend mode and
// answers everything with a synthetic 404 under the no-backend flag; routing
// the calls here keeps the harness offline and lets the test answer by path.
const fetchMock = vi.hoisted(() => vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>());
vi.mock("../../../../../../frontend/src/utils/apiFetch", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, apiFetch: (input: RequestInfo | URL, init?: RequestInit) => fetchMock(input, init) };
});

import { buildPhotoAlbumScene as buildCloudPhotoAlbumScene } from "../../lib/photos/album-scene";
import {
  isPhotoPathInside,
  joinPhotoPath,
  parentPhotoPath,
  photoAlbumOf,
  photoNameProblem,
  sortPhotoEntries,
} from "../../../../../../frontend/src/scenes/photos/photoPaths";
import {
  shareUrlForFrame,
  type PhotoEntry,
  type PhotoMetadata,
} from "../../../../../../frontend/src/scenes/photos/photosApi";
import {
  canHoldMetadata,
  formatMetadataValue,
  metadataBlocksSentence,
  metadataGroups,
  metadataHasRemovable,
  metadataRemovalNotice,
  openStreetMapUrl,
} from "../../../../../../frontend/src/scenes/photos/photoMetadata";
import { Lightbox, PhotosBrowser } from "../../../../../../frontend/src/scenes/photos/PhotosWorkspace";
import { photosLogic } from "../../../../../../frontend/src/scenes/photos/photosLogic";
import { photoColorsLogic } from "../../../../../../frontend/src/scenes/photos/photoColorsLogic";
import { photoInfoLogic } from "../../../../../../frontend/src/scenes/photos/photoInfoLogic";
import { initKea } from "../../../../../../frontend/src/initKea";
import {
  aspectMarkRect,
  entriesByOrientation,
  withUploadedPhoto,
} from "../../../../../../frontend/src/scenes/photos/photoEntries";
import {
  PHOTO_ALBUM_APP_ORIGIN,
  buildPhotoAlbumScene,
} from "../../../../../../frontend/src/scenes/photos/photoAlbumScene";
import {
  FULL_FIDELITY_MAX_SIDE,
  photoColorsOfProfile,
  photoPreviewTargets,
  previewSizeFor,
  profileOfPhotoColors,
  rotatedPreviewTarget,
  previewTargetAtSize,
} from "../../../../../../frontend/src/scenes/photos/photoColors";
import { defaultAssetColorProfile } from "../../../../../../frontend/src/utils/assetColors/profile";
import type { FrameType } from "../../../../../../frontend/src/types";

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
    // Kept for color profiles (docs/photos.md, "Paths").
    expect(photoNameProblem("a.jpg.frameos.json")).not.toBeNull();
    expect(photoNameProblem("A.FrameOS.JSON")).not.toBeNull();
    expect(photoNameProblem("frameos.json")).toBeNull();
    // 255 bytes is the limit in UTF-8, not 255 characters.
    expect(photoNameProblem("é".repeat(128))).not.toBeNull();
  });

  it("joins paths with the root on either side", () => {
    expect(joinPhotoPath("Summer", "beach.jpg")).toBe("Summer/beach.jpg");
    expect(joinPhotoPath("", "beach.jpg")).toBe("beach.jpg");
    // A file dropped into an album sat in "" (no folder of its own): the
    // target is the album, never "Summer/", which the server refuses.
    expect(joinPhotoPath("Summer", "")).toBe("Summer");
    expect(joinPhotoPath("", "")).toBe("");
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

describe("withUploadedPhoto", () => {
  const album = (): PhotoEntry => ({ ...entry("Trip", "folder"), cover: null, files: 0, items: 1, size: 0 });
  const sub = (): PhotoEntry => ({ ...entry("Trip/Day 1", "folder"), cover: null, files: 0, items: 0, size: 0 });
  const photo = (path: string, size = 10): PhotoEntry => ({
    ...entry(path, "file"),
    name: path.split("/").pop() ?? path,
    size,
    width: 40,
    height: 30,
  });

  it("adds the photo to its folder and makes it the cover of every folder above", () => {
    const listings = { "": [album()], Trip: [sub()], "Trip/Day 1": [] };
    const after = withUploadedPhoto(listings, photo("Trip/Day 1/a.jpg"));
    expect(after["Trip/Day 1"].map((item) => item.path)).toEqual(["Trip/Day 1/a.jpg"]);
    expect(after.Trip[0]).toMatchObject({ cover: "Trip/Day 1/a.jpg", files: 1, items: 1, size: 10 });
    expect(after[""][0]).toMatchObject({ cover: "Trip/Day 1/a.jpg", files: 1, items: 1, size: 10 });
    // The next photo moves the cover along.
    const later = withUploadedPhoto(after, photo("Trip/Day 1/b.jpg", 5));
    expect(later[""][0]).toMatchObject({ cover: "Trip/Day 1/b.jpg", files: 2, items: 1, size: 15 });
    expect(later["Trip/Day 1"].map((item) => item.path)).toEqual(["Trip/Day 1/a.jpg", "Trip/Day 1/b.jpg"]);
  });

  it("leaves listings it has not loaded alone, and does not count a replaced file twice", () => {
    const listings = { "": [album()] };
    const after = withUploadedPhoto(listings, photo("Trip/a.jpg"));
    expect(Object.keys(after)).toEqual([""]);
    expect(after[""][0]).toMatchObject({ cover: "Trip/a.jpg", files: 1, items: 2 });
    const replaced = withUploadedPhoto({ ...after, Trip: [photo("Trip/a.jpg")] }, photo("Trip/a.jpg"));
    expect(replaced[""][0]).toMatchObject({ files: 1, items: 2 });
    // A file a frame cannot play is counted but is no cover.
    const text = withUploadedPhoto(listings, { ...photo("Trip/notes.txt"), content_type: "text/plain" });
    expect(text[""][0]).toMatchObject({ cover: null, files: 1 });
  });
});

describe("entriesByOrientation", () => {
  it("picks the taller or the wider photos, never squares, folders or unknown sizes", () => {
    const tall = { ...entry("tall.jpg", "file"), width: 30, height: 40 };
    const wide = { ...entry("wide.jpg", "file"), width: 40, height: 30 };
    const square = { ...entry("square.jpg", "file"), width: 30, height: 30 };
    const unknown = entry("unknown.jpg", "file");
    const folder = { ...entry("Album", "folder"), width: 30, height: 40 };
    const all = [folder, tall, wide, square, unknown];
    expect(entriesByOrientation(all, "portrait").map((item) => item.path)).toEqual(["tall.jpg"]);
    expect(entriesByOrientation(all, "landscape").map((item) => item.path)).toEqual(["wide.jpg"]);
  });
});

describe("aspectMarkRect", () => {
  it("fits the photo's shape into the box, centred, never thinner than two pixels", () => {
    expect(aspectMarkRect(1200, 1600, 16)).toEqual({ x: 2, y: 0, width: 12, height: 16 });
    expect(aspectMarkRect(1600, 1200, 16)).toEqual({ x: 0, y: 2, width: 16, height: 12 });
    expect(aspectMarkRect(100, 100, 16)).toEqual({ x: 0, y: 0, width: 16, height: 16 });
    expect(aspectMarkRect(4000, 100, 16)).toEqual({ x: 0, y: 7, width: 16, height: 2 });
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
    expect(scene.fields?.find((field) => field.name === "order")?.options).toContainEqual({
      value: "random",
      label: "Shuffle",
    });
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

  it("shows one photo alone when asked, by its path inside the album", () => {
    const single = buildPhotoAlbumScene({
      name: "beach.jpg",
      albumUrl: "http://10.0.0.5:8989/api/photos/shared/pk_x",
      seconds: 600,
      order: "random",
      fit: "cover",
      photo: "trip/beach.jpg",
    });
    const album = (single.nodes as unknown as TestNode[]).find((node) => node.data.keyword === "photoAlbum")!;
    expect(album.data.config).toEqual({
      album: "http://10.0.0.5:8989/api/photos/shared/pk_x",
      photo: "trip/beach.jpg",
    });
    // Nothing to shuffle through and no interval to pick: only the fit stays.
    expect((single.fields as { name: string }[]).map((field) => field.name)).toEqual(["fit"]);
    expect((single.nodes as unknown as TestNode[]).map((node) => node.data.keyword)).toEqual([
      "render",
      "render/image",
      "photoAlbum",
      "fit",
    ]);
    expect(single.settings.refreshInterval).toBe(600);
    // Without a photo the config is as before: the fixture pins that shape.
    const album2 = (scene.nodes as unknown as TestNode[]).find((node) => node.data.keyword === "photoAlbum")!;
    expect("photo" in (album2.data.config as object)).toBe(false);
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

describe("photo colors", () => {
  it("stores the sidecar's colors object, and nothing for neutral sliders", () => {
    expect(photoColorsOfProfile(defaultAssetColorProfile())).toBeNull();
    const profile = { ...defaultAssetColorProfile(), whites: -30, saturation: 20 };
    const colors = photoColorsOfProfile(profile);
    expect(colors).toEqual({ whites: -30, saturation: 20 });
    expect(profileOfPhotoColors(colors)).toEqual(profile);
    expect(profileOfPhotoColors(null)).toBeNull();
    // A palette alone is still a profile: it changes the dither.
    expect(photoColorsOfProfile({ ...defaultAssetColorProfile(), palette: [[0, 0, 0], [255, 255, 255]] })).toEqual({
      palette: ["#000000", "#ffffff"],
    });
  });

  it("previews on full fidelity, each frame as its panel, and the panel families", () => {
    const spectra = {
      id: 7,
      name: "Kitchen",
      device: "waveshare.EPD_7in3e",
      width: 800,
      height: 480,
      rotate: 90,
      colors: { autoFit: "default", global: { whites: -10 } },
    } as unknown as FrameType;
    const plain = { id: 8, name: "Hall", device: "web_only", width: 1920, height: 1080, rotate: 0 } as unknown as FrameType;
    const archived = { ...plain, id: 9, archived: true } as unknown as FrameType;

    const targets = photoPreviewTargets([spectra, plain, archived]);

    expect(targets[0]?.key).toBe("original");
    const kitchen = targets.find((target) => target.key === "frame:7");
    expect(kitchen).toMatchObject({ label: "Kitchen", group: "frames", width: 480, height: 800, autoFit: true });
    expect(kitchen?.palette).toHaveLength(7); // Spectra 6, the placeholder kept
    expect(kitchen?.global?.whites).toBe(-10);
    const hall = targets.find((target) => target.key === "frame:8");
    expect(hall).toMatchObject({ palette: null, autoFit: false, global: null });
    expect(targets.some((target) => target.key === "frame:9")).toBe(false);
    const panels = targets.filter((target) => target.group === "panels");
    expect(panels.map((target) => target.key)).toContain("panel:spectra6");
    expect(panels.every((target) => target.width === 800 && target.height === 480 && target.palette)).toBe(true);
  });

  it("paints full fidelity at the photo's size, capped", () => {
    const [original] = photoPreviewTargets([]);
    expect(previewSizeFor(original!, { width: 1200, height: 900 })).toEqual({ width: 1200, height: 900 });
    expect(previewSizeFor(original!, { width: 8000, height: 6000 })).toEqual({
      width: FULL_FIDELITY_MAX_SIDE,
      height: (FULL_FIDELITY_MAX_SIDE * 3) / 4,
    });
  });
});

// docs/photo-album-scene.json pins the SPA's builder, the cloud's (POST
// /api/photos/scene) and the backend's (test_photos.py) to one scene.
describe("rotatedPreviewTarget", () => {
  it("turns a panel on its side and leaves full fidelity alone", () => {
    const targets = photoPreviewTargets([]);
    const panel = targets.find((target) => target.group === "panels")!;
    const rotated = rotatedPreviewTarget(panel);
    expect([rotated.width, rotated.height]).toEqual([panel.height, panel.width]);
    expect(rotated.key).toBe(panel.key);
    expect(previewSizeFor(rotated, { width: 4000, height: 3000 })).toEqual({ width: 480, height: 800 });
    expect(rotatedPreviewTarget(targets[0])).toBe(targets[0]);
  });
});

describe("previewTargetAtSize", () => {
  const frames = [
    { id: 7, name: "Hall", width: 1200, height: 825, rotate: 90 },
    { id: 8, name: "Desk", width: 800, height: 480, rotate: 0 },
  ] as unknown as FrameType[];
  it("keeps the palette and takes the size from a frame, a preset, or the target itself", () => {
    const targets = photoPreviewTargets(frames);
    const panel = targets.find((target) => target.group === "panels")!;
    expect(previewTargetAtSize(panel, "target", frames)).toBe(panel);
    const fromFrame = previewTargetAtSize(panel, "frame:7", frames);
    expect([fromFrame.width, fromFrame.height, fromFrame.palette]).toEqual([825, 1200, panel.palette]);
    const preset = previewTargetAtSize(panel, "size:1920x1080", frames);
    expect([preset.width, preset.height, preset.key]).toEqual([1920, 1080, panel.key]);
    expect(previewTargetAtSize(panel, "frame:99", frames)).toBe(panel);
    expect(previewTargetAtSize(panel, "size:big", frames)).toBe(panel);
    expect(previewTargetAtSize(targets[0], "size:1920x1080", frames)).toBe(targets[0]);
  });
});

describe("the photo album scene fixture", () => {
  type Built = {
    apps?: Record<string, { origin?: string; sources?: Record<string, string> }>;
    edges: { source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null; type?: string }[];
    fields?: unknown;
    name: string;
    nodes: { data: Record<string, unknown>; id: string; position: unknown; type?: string }[];
    settings?: unknown;
  };

  const fixture = JSON.parse(
    // A path, not `new URL(…, import.meta.url)`: jsdom's URL is not one node:fs takes.
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../../../../docs/photo-album-scene.json"),
      "utf8",
    ),
  ) as {
    input: {
      albumUrl: string;
      fit: "cover" | "contain";
      name: string;
      order: "newest";
      seconds: number;
      shapes: ("landscape" | "portrait" | "square")[];
    };
    scene: unknown;
  };

  function normalized(scene: Built) {
    const refs = new Map(scene.nodes.map((node) => [node.id, `${node.type}:${String(node.data.keyword)}`]));
    const app = scene.apps?.photoAlbum ?? {};
    return {
      name: scene.name,
      settings: scene.settings,
      fields: scene.fields,
      nodes: scene.nodes.map((node) => ({
        ref: refs.get(node.id),
        type: node.type,
        data: node.data,
        position: node.position,
      })),
      edges: scene.edges.map((edge) => ({
        source: refs.get(edge.source),
        sourceHandle: edge.sourceHandle,
        target: refs.get(edge.target),
        targetHandle: edge.targetHandle,
        type: edge.type,
      })),
      apps: {
        photoAlbum: {
          origin: app.origin,
          keys: Object.keys(app).sort(),
          files: Object.keys(app.sources ?? {}).sort(),
        },
      },
    };
  }

  it("is what the SPA builds", () => {
    const scene = buildPhotoAlbumScene(fixture.input) as unknown as Built;
    expect(normalized(scene)).toEqual(fixture.scene);
  });

  it("plays every shape unless told otherwise", () => {
    const { shapes: _shapes, ...everyShape } = fixture.input;
    const scene = buildPhotoAlbumScene(everyShape) as unknown as Built;
    const fields = scene.fields as { name: string; value: string }[];
    expect(fields.filter((field) => ["landscape", "portrait", "square"].includes(field.name)).map((f) => f.value)).toEqual([
      "true",
      "true",
      "true",
    ]);
    const cloud = buildCloudPhotoAlbumScene(everyShape) as unknown as Built;
    expect(normalized(cloud)).toEqual(normalized(scene));
  });

  it("is what the cloud's scene route builds, with the same app", () => {
    const scene = buildCloudPhotoAlbumScene(fixture.input) as unknown as Built;
    expect(normalized(scene)).toEqual(fixture.scene);
    const spa = buildPhotoAlbumScene(fixture.input) as unknown as Built;
    expect(scene.apps?.photoAlbum?.sources).toEqual(spa.apps?.photoAlbum?.sources);
  });
});

// docs/photos.md "Metadata": the library says what a photo carries and
// removes it only when asked ("inform, don't punish").
describe("photo metadata in words", () => {
  const metadata = (overrides: Partial<PhotoMetadata> = {}): PhotoMetadata => ({
    location: null,
    fields: [],
    blocks: [],
    ...overrides,
  });

  it("formats values the way the panel lists them", () => {
    expect(formatMetadataValue("Apple")).toBe("Apple");
    expect(formatMetadataValue(4032)).toBe("4032");
    // A rational: 1/60 of a second.
    expect(formatMetadataValue(1 / 60)).toBe("0.0166667");
    expect(formatMetadataValue([59, 26, 13.06])).toBe("59, 26, 13.06");
    expect(formatMetadataValue(null)).toBe("unknown");
  });

  it("keeps the server's group order and names the raw GPS tags apart from the location", () => {
    const groups = metadataGroups([
      { group: "Image", name: "Make", value: "Apple" },
      { group: "Location", name: "GPSLatitude", value: [59, 26, 13.06] },
      { group: "Image", name: "Model", value: "iPhone 15 Pro" },
    ]);
    expect(groups.map((group) => [group.group, group.label, group.fields.length])).toEqual([
      ["Image", "Image", 2],
      ["Location", "GPS", 1],
    ]);
  });

  it("names the other blocks in one sentence, and EXIF or text only when no field shows them", () => {
    const exif = { group: "Image", name: "Make", value: "Apple" };
    expect(metadataBlocksSentence(metadata({ fields: [exif], blocks: ["exif"] }))).toBeNull();
    expect(metadataBlocksSentence(metadata({ fields: [exif], blocks: ["exif", "xmp"] }))).toBe(
      "This file also holds XMP data.",
    );
    expect(metadataBlocksSentence(metadata({ fields: [exif], blocks: ["exif", "trailer", "other"] }))).toBe(
      "This file also holds other embedded data and a video or second image after the photo, which can carry its own location.",
    );
    expect(metadataBlocksSentence(metadata({ blocks: ["exif", "comment"] }))).toBe(
      "This file holds EXIF data and a comment.",
    );
    const text = { group: "Text", name: "Software", value: "GIMP" };
    expect(metadataBlocksSentence(metadata({ fields: [text], blocks: ["text"] }))).toBeNull();
  });

  it("offers Remove all metadata only when there is more than the orientation it keeps", () => {
    const orientation = { group: "Image", name: "Orientation", value: 6 };
    expect(metadataHasRemovable(metadata({ fields: [orientation], blocks: ["exif"] }))).toBe(false);
    expect(metadataHasRemovable(metadata())).toBe(false);
    const make = { group: "Image", name: "Make", value: "Apple" };
    expect(metadataHasRemovable(metadata({ fields: [orientation, make] }))).toBe(true);
    expect(metadataHasRemovable(metadata({ blocks: ["exif", "xmp"] }))).toBe(true);
  });

  it("knows which files the server can change, links the map and counts the outcome", () => {
    expect(canHoldMetadata({ ...entry("a.jpg", "file"), content_type: "image/jpeg" })).toBe(true);
    expect(canHoldMetadata({ ...entry("a.webp", "file"), content_type: null })).toBe(true);
    expect(canHoldMetadata({ ...entry("a.gif", "file"), content_type: "image/gif" })).toBe(false);
    expect(canHoldMetadata({ ...entry("a.jpg", "file"), status: "blocked" })).toBe(false);
    expect(canHoldMetadata(entry("Album", "folder"))).toBe(false);
    expect(openStreetMapUrl({ latitude: -33.8567844, longitude: 151.213108 })).toBe(
      "https://www.openstreetmap.org/?mlat=-33.85678&mlon=151.21311#map=16/-33.85678/151.21311",
    );
    expect(metadataRemovalNotice("location", 3)).toBe("Removed the location from 3 photos.");
    expect(metadataRemovalNotice("all", 1)).toBe("Removed the metadata from 1 photo.");
    expect(metadataRemovalNotice("location", 0)).toBe("There was no location to remove.");
  });
});

describe("the library's location pin, Info panel and removals", () => {
  const tallinn = { latitude: 59.43696, longitude: 24.75353 };
  const photoMetadata: PhotoMetadata = {
    location: { ...tallinn, altitude: 31.5 },
    fields: [
      { group: "Image", name: "Make", value: "Apple" },
      { group: "Photo", name: "ExposureTime", value: 1 / 60 },
      { group: "Location", name: "GPSLatitude", value: [59, 26, 13.06] },
    ],
    blocks: ["exif", "xmp", "trailer"],
  };

  function libraryPhoto(name: string, extra: Partial<PhotoEntry> = {}): PhotoEntry {
    return {
      path: `Trip/${name}`,
      name,
      kind: "file",
      size: 1000,
      mtime: 1,
      content_type: "image/jpeg",
      width: 40,
      height: 30,
      status: "ready",
      colors: null,
      location: null,
      ...extra,
    };
  }

  let listing: PhotoEntry[];
  let metadataByPath: Record<string, PhotoMetadata>;

  function requestUrl(input: RequestInfo | URL): string {
    return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  }

  function metadataRequests(method: "GET" | "POST"): { url: string; body: unknown }[] {
    return fetchMock.mock.calls
      .filter(
        ([input, init]) =>
          (init?.method ?? "GET") === method && requestUrl(input).startsWith("/api/photos/metadata"),
      )
      .map(([input, init]) => ({ url: requestUrl(input), body: init?.body ? JSON.parse(String(init.body)) : null }));
  }

  type TestWindow = Window & { FRAMEOS_EMBEDDED_NO_BACKEND?: boolean };
  const testWindow = window as TestWindow;

  beforeEach(() => {
    testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
    window.localStorage.clear();
    window.history.replaceState({}, "", "/photos?folder=Trip");
    document.body.innerHTML = '<div id="popper"></div><div id="root"></div>';
    listing = [
      libraryPhoto("anim.gif", { content_type: "image/gif" }),
      libraryPhoto("pinned.jpg", { location: tallinn }),
      libraryPhoto("plain.jpg"),
    ];
    metadataByPath = {
      "Trip/pinned.jpg": photoMetadata,
      "Trip/plain.jpg": {
        location: null,
        fields: [{ group: "Image", name: "Make", value: "Canon" }],
        blocks: ["exif"],
      },
      "Trip/anim.gif": { location: null, fields: [], blocks: [] },
    };
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(requestUrl(input), "http://test");
      const path = url.searchParams.get("path") ?? "";
      switch (url.pathname) {
        case "/api/photos/status":
          return Response.json({
            ready: true,
            problem: null,
            message: null,
            location: null,
            used_bytes: 0,
            quota_bytes: null,
            free_bytes: null,
            max_upload_bytes: 0,
            accepts: null,
            scanning: [],
          });
        case "/api/photos/files":
          return Response.json({ path, entries: path === "Trip" ? listing : [] });
        case "/api/photos/shares":
          return Response.json({ shares: [] });
        case "/api/photos/metadata": {
          if (init?.method !== "POST") {
            return Response.json({ path, metadata: metadataByPath[path] });
          }
          // The server's side: the files lose what was asked for.
          const body = JSON.parse(String(init.body)) as { paths: string[]; remove: "location" | "all" };
          for (const target of body.paths) {
            const before = metadataByPath[target]!;
            metadataByPath[target] =
              body.remove === "location"
                ? { ...before, location: null, fields: before.fields.filter((field) => field.group !== "Location") }
                : { location: null, fields: [], blocks: [] };
            listing = listing.map((item) =>
              item.path === target ? { ...item, location: null, size: body.remove === "all" ? 900 : item.size } : item,
            );
          }
          const entries = body.paths.map((target) => listing.find((item) => item.path === target));
          return Response.json({ entries, changed: body.paths.length });
        }
        default:
          return Response.json({ frames: [] });
      }
    });
    // The colors editor and the painted viewer fetch the photo itself.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    initKea();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
  });

  function renderLibrary() {
    return render(createElement(Fragment, null, createElement(PhotosBrowser), createElement(Lightbox)));
  }

  async function tileOf(name: string): Promise<HTMLElement> {
    return (await screen.findByText(name)).closest("[data-photo-path]") as HTMLElement;
  }

  async function openViewer(name: string): Promise<HTMLElement> {
    fireEvent.click(await screen.findByText(name));
    return screen.findByRole("dialog", { name });
  }

  async function openInfoPanel(name: string): Promise<HTMLElement> {
    const viewer = await openViewer(name);
    fireEvent.click(within(viewer).getByTitle("Info"));
    return screen.findByRole("complementary", { name: "Info" });
  }

  function valueOf(panel: HTMLElement, name: string): string | null | undefined {
    return within(panel).getByText(name).nextElementSibling?.textContent;
  }

  it("pins the photos that carry a location, on the tile and in the list", async () => {
    renderLibrary();
    expect(within(await tileOf("pinned.jpg")).getByTitle("Has location")).toBeTruthy();
    expect(within(await tileOf("plain.jpg")).queryByTitle("Has location")).toBeNull();
    act(() => photosLogic.actions.setViewMode("list"));
    await waitFor(() => expect(document.querySelectorAll(".photos-row")).toHaveLength(3));
    expect(within(await tileOf("pinned.jpg")).getByTitle("Has location")).toBeTruthy();
    expect(within(await tileOf("plain.jpg")).queryByTitle("Has location")).toBeNull();
  });

  it("opens Info beside the photo: the location first, then the fields, then what else the file holds", async () => {
    renderLibrary();
    const panel = await openInfoPanel("pinned.jpg");
    await within(panel).findByText("59.43696, 24.75353");
    expect(within(panel).getByText("Altitude 31.5 m")).toBeTruthy();
    const map = within(panel).getByRole("link", { name: "Open in OpenStreetMap" });
    expect(map.getAttribute("href")).toBe(
      "https://www.openstreetmap.org/?mlat=59.43696&mlon=24.75353#map=16/59.43696/24.75353",
    );
    expect(map.getAttribute("target")).toBe("_blank");
    expect(map.getAttribute("rel")).toBe("noopener noreferrer");
    expect(valueOf(panel, "Make")).toBe("Apple");
    expect(valueOf(panel, "ExposureTime")).toBe("0.0166667");
    expect(valueOf(panel, "GPSLatitude")).toBe("59, 26, 13.06");
    expect(
      within(panel).getByText(
        "This file also holds XMP data and a video or second image after the photo, which can carry its own location.",
      ),
    ).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Remove location" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Remove all metadata" })).toBeTruthy();
    expect(metadataRequests("GET").map((request) => request.url)).toEqual([
      "/api/photos/metadata?path=Trip%2Fpinned.jpg",
    ]);
  });

  it("says so when a file holds nothing, and offers nothing to remove", async () => {
    renderLibrary();
    const panel = await openInfoPanel("anim.gif");
    await within(panel).findByText("No metadata in this file.");
    expect(within(panel).queryByRole("button", { name: /Remove/ })).toBeNull();
  });

  it("opens from a file's menu, on that photo", async () => {
    renderLibrary();
    const tile = await tileOf("plain.jpg");
    fireEvent.click(within(tile).getByRole("button", { name: "Menu" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Info" }));
    const panel = await screen.findByRole("complementary", { name: "Info" });
    expect(screen.getByRole("dialog", { name: "plain.jpg" })).toBeTruthy();
    expect(await within(panel).findByText("Canon")).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: "Remove location" })).toBeNull();
  });

  it("removes the location only after asking, then shows the file as it is now", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    renderLibrary();
    const panel = await openInfoPanel("pinned.jpg");
    fireEvent.click(await within(panel).findByRole("button", { name: "Remove location" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0]?.[0]).toBe(
      "The coordinates are erased from the file. Everything else stays. This cannot be undone.",
    );
    expect(metadataRequests("POST")).toEqual([]);

    fireEvent.click(within(panel).getByRole("button", { name: "Remove location" }));
    await waitFor(() => expect(metadataRequests("POST")).toHaveLength(1));
    expect(metadataRequests("POST")[0]?.body).toEqual({ paths: ["Trip/pinned.jpg"], remove: "location" });
    // The listing's entry lost its pin and the panel read the file again.
    await waitFor(() => expect(within(panel).queryByText("59.43696, 24.75353")).toBeNull());
    const entries = photosLogic.values.folderEntries.Trip ?? [];
    expect(entries.find((item) => item.path === "Trip/pinned.jpg")?.location).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Remove location" })).toBeNull();
    expect(within(panel).getByRole("button", { name: "Remove all metadata" })).toBeTruthy();
    expect(metadataRequests("GET")).toHaveLength(2);
    expect(photosLogic.values.notice).toEqual({ kind: "info", message: "Removed the location from 1 photo." });
  });

  it("offers the removals for a selection, counting the photos each would change", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderLibrary();
    await screen.findByText("pinned.jpg");
    act(() => photosLogic.actions.setSelection(["Trip/plain.jpg"]));
    const bar = await waitFor(() => document.querySelector(".photos-selection-bar") as HTMLElement);
    expect(within(bar).queryByRole("button", { name: /Remove location/ })).toBeNull();
    expect(within(bar).getByRole("button", { name: "Remove metadata (1)" })).toBeTruthy();

    act(() => photosLogic.actions.setSelection(["Trip/pinned.jpg", "Trip/plain.jpg", "Trip/anim.gif"]));
    expect(await within(bar).findByRole("button", { name: "Remove location (1)" })).toBeTruthy();
    // The GIF has nothing the server could change.
    fireEvent.click(within(bar).getByRole("button", { name: "Remove metadata (2)" }));
    await waitFor(() => expect(metadataRequests("POST")).toHaveLength(1));
    expect(metadataRequests("POST")[0]?.body).toEqual({ paths: ["Trip/pinned.jpg", "Trip/plain.jpg"], remove: "all" });
    expect(await screen.findByText("Removed the metadata from 2 photos.")).toBeTruthy();
    // Nothing has a location now, so that button goes.
    await waitFor(() => expect(within(bar).queryByRole("button", { name: /Remove location/ })).toBeNull());
  });

  it("keeps Info and the colors editor in one place: opening one closes the other", async () => {
    // The editor fetches the photo itself, which this harness answers with a 404.
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderLibrary();
    const viewer = await openViewer("pinned.jpg");
    fireEvent.click(within(viewer).getByTitle("Set colors"));
    await screen.findByRole("complementary", { name: "Set colors" });

    fireEvent.click(within(viewer).getByTitle("Info"));
    await screen.findByRole("complementary", { name: "Info" });
    expect(screen.queryByRole("complementary", { name: "Set colors" })).toBeNull();
    expect(photoColorsLogic.values.imagePath).toBeNull();

    fireEvent.click(within(viewer).getByTitle("Set colors"));
    await screen.findByRole("complementary", { name: "Set colors" });
    expect(screen.queryByRole("complementary", { name: "Info" })).toBeNull();
    expect(photoInfoLogic.values.infoOpen).toBe(false);
  });
});
