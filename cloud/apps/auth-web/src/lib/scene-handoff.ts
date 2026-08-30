// Handing unsaved scenes from one page to another in the same tab — the
// converter's "Open in the editor" — through sessionStorage: the JSON can
// be megabytes (a URL cannot carry it), it must survive a sign-in round
// trip (the editor page is public when reached this way, but Save needs an
// account), and it must never reach a server (nothing is stored). Read once,
// then removed. Every access is guarded: storage can be missing (opaque
// origins, private windows) and the page still has to render.

export const convertedScenesHandoffKey = "frameos:converted-scenes";

export function storeHandoffScenes(key: string, scenes: unknown[]): boolean {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(scenes));
    return true;
  } catch {
    return false;
  }
}

/** The scenes stored under `key`, removed on read; null when there are none. */
export function takeHandoffScenes(key: string): Record<string, unknown>[] | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) {
      return null;
    }
    window.sessionStorage.removeItem(key);
    const parsed: unknown = JSON.parse(raw);
    const scenes = (Array.isArray(parsed) ? parsed : []).filter(
      (scene): scene is Record<string, unknown> => Boolean(scene) && typeof scene === "object" && !Array.isArray(scene),
    );
    return scenes.length > 0 ? scenes : null;
  } catch {
    return null;
  }
}
