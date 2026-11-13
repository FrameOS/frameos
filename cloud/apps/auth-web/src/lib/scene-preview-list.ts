// What a preview push sends a frame (docs/scene-previews.md "What a preview
// is"): the frame's own scene list with the previewed scenes in it, a preview
// scene in place of the listed scene of its id and the others after the list.
//
// Sent alone, the preview's scenes replaced the frame's set: an ESP32's patch
// named only them, so every other scene went, and an Activate while the
// preview stood had to send the whole list again. With the list, an ESP32 is
// sent the previewed scenes alone (scenes-patch.ts), and the Install or
// Discard after it changes one scene. The backend serves the same shape
// (frame_commands.previewed_scenes).

function sceneIdOf(scene: unknown): string | null {
  if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
    return null;
  }
  const id = (scene as Record<string, unknown>).id;
  return typeof id === "string" && id ? id : null;
}

export function sceneListWithPreview(list: readonly unknown[], preview: readonly unknown[]): unknown[] {
  const previewById = new Map<string, unknown>();
  for (const scene of preview) {
    const id = sceneIdOf(scene);
    if (id !== null) previewById.set(id, scene);
  }
  const merged = list.map((scene) => {
    const id = sceneIdOf(scene);
    if (id === null || !previewById.has(id)) return scene;
    const replaced = previewById.get(id);
    previewById.delete(id);
    return replaced;
  });
  return [...merged, ...preview.filter((scene) => {
    const id = sceneIdOf(scene);
    return id !== null && previewById.has(id);
  })];
}
