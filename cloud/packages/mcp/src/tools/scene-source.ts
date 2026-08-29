import { z } from "zod";
import { CloudApiError } from "../client";
import { isUuid, type ToolContext } from "../result";

// "Which scene do you mean?" answered once for every tool that takes one:
// a store scene id, a URL (store page, scenes.json, or a zip), or raw
// scene JSON. URLs and JSON that are not already in the account become a
// private scene first — the frame routes only take store ids.

export const sceneSourceSchema = {
  scene_id: z
    .string()
    .optional()
    .describe("A store scene id (uuid) — public, or one of the account's own."),
  scenes: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe("Raw scenes JSON (the array from a scenes.json)."),
  url: z
    .string()
    .url()
    .optional()
    .describe("A scene page URL on the store (…/s/<slug>), a scenes.json URL, or a scene zip URL."),
};

export type SceneSourceInput = {
  description?: string | undefined;
  name?: string | undefined;
  scene_id?: string | undefined;
  scenes?: Record<string, unknown>[] | undefined;
  url?: string | undefined;
};

export type ResolvedSceneSource =
  | { created: boolean; sceneId: string; summary?: Record<string, unknown> | undefined }
  | { error: string };

type RepositoryTemplate = {
  id: string;
  name: string;
  sceneId: string;
  url?: string;
  version?: string;
  visibility?: string;
};

const repositoryCache = new WeakMap<
  ToolContext,
  { fetchedAt: number; templates: RepositoryTemplate[] }
>();

export async function storeRepository(
  ctx: ToolContext,
): Promise<RepositoryTemplate[]> {
  const cached = repositoryCache.get(ctx);
  if (cached && Date.now() - cached.fetchedAt < 5 * 60 * 1000) {
    return cached.templates;
  }
  const [store, drive] = await Promise.all([
    ctx.client.json<{ templates: RepositoryTemplate[] }>(
      "GET",
      "/api/store/repository.json",
    ),
    ctx.client
      .json<{ templates: RepositoryTemplate[] }>(
        "GET",
        "/api/store/account/repository.json",
      )
      .catch(() => ({ templates: [] as RepositoryTemplate[] })),
  ]);
  const templates = [...drive.templates, ...store.templates];
  repositoryCache.set(ctx, { fetchedAt: Date.now(), templates });
  return templates;
}

/** Store scene id for a slug, a uuid, or a store page URL. */
export async function resolveStoreSceneId(
  ctx: ToolContext,
  reference: string,
): Promise<string | undefined> {
  const trimmed = reference.trim();
  if (isUuid(trimmed)) {
    return trimmed;
  }
  let slug = trimmed;
  try {
    const url = new URL(trimmed);
    const match = url.pathname.match(/\/(?:s|scenes)\/([^/]+)\/?$/);
    if (match?.[1]) {
      slug = decodeURIComponent(match[1]);
    }
  } catch {
    // not a URL — treat as a slug
  }
  const templates = await storeRepository(ctx);
  return templates.find((template) => template.id === slug)?.sceneId;
}

function sceneNameOf(scenes: Record<string, unknown>[]): string | undefined {
  const first = scenes[0];
  return first && typeof first.name === "string" && first.name.trim()
    ? first.name.trim()
    : undefined;
}

async function createPrivateScene(
  ctx: ToolContext,
  scenes: Record<string, unknown>[],
  name: string | undefined,
  description: string | undefined,
): Promise<ResolvedSceneSource> {
  const created = await ctx.client.json<{ scene: Record<string, unknown> }>(
    "POST",
    "/api/account/scenes",
    {
      body: {
        scenes,
        ...(name || sceneNameOf(scenes) ? { name: name ?? sceneNameOf(scenes) } : {}),
        ...(description ? { description } : {}),
      },
    },
  );
  return {
    created: true,
    sceneId: String(created.scene.id),
    summary: created.scene,
  };
}

async function uploadSceneZip(
  ctx: ToolContext,
  bytes: Uint8Array,
  filename: string,
): Promise<ResolvedSceneSource> {
  const form = new FormData();
  // slice() re-homes the bytes on a plain ArrayBuffer, which Blob demands.
  form.append(
    "file",
    new Blob([bytes.slice()], { type: "application/zip" }),
    filename,
  );
  const created = await ctx.client.json<{ scene: Record<string, unknown> }>(
    "POST",
    "/api/account/scenes/upload",
    { raw: form },
  );
  return {
    created: true,
    sceneId: String(created.scene.id),
    summary: created.scene,
  };
}

const maxImportBytes = 8 * 1024 * 1024;

export async function resolveSceneSource(
  ctx: ToolContext,
  input: SceneSourceInput,
): Promise<ResolvedSceneSource> {
  const provided = [input.scene_id, input.url, input.scenes].filter(
    (value) => value !== undefined,
  ).length;
  if (provided !== 1) {
    return { error: "Provide exactly one of scene_id, url, or scenes." };
  }
  if (input.scene_id !== undefined) {
    const sceneId = await resolveStoreSceneId(ctx, input.scene_id);
    if (!sceneId) {
      return { error: `No store scene matches "${input.scene_id}".` };
    }
    return { created: false, sceneId };
  }
  if (input.scenes !== undefined) {
    if (input.scenes.length === 0) {
      return { error: "`scenes` must be a non-empty array." };
    }
    return createPrivateScene(ctx, input.scenes, input.name, input.description);
  }
  const url = input.url ?? "";
  // A store page: already in the store, no copy needed.
  const storeId = await resolveStoreSceneId(ctx, url).catch(() => undefined);
  if (storeId) {
    return { created: false, sceneId: storeId };
  }
  // A cloud scenes.json / download URL of ours: read it through the API so
  // private scenes the token may see resolve too.
  const ownRoute = url.match(/\/api\/store\/scenes\/([0-9a-f-]{36})\//i);
  if (ownRoute?.[1]) {
    return { created: false, sceneId: ownRoute[1] };
  }
  let response: Response;
  try {
    response = await ctx.fetchExternal(url, {
      headers: { accept: "application/zip, application/json, */*" },
      redirect: "follow",
    });
  } catch (error) {
    return { error: `Could not fetch ${url}: ${String(error)}` };
  }
  if (!response.ok) {
    return { error: `Could not fetch ${url}: HTTP ${response.status}` };
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > maxImportBytes) {
    return { error: `${url} is larger than ${maxImportBytes} bytes.` };
  }
  const contentType = response.headers.get("content-type") ?? "";
  const isZip =
    contentType.includes("zip") ||
    (bytes[0] === 0x50 && bytes[1] === 0x4b);
  try {
    if (isZip) {
      const filename =
        decodeURIComponent(new URL(url).pathname.split("/").pop() || "scene.zip") ||
        "scene.zip";
      return await uploadSceneZip(
        ctx,
        bytes,
        filename.endsWith(".zip") ? filename : `${filename}.zip`,
      );
    }
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    const scenes = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { scenes?: unknown }).scenes)
        ? (parsed as { scenes: unknown[] }).scenes
        : undefined;
    if (!scenes || scenes.length === 0) {
      return { error: `${url} is neither a scene zip nor a scenes.json.` };
    }
    return await createPrivateScene(
      ctx,
      scenes as Record<string, unknown>[],
      input.name,
      input.description,
    );
  } catch (error) {
    if (error instanceof CloudApiError) {
      throw error;
    }
    return { error: `${url} could not be imported: ${String(error)}` };
  }
}
