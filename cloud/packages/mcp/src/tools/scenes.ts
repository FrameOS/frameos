import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { failure, image, run, text, uuid, type ToolContext } from "../result";
import {
  resolveSceneSource,
  resolveStoreSceneId,
  sceneSourceSchema,
  storeRepository,
} from "./scene-source";

// Scenes: the account's own (private or published) and the public store.
// One id space — a store scene id names both — so scene_get_content,
// scene_render and scene_lint work on anything the token may read.

const sceneId = uuid().describe("Store scene id (uuid) from scenes_list or store_browse.");
const imageSha = z.string().regex(/^[0-9a-f]{64}$/, "an image sha256 (64 hex characters)");
const scenesJson = z
  .array(z.record(z.string(), z.unknown()))
  .describe("The scenes array (each with id, name, nodes, edges, fields, settings).");

type SceneSummary = Record<string, unknown> & { id: string; name: string };

const storeCategories = [
  "photos",
  "art",
  "calendar",
  "weather",
  "ai",
  "dashboards",
  "fun",
  "utilities",
  "demos",
] as const;

function sceneStats(scenes: Record<string, unknown>[]) {
  return scenes.map((scene) => ({
    edges: Array.isArray(scene.edges) ? scene.edges.length : 0,
    fields: Array.isArray(scene.fields) ? scene.fields.length : 0,
    id: scene.id,
    name: scene.name,
    nodes: Array.isArray(scene.nodes) ? scene.nodes.length : 0,
  }));
}

