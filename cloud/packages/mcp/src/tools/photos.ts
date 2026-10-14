import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CloudApiError } from "../client";
import { confirmed } from "./confirm";
import { installSceneOnFrame } from "./frames";
import { failure, image, run, text, uuid, type ToolContext } from "../result";

// The account's photo library (docs/photos.md): albums whose bytes live in
// R2, played by frames through share links. Every tool is one /api/photos
// route, except two: photo_upload sends a file in the route's chunks
// (downloading it first when given a URL), and photo_album_install is
// POST /api/photos/scene followed by what frame_scene_install does. The names
// match the self-hosted backend's photos tools.
//
// Every write takes `confirm`: a frame playing a shared album shows what is
// in the folder on its next photo, so adding, moving, recoloring or deleting
// a photo changes what a physical frame shows. Sharing makes a folder
// readable by anyone who has the link.

const chunkBytes = 4 * 1024 * 1024;
// MCP clients pass these on to a model; the rest come back as a summary.
const inlineImageTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const maxInlineImageBytes = 5 * 1024 * 1024;
const libraryWrite =
  "changes the photo library, which frames playing a shared album show on their next photo";

const photoPath = z
  .string()
  .min(1)
  .max(1024)
  .describe('Path in the library, e.g. "Summer 2026/beach.jpg" (photos_list has them).');
const folderPath = z.string().max(1024).describe('Folder path in the library; "" is the root.');
const photoPaths = z.array(z.string().min(1).max(1024)).min(1).max(1000);

function filenameFromUrl(url: string) {
  try {
    const last = new URL(url).pathname.split("/").pop() ?? "";
    return decodeURIComponent(last).trim();
  } catch {
    return "";
  }
}

/** The body of a response, refused past `maxBytes` (declared or not). */
async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array | undefined> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return undefined;
  }
  if (!response.body) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

