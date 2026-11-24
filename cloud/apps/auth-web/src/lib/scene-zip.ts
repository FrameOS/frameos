import { unzipBounded } from "./zip-bounded";

// The one reader of a template interchange zip ({name}/template.json +
// scenes.json + image.jpg). Every check and every reader goes through it, so
// the scenes.json that was validated at publish is the scenes.json a frame is
// sent, the store shows, the renderer draws and the AI reads. Before this
// there were two rules (the scenes.json beside the shallowest template.json
// for the checks, the shallowest scenes.json anywhere for the readers), and a
// zip that held one of each had its tags, its needs and its refusals read off
// a file no frame ever ran.
//
// The rule: the shallowest template.json (by path depth, then by name) names
// the folder, and scenes.json and image.jpg are the files beside it. Nothing
// else in the zip is read. `templateJsonCount` and `scenesJsonCount` are how
// many entries of each name the zip lists, at any depth and the same path
// twice included: validateSceneZip refuses more than one of either, so a new
// upload holds nothing to be mistaken about. A zip stored before that check
// keeps working, read by this rule.
//
// A zip with no template.json at all was never stored through the store's
// doors (validateSceneZip has always asked for one), so there is no checked
// file for a reader to stray from: readSceneZipScenes still reads such a zip
// when it holds exactly one scenes.json, and nothing when it holds more.

export type SceneZipFiles = {
  /** "" at the root, else "{name}/". */
  folder: string;
  image: Uint8Array | undefined;
  manifest: Uint8Array;
  manifestPath: string;
  scenes: Uint8Array | undefined;
  scenesJsonCount: number;
  templateJsonCount: number;
};

const sceneZipEntry = /(^|\/)(template\.json|scenes\.json|image\.jpg)$/;

function depth(path: string) {
  return path.split("/").length - 1;
}

/**
 * The three files of a template zip, by the rule above; undefined when the
 * zip has no template.json. `image: false` leaves the cover uninflated.
 * Throws what unzipBounded throws (a malformed zip, a bound exceeded).
 */
export function readSceneZip(
  content: Uint8Array,
  options: { image?: boolean } = {},
): SceneZipFiles | undefined {
  const wantImage = options.image !== false;
  let templateJsonCount = 0;
  let scenesJsonCount = 0;
  const files = unzipBounded(new Uint8Array(content), (name) => {
    const kind = sceneZipEntry.exec(name)?.[2];
    if (kind === "template.json") {
      templateJsonCount += 1;
    } else if (kind === "scenes.json") {
      scenesJsonCount += 1;
    }
    return kind !== undefined && (wantImage || kind !== "image.jpg");
  });
  const manifestPath = Object.keys(files)
    .filter((name) => /(^|\/)template\.json$/.test(name))
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))[0];
  const manifest = manifestPath ? files[manifestPath] : undefined;
  if (!manifestPath || !manifest) {
    return undefined;
  }
  const folder = manifestPath.slice(0, manifestPath.length - "template.json".length);
  return {
    folder,
    image: files[`${folder}image.jpg`],
    manifest,
    manifestPath,
    scenes: files[`${folder}scenes.json`],
    scenesJsonCount,
    templateJsonCount,
  };
}

/** How deep the zip's template.json sits: 0 at the root, 1 one folder down. */
export function sceneZipManifestDepth(files: SceneZipFiles): number {
  return depth(files.manifestPath);
}

/**
 * The scenes.json of a stored template zip, parsed, with its size in bytes
 * (what bounds an assembled payload before it is serialized again);
 * undefined when the zip has none or it is no array. The zip was validated
 * when it was stored; anything unexpected is "no scenes", never thrown.
 */
export function readSceneZipScenes(content: Uint8Array): { bytes: number; scenes: unknown[] } | undefined {
  try {
    const files = readSceneZip(content, { image: false });
    const raw = files ? files.scenes : onlyScenesJson(content);
    if (!raw) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(Buffer.from(raw).toString("utf8"));
    return Array.isArray(parsed) ? { bytes: raw.length, scenes: parsed } : undefined;
  } catch {
    return undefined;
  }
}

// The scenes.json of a zip that has no template.json: its only one, or none
// when it holds several (see the top of this file).
function onlyScenesJson(content: Uint8Array): Uint8Array | undefined {
  let count = 0;
  const files = unzipBounded(new Uint8Array(content), (name) => {
    const found = /(^|\/)scenes\.json$/.test(name);
    count += found ? 1 : 0;
    return found;
  });
  return count === 1 ? Object.values(files)[0] : undefined;
}
