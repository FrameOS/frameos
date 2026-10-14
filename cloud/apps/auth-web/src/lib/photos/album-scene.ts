// The scene an album plays on a frame (docs/photos.md, "Installing photo
// scenes"): render event -> render/image fed by the photoAlbum app, then
// sleep for the scene's `seconds`. The share link sits in the app node's
// config, out of the public state.
//
// The SPA builds the same scene (frontend/src/scenes/photos/photoAlbumScene.ts)
// and so does the backend (backend/app/utils/photo_album_scene.py);
// docs/photo-album-scene.json pins all three to one shape. The app's config
// and sources come from the bundled catalog (scripts/generate-ai-context.mjs
// reads repo/apps/code on every build).

import { randomUUID } from "node:crypto";
import { appCatalog } from "../ai/context";

export const photoAlbumAppOrigin = "repo/apps/code/photoAlbum";
const photoAlbumAppKey = "photoAlbum";
export const defaultPhotoAlbumSeconds = 3600;

export const photoAlbumOrders = [
  { label: "Shuffle", value: "random" },
  { label: "By name", value: "sequential" },
  { label: "Newest first", value: "newest" },
  { label: "Oldest first", value: "oldest" },
] as const;

export const photoAlbumFits = [
  { label: "Fill the screen", value: "cover" },
  { label: "Show the whole photo", value: "contain" },
] as const;

export type PhotoAlbumOrder = (typeof photoAlbumOrders)[number]["value"];
export type PhotoAlbumFit = (typeof photoAlbumFits)[number]["value"];

export function isPhotoAlbumOrder(value: unknown): value is PhotoAlbumOrder {
  return photoAlbumOrders.some((option) => option.value === value);
}

export function isPhotoAlbumFit(value: unknown): value is PhotoAlbumFit {
  return photoAlbumFits.some((option) => option.value === value);
}

/** The scene-local app the scene carries: config.json's keys, origin, sources. */
export function photoAlbumApp(): Record<string, unknown> {
  const template = appCatalog()[photoAlbumAppOrigin];
  if (!template?.sources || Object.keys(template.sources).length === 0) {
    throw new Error("The Photo album app is missing from this build.");
  }
  const { keyword: _keyword, sources, ...config } = template;
  return { ...config, origin: photoAlbumAppOrigin, sources: { ...sources } };
}

export function buildPhotoAlbumScene(options: {
  albumUrl: string;
  fit: PhotoAlbumFit;
  name: string;
  order: PhotoAlbumOrder;
  seconds: number;
}): Record<string, unknown> {
  const seconds =
    Number.isFinite(options.seconds) && options.seconds > 0
      ? options.seconds
      : defaultPhotoAlbumSeconds;
  const ids = {
    album: randomUUID(),
    event: randomUUID(),
    fit: randomUUID(),
    order: randomUUID(),
    renderImage: randomUUID(),
    seconds: randomUUID(),
    sleep: randomUUID(),
  };
  const node = (id: string, type: string, data: Record<string, unknown>, x: number, y: number) => ({
    data,
    id,
    position: { x, y },
    type,
  });
  const edge = (
    source: string,
    sourceHandle: string,
    target: string,
    targetHandle: string,
    type: string,
  ) => ({ id: randomUUID(), source, sourceHandle, target, targetHandle, type });

  return {
    apps: { [photoAlbumAppKey]: photoAlbumApp() },
    edges: [
      edge(ids.event, "next", ids.renderImage, "prev", "appNodeEdge"),
      edge(ids.album, "fieldOutput", ids.renderImage, "fieldInput/image", "codeNodeEdge"),
      edge(ids.renderImage, "next", ids.sleep, "prev", "appNodeEdge"),
      edge(ids.seconds, "fieldOutput", ids.sleep, "fieldInput/duration", "codeNodeEdge"),
      edge(ids.order, "fieldOutput", ids.album, "fieldInput/order", "codeNodeEdge"),
      edge(ids.fit, "fieldOutput", ids.renderImage, "fieldInput/placement", "codeNodeEdge"),
    ],
    fields: [
      {
        access: "public",
        label: "Seconds to show one photo",
        name: "seconds",
        persist: "disk",
        role: "refreshInterval",
        type: "float",
        value: String(seconds),
      },
      {
        access: "public",
        label: "Order",
        name: "order",
        options: photoAlbumOrders.map(({ label, value }) => ({ label, value })),
        persist: "disk",
        type: "select",
        value: options.order,
      },
      {
        access: "public",
        label: "Fit",
        name: "fit",
        options: photoAlbumFits.map(({ label, value }) => ({ label, value })),
        persist: "disk",
        type: "select",
        value: options.fit,
      },
      {
        access: "private",
        label: "Position in the album",
        name: "photoIndex",
        persist: "disk",
        type: "integer",
        value: "0",
      },
    ],
    id: randomUUID(),
    name: options.name,
    nodes: [
      node(ids.event, "event", { keyword: "render" }, -320, 120),
      node(ids.renderImage, "app", { config: {}, keyword: "render/image" }, 200, 140),
      node(
        ids.album,
        "app",
        {
          cache: { enabled: false },
          config: { album: options.albumUrl, counterStateKey: "photoIndex" },
          keyword: photoAlbumAppKey,
        },
        -260,
        -200,
      ),
      node(ids.sleep, "app", { config: {}, keyword: "logic/nextSleepDuration" }, 640, 140),
      node(ids.seconds, "state", { keyword: "seconds" }, 560, 40),
      node(ids.order, "state", { keyword: "order" }, -520, -140),
      node(ids.fit, "state", { keyword: "fit" }, 120, 40),
    ],
    settings: {
      backgroundColor: "#000000",
      execution: "interpreted",
      refreshInterval: seconds,
    },
  };
}