export function registerPhotoTools(server: McpServer, ctx: ToolContext) {
  const api = ctx.client;

  server.registerTool(
    "photos_status",
    {
      annotations: { readOnlyHint: true },
      description:
        "Whether the photo library is ready (when not, `message` says why and every other photos tool fails), the space used and the quota, the upload size limit and the image types uploads may have.",
      inputSchema: {},
    },
    async () => run(async () => text(await api.json("GET", "/api/photos/status"))),
  );

  server.registerTool(
    "photos_list",
    {
      annotations: { readOnlyHint: true },
      description:
        'One folder of the photo library: its folders (albums at the root, with item counts and a cover) and files (size, dimensions, `colors` when the photo has a color profile). path "" is the root.',
      inputSchema: { path: folderPath.optional() },
    },
    async ({ path }) =>
      run(async () => text(await api.json("GET", "/api/photos/files", { query: { path: path ?? "" } }))),
  );

  server.registerTool(
    "photo_get",
    {
      annotations: { readOnlyHint: true },
      description:
        "See one photo: its thumbnail (512 px), or the file itself with original=true (JPEG, PNG, GIF and WebP up to 5 MB come back as an image).",
      inputSchema: { original: z.boolean().optional(), path: photoPath },
    },
    async ({ original, path }) =>
      run(async () => {
        if (!original) {
          try {
            const thumb = await api.bytes("GET", "/api/photos/thumb", { query: { path } });
            return image(thumb.bytes, "image/jpeg", `${path} (thumbnail, ${thumb.bytes.length} bytes)`);
          } catch (error) {
            // No thumbnail (the upload could not make one): the file.
            if (!(error instanceof CloudApiError && error.status === 404)) {
              throw error;
            }
          }
        }
        const file = await api.bytes("GET", "/api/photos/file", { query: { path } });
        const mime = file.contentType.split(";")[0]?.trim() ?? "";
        if (inlineImageTypes.has(mime) && file.bytes.length <= maxInlineImageBytes) {
          return image(file.bytes, mime, `${path} (${mime}, ${file.bytes.length} bytes)`);
        }
        return text({
          content_type: mime,
          note: "Not returned inline: only JPEG, PNG, GIF and WebP images up to 5 MB are.",
          path,
          size: file.bytes.length,
        });
      }),
  );

  server.registerTool(
    "photo_upload",
    {
      description:
        'Add a photo to a folder of the library (missing folders are made; a taken name gets " (2)"), from a URL the server downloads or from base64 bytes. JPEG, PNG, GIF and WebP only; every upload is scanned before it is stored. The answer\'s entry has the real path. For a file on your own disk, POST it to /api/photos/upload with the API token instead (docs/photos.md). Requires confirm=true.',
      inputSchema: {
        confirm: confirmed(libraryWrite),
        content_base64: z.string().optional(),
        filename: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe("Name to store it under; with url, defaults to the URL's file name."),
        folder: folderPath.optional(),
        url: z.string().url().optional().describe("http(s) URL of the image."),
      },
    },
    async ({ content_base64, filename, folder, url }) =>
      run(async () => {
        if ((content_base64 === undefined) === (url === undefined)) {
          return failure("Pass exactly one of content_base64 or url.");
        }
        const status = await api.json<{ max_upload_bytes?: number }>("GET", "/api/photos/status");
        const maxBytes = status.max_upload_bytes ?? 20 * 1024 * 1024;
        let bytes: Uint8Array;
        let name = filename;
        if (url !== undefined) {
          const response = await ctx.fetchExternal(url, {
            headers: { accept: "image/*" },
            signal: AbortSignal.timeout(60_000),
          });
          if (!response.ok) {
            return failure(`${url} answered ${response.status}`);
          }
          const body = await readLimited(response, maxBytes);
          if (!body) {
            return failure(`${url} is over the ${Math.floor(maxBytes / (1024 * 1024))} MiB upload limit.`);
          }
          bytes = body;
          name = name || filenameFromUrl(url);
          if (!name) {
            return failure("The URL has no file name in it; pass filename.");
          }
        } else {
          if (!name) {
            return failure("Pass filename with content_base64.");
          }
          bytes = Buffer.from(content_base64 ?? "", "base64");
        }
        const uploadId = crypto.randomUUID().replaceAll("-", "");
        let offset = 0;
        let payload: unknown;
        do {
          const chunk = bytes.subarray(offset, offset + chunkBytes);
          const last = offset + chunk.length >= bytes.length;
          payload = await api.json("POST", "/api/photos/upload", {
            contentType: "application/octet-stream",
            query: {
              complete: last ? 1 : 0,
              filename: name,
              offset,
              path: folder ?? "",
              upload_id: uploadId,
            },
            raw: chunk,
          });
          offset += chunk.length;
        } while (offset < bytes.length);
        return text(payload);
      }),
  );

  server.registerTool(
    "photo_folder_create",
    {
      description:
        "Make a folder (an album when it is at the root); missing parents are made too. Requires confirm=true.",
      inputSchema: { confirm: confirmed(libraryWrite), path: photoPath },
    },
    async ({ path }) =>
      run(async () => text(await api.json("POST", "/api/photos/folders", { body: { path } }))),
  );

  server.registerTool(
    "photos_move",
    {
      description:
        'Move files and folders into an existing folder (`to`, "" for the root). Taken names get " (2)"; nothing moves when one path is missing. Share links follow their folders. Requires confirm=true.',
      inputSchema: { confirm: confirmed(libraryWrite), paths: photoPaths, to: folderPath.optional() },
    },
    async ({ paths, to }) =>
      run(async () =>
        text(await api.json("POST", "/api/photos/move", { body: { paths, to: to ?? "" } })),
      ),
  );

  server.registerTool(
    "photo_rename",
    {
      description:
        "Rename a file or folder in place (`name` is the new last segment). A photo keeps its color profile; share links follow. Requires confirm=true.",
      inputSchema: {
        confirm: confirmed(libraryWrite),
        name: z.string().min(1).max(255),
        path: photoPath,
      },
    },
    async ({ name, path }) =>
      run(async () => text(await api.json("POST", "/api/photos/rename", { body: { name, path } }))),
  );

  server.registerTool(
    "photos_delete",
    {
      annotations: { destructiveHint: true },
      description:
        "Delete files and folders for good. A folder goes with everything in it and with the share links at or below it, so frames playing those links stop. Requires confirm=true.",
      inputSchema: {
        confirm: confirmed("deletes photos for good, from every frame that plays them"),
        paths: photoPaths,
      },
    },
    async ({ paths }) =>
      run(async () => text(await api.json("POST", "/api/photos/delete", { body: { paths } }))),
  );

  server.registerTool(
    "photo_colors_set",
    {
      description:
        "Set a photo's color profile, which frames apply when they show it (docs/asset-color-profiles.md: exposure, contrast, whites, blacks, saturation, shadows/midtones/highlights, hues, palette). colors=null removes it, so each frame fits the photo to its panel itself. Requires confirm=true.",
      inputSchema: {
        colors: z
          .record(z.string(), z.unknown())
          .nullable()
          .describe('The profile\'s `colors` object, e.g. {"exposure": 0.3, "saturation": 20}; null to remove.'),
        confirm: confirmed(libraryWrite),
        path: photoPath,
      },
    },
    async ({ colors, path }) =>
      run(async () => text(await api.json("POST", "/api/photos/colors", { body: { colors, path } }))),
  );

  server.registerTool(
    "photo_shares_list",
    {
      annotations: { readOnlyHint: true },
      description: "The library's share links: token, folder and the url frames play.",
      inputSchema: {},
    },
    async () => run(async () => text(await api.json("GET", "/api/photos/shares"))),
  );

  server.registerTool(
    "photo_share_create",
    {
      description:
        "The folder's share link (an existing one is returned as it is). Anyone with the link can see every photo below the folder, with no login. Requires confirm=true.",
      inputSchema: {
        confirm: confirmed("makes the folder's photos readable by anyone who has the link"),
        path: photoPath.describe("Folder to share (not the root)."),
      },
    },
    async ({ path }) =>
      run(async () => text(await api.json("POST", "/api/photos/shares", { body: { path } }))),
  );

  server.registerTool(
    "photo_share_delete",
    {
      annotations: { destructiveHint: true },
      description: "Revoke a share link. Frames playing it stop getting photos. Requires confirm=true.",
      inputSchema: {
        confirm: confirmed("stops every frame that plays this link"),
        token: z
          .string()
          .regex(/^pk_[A-Za-z0-9_-]+$/)
          .describe("pk_... token from photo_shares_list."),
      },
    },
    async ({ token }) =>
      run(async () => text(await api.json("DELETE", `/api/photos/shares/${token}`))),
  );

  server.registerTool(
    "photo_album_install",
    {
      description:
        "Play a folder on a frame: makes the folder's share link (if it has none) and a scene that shows one photo per `seconds`, saves the scene to the account as a private scene and installs it on the frame (the same as Install photo scenes in the web UI). activate=true shows it now. Requires confirm=true.",
      inputSchema: {
        activate: z.boolean().optional(),
        confirm: confirmed("changes what a physical frame shows"),
        fit: z
          .enum(["cover", "contain"])
          .optional()
          .describe("cover (default) fills the screen; contain shows the whole photo."),
        frame_id: uuid().describe("Frame id (uuid) from frames_list."),
        name: z.string().max(256).optional().describe("Scene name. Default: the folder's name."),
        order: z
          .enum(["random", "sequential", "newest", "oldest"])
          .optional()
          .describe("random (default) shows every photo once before any repeats; sequential goes by path."),
        path: photoPath.describe("Folder to play (not the root)."),
        seconds: z.number().min(1).optional().describe("How long each photo stays. Default 3600."),
      },
    },
    async ({ activate, fit, frame_id, name, order, path, seconds }) =>
      run(async () => {
        // The frame first: the scene route shares the folder, and a wrong
        // frame id must not leave a link behind (the backend checks too).
        await api.json("GET", `/api/frames/${frame_id}`);
        const made = await api.json<{ scene: Record<string, unknown>; share: Record<string, unknown> }>(
          "POST",
          "/api/photos/scene",
          { body: { fit, name, order, path, seconds } },
        );
        const installed = await installSceneOnFrame(ctx, {
          activate,
          frame_id,
          name: typeof made.scene.name === "string" ? made.scene.name : undefined,
          scenes: [made.scene],
        });
        if (installed.isError) {
          return installed;
        }
        const first = installed.content[0];
        const result = first?.type === "text" ? (JSON.parse(first.text) as Record<string, unknown>) : {};
        return text({ share: made.share, ...result });
      }),
  );
}