export function registerSceneTools(server: McpServer, ctx: ToolContext) {
  const api = ctx.client;

  const fetchContent = (id: string, version?: number) =>
    api.json<Record<string, unknown>[]>("GET", `/api/store/scenes/${id}/scenes.json`, {
      query: { version },
    });

  server.registerTool(
    "scenes_list",
    {
      annotations: { readOnlyHint: true },
      description:
        "The account's own scenes (private drafts and published ones): id, name, slug, visibility, status, latest_version, tags, category, download_count, has_preview. Filter with q (name/slug/tags), visibility (private|public) and status (active|pulled|featured).",
      inputSchema: {
        q: z.string().max(100).optional(),
        status: z.enum(["active", "pulled", "featured"]).optional(),
        visibility: z.enum(["private", "public"]).optional(),
      },
    },
    async ({ q, status, visibility }) =>
      run(async () => {
        const payload = await api.json<{ scenes: SceneSummary[] }>(
          "GET",
          "/api/account/scenes",
          { query: { q, status, visibility } },
        );
        return text({
          my_scenes_url: `${ctx.storeOrigin}/my-scenes`,
          scenes: payload.scenes.map((scene) => ({
            ...scene,
            url: `${ctx.storeOrigin}/s/${scene.slug}`,
          })),
        });
      }),
  );

  server.registerTool(
    "scene_get",
    {
      annotations: { readOnlyHint: true },
      description:
        "One of the account's scenes in full: summary, every version (number, message, size, yanked, risk flags, the listing and image digests it recorded), the latest version's images, preview and share URLs. For the scene JSON itself use scene_get_content.",
      inputSchema: { scene_id: sceneId },
    },
    async ({ scene_id }) =>
      run(async () => text(await api.json("GET", `/api/account/scenes/${scene_id}`))),
  );

  server.registerTool(
    "scene_get_content",
    {
      annotations: { readOnlyHint: true },
      description:
        "The scenes JSON of a store scene (the account's own, or any public one) — the array of scene objects with nodes, edges, fields and settings, each stamped with its `origin`. `version` picks a specific version; default is the newest non-yanked one. Accepts a uuid, a store slug, or a store page URL.",
      inputSchema: {
        scene: z.string().describe("Store scene id, slug, or page URL."),
        version: z.number().int().min(1).optional(),
      },
    },
    async ({ scene, version }) =>
      run(async () => {
        const id = await resolveStoreSceneId(ctx, scene);
        if (!id) {
          return failure(`No store scene matches "${scene}".`);
        }
        return text(await fetchContent(id, version));
      }),
  );

  server.registerTool(
    "scene_create",
    {
      description:
        "Create a new private scene in the account from exactly one of: scenes (raw scenes JSON), url (a scene zip or scenes.json to import; a store page URL forks that store scene into the account), or scene_id (fork a store scene). Returns the new scene's summary; install it on a frame with frame_scene_install.",
      inputSchema: {
        description: z.string().max(2000).optional(),
        name: z.string().max(128).optional(),
        ...sceneSourceSchema,
      },
    },
    async ({ description, name, ...source }) =>
      run(async () => {
        if (source.scene_id !== undefined || source.url !== undefined) {
          // A store reference means "make me a copy", unlike the frame
          // install, where the store scene is used as-is.
          const storeId = await resolveStoreSceneId(
            ctx,
            source.scene_id ?? source.url ?? "",
          ).catch(() => undefined);
          if (storeId) {
            const scenes = await fetchContent(storeId);
            const forked = await api.json<Record<string, unknown>>(
              "POST",
              `/api/account/scenes/${storeId}/fork`,
              { body: { scenes } },
            );
            return text({ ...forked, forked_from: storeId });
          }
        }
        const resolved = await resolveSceneSource(ctx, {
          ...source,
          description,
          name,
        });
        if ("error" in resolved) {
          return failure(resolved.error);
        }
        if (!resolved.created) {
          return failure("That reference is already a store scene; use scene_id with fork semantics (scene_fork) instead.");
        }
        return text({ scene: resolved.summary, status: "created" });
      }),
  );

  server.registerTool(
    "scene_update_content",
    {
      description:
        "Save new scenes JSON to one of the account's scenes as a new immutable version (versions are never overwritten). `message` is the changelog note (max 200 chars). Frames following 'latest' pick the new version up on their next deploy (frame_scene_install re-deploys).",
      inputSchema: {
        message: z.string().max(200).optional(),
        scene_id: sceneId,
        scenes: scenesJson,
      },
    },
    async ({ message, scene_id, scenes }) =>
      run(async () =>
        text(
          await api.json("POST", `/api/account/scenes/${scene_id}/content`, {
            body: { scenes, ...(message ? { message } : {}) },
          }),
        ),
      ),
  );

  server.registerTool(
    "scene_update",
    {
      description:
        "Edit a scene's listing — description, tags (max 5, lowercase a-z0-9-), category (photos|art|calendar|weather|ai|dashboards|fun|utilities|demos, null to clear), frameos_version (minimum FrameOS version, null to clear). The listing is part of a version: this publishes a new version carrying the edit with the scene's current content and images. For the name use scene_rename; for publishing use scene_publish.",
      inputSchema: {
        category: z.enum(storeCategories).nullable().optional(),
        description: z.string().max(2000).nullable().optional(),
        frameos_version: z.string().max(32).nullable().optional(),
        message: z.string().max(200).optional().describe("The version's one-line \"what changed\" note."),
        scene_id: sceneId,
        tags: z.array(z.string().max(24)).max(5).optional(),
      },
    },
    async ({ category, description, frameos_version, message, scene_id, tags }) =>
      run(async () =>
        text(
          await api.json("POST", `/api/account/scenes/${scene_id}/content`, {
            body: {
              listing: {
                ...(category !== undefined ? { category } : {}),
                ...(description !== undefined ? { description } : {}),
                ...(frameos_version !== undefined ? { frameosVersion: frameos_version } : {}),
                ...(tags !== undefined ? { tags } : {}),
              },
              message: message ?? "Listing updated",
            },
          }),
        ),
      ),
  );

  server.registerTool(
    "scene_rename",
    {
      description:
        "Rename one of the account's scenes: rewrites the scene's name inside its JSON and saves a new version, which also renames the store listing when the two were in sync (the API keeps a deliberately different listing title).",
      inputSchema: { name: z.string().min(1).max(128), scene_id: sceneId },
    },
    async ({ name, scene_id }) =>
      run(async () => {
        const detail = await api.json<{ scene: SceneSummary }>(
          "GET",
          `/api/account/scenes/${scene_id}`,
        );
        const scenes = await fetchContent(scene_id);
        const target =
          scenes.find((scene) => scene.name === detail.scene.name) ?? scenes[0];
        if (!target) {
          return failure("The scene has no content to rename.");
        }
        target.name = name;
        for (const scene of scenes) {
          delete scene.origin;
        }
        const saved = await api.json<{ scene: SceneSummary }>(
          "POST",
          `/api/account/scenes/${scene_id}/content`,
          { body: { message: `Renamed to ${name}`, scenes } },
        );
        return text({
          listing_renamed: saved.scene.name === name,
          previous_name: detail.scene.name,
          scene: saved.scene,
        });
      }),
  );

  server.registerTool(
    "scene_publish",
    {
      description:
        "Publish one of the account's scenes to the public store (or with public=false, make it private again). Public scenes are free of the storage quota; moderation may refuse names/descriptions (content_rejected).",
      inputSchema: { public: z.boolean().optional(), scene_id: sceneId },
    },
    async ({ public: makePublic, scene_id }) =>
      run(async () => {
        const result = await api.json<{ scene: SceneSummary & { slug: string } }>(
          "PATCH",
          `/api/account/scenes/${scene_id}`,
          { body: { visibility: makePublic === false ? "private" : "public" } },
        );
        return text({ ...result, url: `${ctx.storeOrigin}/s/${result.scene.slug}` });
      }),
  );

  server.registerTool(
    "scene_delete",
    {
      annotations: { destructiveHint: true },
      description:
        "Delete one of the account's scenes with all versions and images. Frames that had it assigned keep running what they hold until their next deploy. Requires confirm=true.",
      inputSchema: { confirm: z.literal(true), scene_id: sceneId },
    },
    async ({ scene_id }) =>
      run(async () => text(await api.json("DELETE", `/api/account/scenes/${scene_id}`))),
  );

  server.registerTool(
    "scene_fork",
    {
      description:
        "Copy a store scene (public, or one of the account's own) into the account as a new private scene, carrying over its description, tags and images. Accepts a uuid, slug, or store URL.",
      inputSchema: { scene: z.string() },
    },
    async ({ scene }) =>
      run(async () => {
        const id = await resolveStoreSceneId(ctx, scene);
        if (!id) {
          return failure(`No store scene matches "${scene}".`);
        }
        const scenes = await fetchContent(id);
        return text(
          await api.json("POST", `/api/account/scenes/${id}/fork`, { body: { scenes } }),
        );
      }),
  );

  server.registerTool(
    "scene_version_restore",
    {
      description:
        "Roll a scene back to an earlier version by saving that version's content as a new latest version (history is preserved).",
      inputSchema: { scene_id: sceneId, version: z.number().int().min(1) },
    },
    async ({ scene_id, version }) =>
      run(async () => {
        const scenes = await fetchContent(scene_id, version);
        for (const scene of scenes) {
          delete scene.origin;
        }
        return text(
          await api.json("POST", `/api/account/scenes/${scene_id}/content`, {
            body: { message: `Restored version ${version}`, scenes },
          }),
        );
      }),
  );

  server.registerTool(
    "scene_version_yank",
    {
      description:
        "Yank (hide from 'latest') or un-yank a version of one of the account's scenes. A yanked version is still downloadable by number; the last non-yanked version cannot be yanked.",
      inputSchema: {
        scene_id: sceneId,
        version: z.number().int().min(1),
        yanked: z.boolean(),
      },
    },
    async ({ scene_id, version, yanked }) =>
      run(async () =>
        text(
          await api.json(
            "PATCH",
            `/api/account/scenes/${scene_id}/versions/${version}`,
            { body: { yanked } },
          ),
        ),
      ),
  );

  server.registerTool(
    "scene_image_get",
    {
      annotations: { readOnlyHint: true },
      description:
        "A scene's cover image (default) or one of its images by sha256, as an image. Works for public store scenes too.",
      inputSchema: { scene_id: sceneId, sha256: imageSha.optional() },
    },
    async ({ scene_id, sha256 }) =>
      run(async () => {
        const { bytes, contentType } = await api.bytes(
          "GET",
          sha256
            ? `/api/store/scenes/${scene_id}/images/${sha256}`
            : `/api/store/scenes/${scene_id}/image`,
        );
        return image(bytes, contentType, `Scene ${scene_id} ${sha256 ? `image ${sha256}` : "cover"}`);
      }),
  );

  server.registerTool(
    "scene_image_add",
    {
      description:
        "Add an image (jpeg/png/webp/gif, max 4 MiB) to one of the account's scenes: registers the bytes and publishes a new version whose image set has it appended (position 0 is the cover — pass cover=true to make it lead). Images are content-addressed and shared; the same bytes are stored once. Tip: scene_render produces a PNG you can add here.",
      inputSchema: {
        content_base64: z.string(),
        cover: z.boolean().optional(),
        message: z.string().max(200).optional(),
        scene_id: sceneId,
      },
    },
    async ({ content_base64, cover, message, scene_id }) =>
      run(async () => {
        const registered = await api.json<{ image: { sha256: string } }>(
          "POST",
          `/api/account/scenes/${scene_id}/images`,
          { body: { content_base64 } },
        );
        const detail = await api.json<{ images: { sha256: string }[] }>(
          "GET",
          `/api/account/scenes/${scene_id}`,
        );
        const rest = detail.images.map((entry) => entry.sha256).filter((sha) => sha !== registered.image.sha256);
        const images = cover ? [registered.image.sha256, ...rest] : [...rest, registered.image.sha256];
        const saved = await api.json("POST", `/api/account/scenes/${scene_id}/content`, {
          body: { images, message: message ?? "Image added" },
        });
        return text({ image: registered.image, images, ...(saved as object) });
      }),
  );

  server.registerTool(
    "scene_image_remove",
    {
      annotations: { destructiveHint: true },
      description:
        "Remove an image (by sha256; without one, the cover) from one of the account's scenes: publishes a new version without it. Older versions keep it.",
      inputSchema: { message: z.string().max(200).optional(), scene_id: sceneId, sha256: imageSha.optional() },
    },
    async ({ message, scene_id, sha256 }) =>
      run(async () => {
        const detail = await api.json<{ images: { sha256: string }[] }>(
          "GET",
          `/api/account/scenes/${scene_id}`,
        );
        const current = detail.images.map((entry) => entry.sha256);
        const target = sha256 ?? current[0];
        if (!target || !current.includes(target)) {
          return failure("The scene's latest version has no such image.");
        }
        const images = current.filter((sha) => sha !== target);
        return text(
          await api.json("POST", `/api/account/scenes/${scene_id}/content`, {
            body: { images, message: message ?? "Image removed" },
          }),
        );
      }),
  );

  server.registerTool(
    "scene_images_reorder",
    {
      description:
        "Reorder a scene's images: pass the complete list of sha256 digests in the new order (the first is the cover). Publishes a new version with that set.",
      inputSchema: { message: z.string().max(200).optional(), order: z.array(imageSha).max(10), scene_id: sceneId },
    },
    async ({ message, order, scene_id }) =>
      run(async () =>
        text(
          await api.json("POST", `/api/account/scenes/${scene_id}/content`, {
            body: { images: order, message: message ?? "Images reordered" },
          }),
        ),
      ),
  );

  server.registerTool(
    "scene_render",
    {
      annotations: { readOnlyHint: true },
      description:
        "Render a scene on the server with the real FrameOS runtime and return the frame as an image plus the runtime's logs — a live preview without a device. Give scene_id (store scene, optional version) or raw scenes JSON; width/height default to 800×480; time_zone (IANA) and settings (e.g. {\"unsplash\": {\"accessKey\": \"…\"}}) shape the simulated frame; states seeds field values per scene id. Errors the scene logged are listed so you can fix and re-render.",
      inputSchema: {
        height: z.number().int().min(16).max(4096).optional(),
        scene: z.string().max(256).optional().describe("Runtime scene id to select in a multi-scene set."),
        scene_id: z.string().optional().describe("Store scene id, slug or URL."),
        scenes: scenesJson.optional(),
        settings: z.record(z.string(), z.unknown()).optional(),
        states: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
        time_zone: z.string().max(64).optional(),
        version: z.number().int().min(1).optional(),
        width: z.number().int().min(16).max(4096).optional(),
      },
    },
    async ({ height, scene, scene_id, scenes, settings, states, time_zone, version, width }) =>
      run(async () => {
        let storeId: string | undefined;
        if (scene_id) {
          storeId = await resolveStoreSceneId(ctx, scene_id);
          if (!storeId) {
            return failure(`No store scene matches "${scene_id}".`);
          }
        } else if (!scenes) {
          return failure("Provide scene_id or scenes.");
        }
        const result = await api.json<{
          errors: string[];
          height: number;
          logs: string[];
          png_base64: string;
          render_ms: number;
          state: unknown;
          width: number;
        }>("POST", "/api/scenes/render", {
          body: {
            format: "json",
            height,
            scene,
            ...(storeId ? { scene_id: storeId } : { scenes }),
            settings,
            states,
            time_zone,
            version,
            width,
          },
        });
        const summary = {
          errors: result.errors,
          height: result.height,
          logs: result.logs.slice(-40),
          render_ms: result.render_ms,
          state: result.state,
          width: result.width,
        };
        return {
          content: [
            { text: JSON.stringify(summary, null, 2), type: "text" },
            { data: result.png_base64, mimeType: "image/png", type: "image" },
          ],
        };
      }),
  );

  server.registerTool(
    "scene_lint",
    {
      annotations: { readOnlyHint: true },
      description:
        "Validate scenes JSON the way publishing and the scene AI do: structural checks, app keywords against the catalog, and a deep lint of nodes, edges, fields and JS app sources. Errors block; warnings are advice. Pass scenes JSON or a scene_id.",
      inputSchema: {
        scene_id: z.string().optional(),
        scenes: scenesJson.optional(),
        version: z.number().int().min(1).optional(),
      },
    },
    async ({ scene_id, scenes, version }) =>
      run(async () => {
        let payload = scenes;
        if (!payload) {
          if (!scene_id) {
            return failure("Provide scene_id or scenes.");
          }
          const id = await resolveStoreSceneId(ctx, scene_id);
          if (!id) {
            return failure(`No store scene matches "${scene_id}".`);
          }
          payload = await fetchContent(id, version);
        }
        return text(await api.json("POST", "/api/scenes/lint", { body: { scenes: payload } }));
      }),
  );

  server.registerTool(
    "store_browse",
    {
      annotations: { readOnlyHint: true },
      description:
        "Browse the public scene store: full-text q (name, description, publisher, tags), one tag, a category (photos|art|calendar|weather|ai|dashboards|fun|utilities|demos), frameos_version (only scenes that run on that version), page (48 per page). Featured and popular scenes come first. Install a result on a frame with frame_scene_install(scene_id).",
      inputSchema: {
        category: z.enum(storeCategories).optional(),
        frameos_version: z.string().max(40).optional(),
        page: z.number().int().min(1).max(200).optional(),
        q: z.string().max(100).optional(),
        tag: z.string().max(24).optional(),
      },
    },
    async ({ category, frameos_version, page, q, tag }) =>
      run(async () => {
        const payload = await api.json<{
          hasMore: boolean;
          page: number;
          scenes: (Record<string, unknown> & { slug: string })[];
        }>("GET", "/api/store/browse", {
          query: { category, page, q, tag, version: frameos_version },
        });
        return text({
          has_more: payload.hasMore,
          page: payload.page,
          scenes: payload.scenes.map((scene) => ({
            ...scene,
            url: `${ctx.storeOrigin}/s/${scene.slug}`,
          })),
        });
      }),
  );

  server.registerTool(
    "store_scene_get",
    {
      annotations: { readOnlyHint: true },
      description:
        "Details of a store scene by uuid, slug or store URL: name, author, description, tags, category, version, cover image URL and zip URL, plus the scene JSON's scene ids/names and node counts.",
      inputSchema: { scene: z.string() },
    },
    async ({ scene }) =>
      run(async () => {
        const id = await resolveStoreSceneId(ctx, scene);
        if (!id) {
          return failure(`No store scene matches "${scene}".`);
        }
        const [templates, scenes] = await Promise.all([
          storeRepository(ctx),
          fetchContent(id),
        ]);
        const template = templates.find((entry) => entry.sceneId === id);
        return text({
          content_summary: sceneStats(scenes),
          scene_id: id,
          template: template ?? null,
          url: template ? `${ctx.storeOrigin}/s/${template.id}` : null,
        });
      }),
  );

  server.registerTool(
    "store_scene_report",
    {
      description: "Report a public store scene to the moderators, with a reason (max 1000 chars).",
      inputSchema: { reason: z.string().min(1).max(1000), scene_id: sceneId },
    },
    async ({ reason, scene_id }) =>
      run(async () =>
        text(
          await api.json("POST", `/api/store/scenes/${scene_id}/report`, {
            body: { reason },
          }),
        ),
      ),
  );
}
