// The visibility groups of the unfiltered "My scenes" list, in display
// order: what the world sees first, then what only the owner sees. Groups
// without scenes are skipped.
//
// A plain module on purpose: the server page (app/my-scenes/page.tsx) groups
// its table with this, and MyScenesView ("use client") groups its grid.
// When this lived in the client module, Next refused the server's call
// ("Attempted to call groupMyScenes() from the server but groupMyScenes is
// on the client") and every visit to /my-scenes was a 500 in production —
// renderToStaticMarkup in the integration test never enforces the boundary.
export const myScenesGroups = [
  { key: "public", title: "Public scenes" },
  { key: "private", title: "Private scenes" },
] as const;

export type MyScenesGroupKey = (typeof myScenesGroups)[number]["key"];

export function groupMyScenes<T extends { visibility: string }>(scenes: T[]) {
  return myScenesGroups
    .map((group) => ({
      ...group,
      scenes: scenes.filter((scene) =>
        group.key === "public"
          ? scene.visibility === "public"
          : scene.visibility !== "public",
      ),
    }))
    .filter((group) => group.scenes.length > 0);
}
