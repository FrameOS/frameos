import {
  parseAppConfig,
  sceneAccess,
  withAppPermissions,
} from "../../../../../frontend/src/utils/sceneAccess";

// What a scene asks to be allowed, for the code editor's save
// (docs/code-editor.md "The plane"): the `permissions` and `settings` its
// apps' config.json declare. A scene saved from the frame's own screen may
// not ask for more than the frame's saved scene of that id already asked
// for, and a new one for none of the red permissions and no settings keys:
// what a device asks must never widen a grant (docs/cloud-frames.md "Scenes
// the frame already had"). The owner installs such a scene from the
// workspace, where grants are made.
//
// config.json is read as every reader reads it (parseAppConfig,
// docs/app-config-fixtures.json): anything that is not a string in a list is
// skipped, and a file that is not strict JSON is no config. Such an app does
// not read as asking for nothing: the SPA's reading below counts it as asking
// for everything a JavaScript app can be given (a frame from before the
// strict reader may give it that), so it widens whatever it is compared
// with. An app with JavaScript and no list at all gets the list its code
// calls for first (withAppPermissions, the stamp every push puts on such an
// app), so leaving the list out is not a way past the check. The built-in
// apps a scene's nodes run count too, through the SPA's own reading
// (sceneAccess). And an app whose code calls `frameos.storeAction` counts as
// asking for "store" whatever its list says: a frame from before the
// permission (STORE_PERMISSION_FROM) runs that call for any app, and a list
// the push wrote for such a frame leaves the name out (scene-origin.ts).

/** The permissions that reach past the frame's own data: a new scene saved
 * from the frame may ask for none of them, and a frame installs or previews
 * no store scene that asks for one (panel-scenes.ts). */
export const redScenePermissions: readonly string[] = ["shell", "files", "assets-write", "frame", "code", "store"];

export type DeclaredSceneGrants = {
  /** config.json `permissions`, every app's, sorted. */
  permissions: string[];
  /** config.json `settings` (the settings namespaces it reads: API keys), sorted. */
  settings: string[];
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

// config.json as a string (the usual form) or already an object.
function appConfig(sources: unknown): Record<string, unknown> | null {
  const config = record(sources)?.["config.json"];
  return typeof config === "string" ? parseAppConfig(config) : record(config);
}

// Every app's sources a scene carries: the scene's apps, and an app node's
// own inline sources.
function appSourcesOf(scene: Record<string, unknown>): unknown[] {
  const found: unknown[] = Object.values(record(scene.apps) ?? {}).map((app) => record(app)?.sources);
  for (const node of Array.isArray(scene.nodes) ? scene.nodes : []) {
    const nodeRecord = record(node);
    if (nodeRecord?.type === "app") {
      found.push(record(nodeRecord.data)?.sources);
    }
  }
  return found.filter((sources) => record(sources) !== null);
}

/** The permissions and settings keys one scene asks for. */
export function declaredSceneGrants(scene: unknown): DeclaredSceneGrants {
  const filled = record(withAppPermissions(scene, { onlyMissing: true }));
  const permissions = new Set<string>();
  const settings = new Set<string>();
  if (filled) {
    for (const sources of appSourcesOf(filled)) {
      const config = appConfig(sources);
      strings(config?.permissions).forEach((permission) => permissions.add(permission));
      strings(config?.settings).forEach((key) => settings.add(key));
    }
    const access = sceneAccess(filled);
    for (const flag of access.flags) {
      if (flag.startsWith("key:")) {
        settings.add(flag.slice("key:".length));
      } else {
        permissions.add(flag);
      }
    }
    if (access.apps.some((app) => app.detected.includes("store"))) {
      permissions.add("store");
    }
  }
  return { permissions: [...permissions].sort(), settings: [...settings].sort() };
}

/**
 * What `after` asks for beyond `before` (the frame's saved scene of that id;
 * null for a new scene, which may ask for no red permission and no settings
 * key). Permissions by name, settings keys as `key:<namespace>` (the SPA's
 * access flags, sceneAccess.ts). Empty: the save widens nothing.
 */
export function grantsWidenedBy(before: DeclaredSceneGrants | null, after: DeclaredSceneGrants): string[] {
  // `files` reads everything `assets` does (sceneAccess.ts).
  const held = (permission: string) =>
    before !== null &&
    (before.permissions.includes(permission) || (permission === "assets" && before.permissions.includes("files")));
  const permissions = before
    ? after.permissions.filter((permission) => !held(permission))
    : after.permissions.filter((permission) => redScenePermissions.includes(permission));
  const settings = before ? after.settings.filter((key) => !before.settings.includes(key)) : after.settings;
  return [...permissions, ...settings.map((key) => `key:${key}`)];
}

/**
 * The red permissions `grants` asks for: what a store scene put on a frame
 * from the frame's own screen, in no saved scene's place, may ask for none
 * of (the owner installs such a scene from the workspace, where its tags
 * show). Settings keys are not counted: a panel install grants none.
 */
export function redPermissionsAsked(grants: DeclaredSceneGrants | null): string[] {
  return (grants?.permissions ?? []).filter((permission) => redScenePermissions.includes(permission));
}
