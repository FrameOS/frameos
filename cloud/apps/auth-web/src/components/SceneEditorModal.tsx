"use client";

import { sceneLayoutProblemText } from "../../../../../frontend/src/utils/sceneLayoutRule";
import type {
  EmbeddedSceneEditorApi,
  TemplateCategoryOption,
} from "frameos-editor/react";
import {
  FileArchive,
  GitFork,
  LogIn,
  MonitorDown,
  Save,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
} from "react";
import { storeCategories } from "../lib/categories";
import { applyAiScenes, type AiScenesEvent, type SceneJson } from "../../../../../frontend/src/sceneWorkspace/lib/ai-scenes-apply";
import type { AiListingChanges } from "../../../../../frontend/src/sceneWorkspace/lib/ai-chat-client";
import { requiredSettingsForScenes } from "../../../../../frontend/src/sceneWorkspace/lib/preview-settings";
import { clearSceneDraft, readSceneDraft, writeSceneDraft } from "../lib/scene-draft";
import { storeEmbedReadyMessage } from "../lib/store-embed";
import { ownerActionErrorMessage } from "./ownerActionError";
import {
  defaultSceneEditorPanels,
  sceneEditorHashFor,
  sceneEditorPanelsForHash,
  singlePanelFor,
  type SceneEditorPanelName,
  type SceneEditorPanels,
} from "../../../../../frontend/src/sceneWorkspace/lib/scene-views";
import {
  type RenderedScenes,
} from "../../../../../frontend/src/sceneWorkspace/SceneAiPanel";
import {
  SceneInfoPanel,
  type SceneInfoData,
  type SceneListingData,
} from "./SceneInfoPanel";
import { SceneInstallDialog } from "./SceneInstallDialog";
import { SceneSaveDialog } from "./SceneSaveDialog";
import { SceneVersionsDialog } from "./SceneVersionsDialog";
import {
  type SceneEditorAction,
  SceneEditorBackButton,
  SceneEditorBar,
  SceneEditorEmptyState,
  type SceneEditorPanelAvailability,
  SceneEditorPanelToggles,
  SceneNameTitle,
  UnsavedPill,
  constrainPanels,
  readDocumentTheme,
  readStoredPanels,
  sceneNameFor,
  shownPanels,
  storePanels,
  togglePanelIn,
  useSinglePanelMode,
  SceneEditorWorkspace as SharedSceneEditorWorkspace,
} from "../../../../../frontend/src/sceneWorkspace/SceneEditorWorkspace";
import { setSceneWorkspaceHost } from "../../../../../frontend/src/sceneWorkspace/lib/host";
import posthog from "posthog-js";
import type { ComponentProps } from "react";

// The FrameOS scene editor as a plain React component in this app's tree
// (react/react-dom are externalized in its bundle — one React). It is
// browser-only (kea, Monaco, wasm), hence the ssr: false dynamic import.
const EmbeddedSceneEditor = dynamic(
  () => import("frameos-editor/react").then((module) => module.EmbeddedSceneEditor),
  { ssr: false },
);

/** One published version of the scene, as the bar's version dropdown
 * lists it. */
export type SceneVersionOption = {
  version: number;
  /** ISO timestamp (serialisable from the server component). */
  createdAt: string;
  /** The publisher's "what changed" note, null without one. */
  message: string | null;
  /** ISO timestamp when unpublished (yanked), null otherwise. */
  yankedAt: string | null;
};

type SceneEditorModalProps = {
  sceneId: string;
  width?: number | null;
  height?: number | null;
  /** Store listing description, shown in the editor's Scene settings panel
   * (scenes.json itself doesn't carry one). */
  description?: string | null;
  /** Owner-only: offer "Save as new version". Everyone else gets the diagram
   * as an explorable playground — edits stay in the browser. */
  canSave?: boolean;
  /** Signed-in users can fork: save the (edited) scenes as a new private
   * scene under their own account. */
  canFork?: boolean;
  /** Whether the AI panel is on offer (active scenes only). It is available
   * to everyone; signed-out visitors see the sign-in prompt inside it. */
  canRemix?: boolean;
  /** Whether the Preview panel is on offer; pulled scenes don't get one. */
  canPreview?: boolean;
  signedIn?: boolean;
  /** The account switched AI features off; the panel says so before the first
   * turn rather than after it fails. */
  aiDisabled?: boolean;
  /** Where to turn AI back on (the account's AI usage page). */
  aiSettingsUrl?: string;
  /** The frames workspace, where the AI's links to frames and scenes go. */
  framesUrl?: string;
  /** Share token for private scenes, so shared visitors can load scenes.json. */
  share?: string | undefined;
  /** The store zip of the scene as the page shows it (its "Download zip"
   * link: pinned version and share token included), offered in the bar. */
  downloadUrl?: string | undefined;
  /** Where the OpenAI key is set (the fleet workspace's settings page). */
  settingsUrl?: string | undefined;
  /** The sign-in page; the AI panel and the Install dialog append
   * `return_to`. */
  loginUrl?: string | undefined;
  /** The account creation page (the Install dialog's invite). */
  signupUrl?: string | undefined;
  /** The scene's published versions, for the bar's version dropdown. */
  versions?: SceneVersionOption[] | undefined;
  /** The version the page is pinned to via ?version=N (not the latest):
   * the workspace then loads it rather than the latest. */
  pinnedVersion?: number | null | undefined;
  /** What the scene page shows besides the diagram (gallery, description,
   * versions, install instructions…), shown as the editor's template.json.
   * Without it template.json is the editor's own read-only form. */
  info?: SceneInfoData | undefined;
  /** Where Back goes when there is no same-origin page to go back to: the
   * store front. */
  backUrl?: string | undefined;
  /** The workspace inside another site's page (`/s/<slug>?embed=1`, on
   * frameos.net's front page). */
  embed?: SceneEditorEmbed | undefined;
};

/** An embedded workspace: Editor and Preview, opened on `file` with the
 * preview on `device` and `memory`, nothing read from this browser (panels,
 * drafts, preview settings), so every visitor starts on the same view. The
 * bar is the store's own, but what needs the whole page (AI, another version,
 * Sign in, Fork, Install, Download) opens the scene's page in the whole
 * window, out of the frame, with the visitor's edits as a draft there; Back
 * goes to the store's front page. */
export type SceneEditorEmbed = {
  /** The scene's page on the store. */
  pageUrl: string;
  /** The store's front page: where Back goes, as it does from the scene's
   * page. */
  storeUrl?: string | undefined;
  /** An app file to open on (`app.tsx`). */
  file?: string | undefined;
  /** The preview's Device menu entry (`sensecap-indicator`). */
  device?: string | undefined;
  /** The preview's Memory limit board (`esp32`). */
  memory?: string | undefined;
};

// The workspace (bar, panel toggles, columns, AI and preview panels) is
// shared with a self-hosted backend's scene page: frontend/src/sceneWorkspace.
// This module keeps what is the store's: the scene page's modal (versions,
// install, fork, save), the editor bundle and its stylesheet, the categories.
export * from "../../../../../frontend/src/sceneWorkspace/SceneEditorWorkspace";

// The cloud's analytics, for the shared panels' events.
setSceneWorkspaceHost({ track: (event, properties) => posthog.capture(event, properties) });

export type { EmbeddedSceneEditorApi, SceneJson };

/** Why the scene the editor shows cannot be a layout, null when it can. */
export function sceneLayoutProblemFor(scenes: SceneJson[] | null, sceneId: string | null): string | null {
  const scene = scenes?.find((candidate) => candidate.id === sceneId) ?? scenes?.[0];
  return scene ? sceneLayoutProblemText(scene) : null;
}

/** Whether the scene the editor shows is a layout (null: no such scene yet). */
export function sceneIsLayoutFor(scenes: SceneJson[] | null, sceneId: string | null): boolean | null {
  const scene = scenes?.find((candidate) => candidate.id === sceneId) ?? scenes?.[0];
  return scene ? (scene.settings as { isLayout?: unknown } | undefined)?.isLayout === true : null;
}

// The editor's assets (Monaco workers, wasm preview runtime, stylesheet) are
// copied to /frameos-editor by scripts/copy-editor-assets.mjs; the bundle
// resolves them against this path.
const EDITOR_ASSET_PATH = "/frameos-editor";

if (typeof window !== "undefined") {
  const anyWindow = window as unknown as Record<string, unknown>;
  const config = (anyWindow.FRAMEOS_APP_CONFIG = anyWindow.FRAMEOS_APP_CONFIG || {}) as Record<string, unknown>;
  config.ingress_path = EDITOR_ASSET_PATH;
}

// The editor's stylesheet is global (tailwind preflight included), so it is
// only linked while the full-screen editor is open and removed on close.
export function useEditorStylesheet(open: boolean) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `${EDITOR_ASSET_PATH}/static/lib.css`;
    document.head.appendChild(link);
    const html = document.documentElement;
    const previousTheme = html.dataset.frameosTheme;
    html.dataset.frameosTheme = html.classList.contains("theme-dark") ? "dark" : "light";
    return () => {
      link.remove();
      if (previousTheme === undefined) {
        delete html.dataset.frameosTheme;
      } else {
        html.dataset.frameosTheme = previousTheme;
      }
    };
  }, [open]);
}

/** The store's categories as template.json's Category field offers them. */
export const templateCategoryOptions: TemplateCategoryOption[] = storeCategories.map((category) => ({
  label: category.title,
  value: category.slug,
}));

/** The shared workspace with the store's editor column (frameos-editor/react)
 * and the store's categories in template.json. */
export function SceneEditorWorkspace(
  props: Omit<ComponentProps<typeof SharedSceneEditorWorkspace>, "Editor" | "templateCategories">,
) {
  return (
    <SharedSceneEditorWorkspace
      {...props}
      Editor={EmbeddedSceneEditor}
      templateCategories={templateCategoryOptions}
    />
  );
}

type NavigationApi = {
  currentEntry?: { index: number } | null;
  entries(): { url: string | null }[];
};

// Whether the browser has a page to go back to: a self-hosted backend's
// scene library links here too, and its back should land there, not on the
// store front. (A back is only ever to where this tab has been.)
function canGoBack(): boolean {
  const navigation = (window as unknown as { navigation?: NavigationApi }).navigation;
  if (navigation?.currentEntry) {
    return navigation.currentEntry.index > 0;
  }
  return window.history.length > 1;
}

/** The listing the page recorded for a version (null: the latest) — the
 * version's own, or the latest's for versions published before listings
 * were recorded; nothing without a page. */
function listingOfVersion(info: SceneInfoData | undefined, version: number | null): SceneListingData {
  const recorded = version === null ? undefined : info?.versions.find((entry) => entry.version === version);
  const source = recorded?.listing ?? info?.scene;
  return {
    category: source?.category ?? null,
    description: source?.description ?? null,
    frameosVersion: source?.frameosVersion ?? null,
    tags: source?.tags ?? [],
  };
}

function imagesOfVersion(info: SceneInfoData | undefined, version: number | null): string[] {
  const recorded = version === null ? undefined : info?.versions.find((entry) => entry.version === version);
  return recorded?.images ?? info?.images ?? [];
}

/** The scenes.json URL for a version (null: the newest published one). */
function scenesJsonUrl(sceneId: string, version: number | null, share: string | undefined): string {
  const params = new URLSearchParams();
  if (version !== null) {
    params.set("version", String(version));
  }
  if (share) {
    params.set("share", share);
  }
  const query = params.toString();
  return `/api/store/scenes/${sceneId}/scenes.json${query ? `?${query}` : ""}`;
}

/** A URL of ours with its `version` query set (or, for null, removed):
 * the page's `?version=N` and the zip link follow the loaded version. */
export function withVersionParam(url: string, version: number | null): string {
  const parsed = new URL(url, "http://frameos.invalid");
  if (version === null) {
    parsed.searchParams.delete("version");
  } else {
    parsed.searchParams.set("version", String(version));
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** How much of a version's message the dropdown shows before it is cut;
 * the whole note is in the Versions dialog. */
const versionMessagePreviewLength = 40;

/** The dropdown's label for a version: "v3 (latest)", "v2 (unpublished)",
 * "v1" — each followed by its "what changed" note when it has one. */
export function versionOptionLabel(option: SceneVersionOption, latestVersion: number | null): string {
  const label = option.yankedAt
    ? `v${option.version} (unpublished)`
    : option.version === latestVersion
      ? `v${option.version} (latest)`
      : `v${option.version}`;
  if (!option.message) {
    return label;
  }
  const message =
    option.message.length > versionMessagePreviewLength
      ? `${option.message.slice(0, versionMessagePreviewLength).trimEnd()}…`
      : option.message;
  return `${label} — ${message}`;
}

const manageVersionsValue = "manage";

// The store scene page's workspace: the FrameOS editor (its template.json
// is the scene page's info) rendered as a component in this page's React tree, the AI panel
// and the live preview, toggled from the bar. The bar's version dropdown
// loads any published version into the whole workspace (the diagram, the
// preview, the AI all see it). Saving publishes the edited scenes as a new
// immutable version; the Preview panel runs the editor's unsaved state;
// the AI panel edits the same scenes; Save / Fork then do the rest.
export function SceneEditorModal({
  sceneId,
  width,
  height,
  description,
  canSave = false,
  canFork = false,
  canRemix = true,
  canPreview = true,
  signedIn = canFork,
  aiDisabled = false,
  aiSettingsUrl,
  framesUrl,
  share,
  downloadUrl,
  settingsUrl,
  loginUrl = "/login",
  signupUrl = "/signup",
  versions,
  pinnedVersion = null,
  info,
  backUrl = "/",
  embed,
}: SceneEditorModalProps) {
  const router = useRouter();
  // null until mounted: the URL hash and the browser's memory decide the
  // panel set, and the server render sees neither.
  const [panels, setPanels] = useState<SceneEditorPanels | null>(null);
  // A narrow viewport shows one panel of the set at a time: the last one
  // picked there (this session's, not remembered), else singlePanelFor's.
  const narrow = useSinglePanelMode();
  const [activePanel, setActivePanel] = useState<SceneEditorPanelName | null>(null);
  // Newest first; the latest is the newest published (not unpublished) one
  // — or the one a save here just published, until the page's list has it.
  const versionList = [...(versions ?? [])].sort((a, b) => b.version - a.version);
  const [publishedVersion, setPublishedVersion] = useState<number | null>(null);
  const listedLatest = versionList.find((option) => !option.yankedAt)?.version ?? info?.scene.latestVersion ?? null;
  const latestVersion =
    publishedVersion !== null && (listedLatest === null || publishedVersion > listedLatest)
      ? publishedVersion
      : listedLatest;
  // The version the workspace holds (its scenes are what the editor got):
  // the page's pinned one, else the latest. null: no versions are known.
  const [selectedVersion, setSelectedVersion] = useState<number | null>(pinnedVersion ?? latestVersion);
  const [versionsOpen, setVersionsOpen] = useState(false);
  // The Save dialog: open while it asks what changed, and what the version
  // it publishes carries as its note (kept so the dropdown can show the
  // just-published version with it, before the page's list catches up).
  const [saveOpen, setSaveOpen] = useState(false);
  const [publishedMessage, setPublishedMessage] = useState<string | null>(null);
  // What the Save dialog's message field starts with: the prompt behind the
  // AI panel's last change, which is usually exactly what changed.
  const [suggestedMessage, setSuggestedMessage] = useState<string | undefined>(undefined);
  const [initialPrompt, setInitialPrompt] = useState<string | undefined>(undefined);
  const [installOpen, setInstallOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [forking, setForking] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [scenes, setScenes] = useState<SceneJson[] | null>(null);
  // The draft's listing and image set, next to the scenes: what the Info
  // column shows and edits, what the AI reads, what Save publishes with
  // the diagram. Loaded from the page's data for the version in the
  // workspace; the initial refs are what "unchanged" means.
  const [listing, setListing] = useState<SceneListingData>(() =>
    listingOfVersion(info, pinnedVersion),
  );
  const [images, setImages] = useState<string[]>(() => imagesOfVersion(info, pinnedVersion));
  const initialListingRef = useRef<string>(JSON.stringify(listing));
  const initialImagesRef = useRef<string>(JSON.stringify(images));
  const listingRef = useRef(listing);
  listingRef.current = listing;
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const listingDirty =
    JSON.stringify(listing) !== initialListingRef.current ||
    JSON.stringify(images) !== initialImagesRef.current;
  const anyDirty = dirty || listingDirty;
  // A draft from a previous visit was restored (see loadVersion): the bar
  // says so and offers to discard it.
  const [restoredDraft, setRestoredDraft] = useState(false);
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  // The selected scene's name, as the bar shows it; follows the editor's
  // edits (its own Rename included) and the scene tabs.
  const [sceneName, setSceneName] = useState<string | null>(null);
  // Layout or normal scene, as the Info column shows it; follows the same edits.
  const [sceneIsLayout, setSceneIsLayout] = useState<boolean | null>(null);
  const [sceneLayoutProblem, setSceneLayoutProblem] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  // The editor's latest scenes as state, for the Preview panel; only kept
  // up to date while that panel is open (each update re-renders the page).
  const [previewScenes, setPreviewScenes] = useState<SceneJson[] | null>(null);
  const latestScenesRef = useRef<SceneJson[] | null>(null);
  const editorApiRef = useRef<EmbeddedSceneEditorApi | null>(null);
  const selectedSceneIdRef = useRef<string | null>(null);
  const initialJsonRef = useRef<string>("");
  // The editor echoes the scenes it was handed (normalised: defaults filled
  // in, positions settled) as its first onScenesChanged; that echo, not the
  // raw scenes.json, is what "unchanged" means for the dirty check.
  const baselinePendingRef = useRef(false);
  const panelsRef = useRef(panels);
  panelsRef.current = panels;
  selectedSceneIdRef.current = selectedSceneId;
  const selectedVersionRef = useRef(selectedVersion);
  selectedVersionRef.current = selectedVersion;
  const latestVersionRef = useRef(latestVersion);
  latestVersionRef.current = latestVersion;
  const available: SceneEditorPanelAvailability = {
    ai: canRemix,
    preview: canPreview,
  };
  const embedRef = useRef(embed);
  embedRef.current = embed;
  // Embedded: tell the page framing the workspace that its scene is in, so
  // it can swap its stand-in for it (nothing secret: the message is a type).
  const embedded = embed !== undefined;
  useEffect(() => {
    if (embedded && scenes && window.parent !== window) {
      window.parent.postMessage({ type: storeEmbedReadyMessage }, "*");
    }
  }, [embedded, scenes]);
  const availableRef = useRef(available);
  availableRef.current = available;
  useEditorStylesheet(true);

  // The editor's current scenes, wherever they come from (the initial load,
  // the editor's edits, the AI): the source of truth for Save / Fork / AI
  // and, while it is open, the Preview panel.
  function publishScenes(next: SceneJson[] | null) {
    latestScenesRef.current = next;
    setSceneName(sceneNameFor(next, selectedSceneIdRef.current));
    setSceneIsLayout(sceneIsLayoutFor(next, selectedSceneIdRef.current));
    setSceneLayoutProblem(sceneLayoutProblemFor(next, selectedSceneIdRef.current));
    if (panelsRef.current?.preview || next === null) {
      setPreviewScenes(next);
    }
  }

  function selectScene(nextSceneId: string | null) {
    selectedSceneIdRef.current = nextSceneId;
    setSelectedSceneId(nextSceneId);
    setSceneName(sceneNameFor(latestScenesRef.current, nextSceneId));
    setSceneIsLayout(sceneIsLayoutFor(latestScenesRef.current, nextSceneId));
    setSceneLayoutProblem(sceneLayoutProblemFor(latestScenesRef.current, nextSceneId));
  }

  // Every edit lands in localStorage (debounced) so a navigation away — a
  // tag click, Back, a closed tab — does not lose it; loadVersion restores
  // it on the next visit. Editing back to the published state (or saving)
  // clears the draft instead.
  const draftTimerRef = useRef<number | null>(null);
  function persistDraftNow(force = false) {
    draftTimerRef.current = null;
    // Embedded, an edit is kept only when the visitor takes it to the
    // scene's page (breakOut).
    if (embedRef.current && !force) {
      return;
    }
    const latest = latestScenesRef.current;
    if (!latest || latest.length === 0) {
      return;
    }
    const scenesDirty = JSON.stringify(latest) !== initialJsonRef.current;
    const listingDirtyNow =
      JSON.stringify(listingRef.current) !== initialListingRef.current ||
      JSON.stringify(imagesRef.current) !== initialImagesRef.current;
    if (!scenesDirty && !listingDirtyNow) {
      // Edited back to the published state: the draft has nothing to keep.
      // A draft made on another version is not ours to clear, though.
      const existing = readSceneDraft(sceneId);
      if (existing && existing.baseVersion === selectedVersionRef.current) {
        clearSceneDraft(sceneId);
      }
      return;
    }
    writeSceneDraft(sceneId, {
      baseVersion: selectedVersionRef.current,
      images: imagesRef.current,
      listing: listingRef.current,
      savedAt: new Date().toISOString(),
      scenes: latest,
    });
  }
  function scheduleDraftPersist() {
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
    }
    draftTimerRef.current = window.setTimeout(persistDraftNow, 500);
  }
  // An edit still inside the debounce window must not be lost to the very
  // navigation the draft guards against: flushed when the workspace
  // unmounts (a client-side route change) and when the page itself goes
  // (a reload, a closed tab).
  const persistDraftNowRef = useRef(persistDraftNow);
  persistDraftNowRef.current = persistDraftNow;
  useEffect(() => {
    const flush = () => {
      if (draftTimerRef.current !== null) {
        window.clearTimeout(draftTimerRef.current);
        persistDraftNowRef.current();
      }
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  // The bar's pencil: rename the selected scene. Through the mounted editor
  // (its form updates in place, the diagram keeps its layout, and the edit
  // echoes back through onScenesChanged); before it has mounted, by handing
  // it the renamed scenes to start from.
  function renameScene(name: string) {
    const current = latestScenesRef.current;
    const targetId = selectedSceneIdRef.current ?? current?.[0]?.id ?? null;
    if (!current || targetId === null) {
      return;
    }
    const next = current.map((scene) => (scene.id === targetId ? { ...scene, name } : scene));
    publishScenes(next);
    setDirty(JSON.stringify(next) !== initialJsonRef.current);
    scheduleDraftPersist();
    if (editorApiRef.current) {
      editorApiRef.current.renameScene(targetId, name);
    } else {
      baselinePendingRef.current = false;
      setScenes(next);
    }
  }

  // The Info column's Type: the selected scene, a layout or a normal one.
  // The same road as a rename. A normal scene carries no flag, so switching
  // there and back leaves nothing to save.
  function changeSceneIsLayout(isLayout: boolean) {
    const current = latestScenesRef.current;
    const targetId = selectedSceneIdRef.current ?? current?.[0]?.id ?? null;
    if (!current || targetId === null) {
      return;
    }
    const next = current.map((scene) => {
      if (scene.id !== targetId) {
        return scene;
      }
      const { isLayout: _dropped, ...settings } = (scene.settings ?? {}) as Record<string, unknown>;
      return { ...scene, settings: isLayout ? { ...settings, isLayout: true } : settings };
    });
    publishScenes(next);
    setDirty(JSON.stringify(next) !== initialJsonRef.current);
    scheduleDraftPersist();
    if (editorApiRef.current) {
      editorApiRef.current.setSceneIsLayout(targetId, isLayout);
    } else {
      baselinePendingRef.current = false;
      setScenes(next);
    }
  }

  // Loads a published version's scenes (null: the newest published one)
  // into the whole workspace: the editor re-initialises on the new array,
  // the preview and the AI follow, and the unsaved state resets to it. A
  // later load supersedes an earlier one still in flight.
  const loadRequestRef = useRef(0);
  async function loadVersion(version: number | null) {
    const request = ++loadRequestRef.current;
    // A persist still on its debounce timer belongs to the state this load
    // replaces; firing after the baselines reset would write nonsense.
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    try {
      // The newest version's URL has no ?version=, and the route lets a
      // browser keep it for five minutes: a page opened just after a save
      // would label the previous version's scenes with the new number, and
      // an edit made there becomes a draft of the new version (#695). A
      // pinned version never changes, so only the newest skips the cache.
      const response = await fetch(
        scenesJsonUrl(sceneId, version, share),
        version === null ? { cache: "no-store" } : undefined,
      );
      if (!response.ok) {
        throw new Error(`Could not load the scene (${response.status})`);
      }
      const loaded = (await response.json()) as SceneJson[];
      if (request !== loadRequestRef.current) {
        return;
      }
      latestScenesRef.current = loaded;
      setPreviewScenes(loaded);
      initialJsonRef.current = JSON.stringify(loaded);
      baselinePendingRef.current = true;
      setScenes(loaded);
      setDirty(false);
      const loadedListing = listingOfVersion(info, version);
      const loadedImages = imagesOfVersion(info, version);
      initialListingRef.current = JSON.stringify(loadedListing);
      initialImagesRef.current = JSON.stringify(loadedImages);
      setListing(loadedListing);
      setImages(loadedImages);
      // Whatever the AI panel changed is gone with the edits.
      setSuggestedMessage(undefined);
      // A draft this browser left behind (a tag click, Back, a closed tab)
      // picks up where the edits stopped — but only on the version it was
      // made on; a version published since (or another one picked from the
      // dropdown) loads clean, with the draft kept for its own version.
      const draft = embedRef.current ? null : readSceneDraft(sceneId);
      if (draft && draft.baseVersion === (version ?? latestVersionRef.current)) {
        latestScenesRef.current = draft.scenes;
        setPreviewScenes(draft.scenes);
        // The published scenes.json stays the baseline: the draft is, by
        // definition, unsaved.
        baselinePendingRef.current = false;
        setScenes(draft.scenes);
        setDirty(true);
        setListing(draft.listing);
        setImages(draft.images);
        setRestoredDraft(true);
        const draftScene = draft.scenes.find((scene) => scene.default === true) ?? draft.scenes[0];
        selectScene(draftScene?.id ?? null);
        return;
      }
      setRestoredDraft(false);
      const defaultScene = loaded.find((scene) => scene.default === true) ?? loaded[0];
      selectScene(defaultScene?.id ?? null);
    } catch (err) {
      if (request === loadRequestRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  // The editor and the preview wear the page's theme, and follow it when it
  // changes (the embed's parent page switching between light and dark).
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readDocumentTheme()));
    observer.observe(document.documentElement, { attributeFilter: ["class"], attributes: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setTheme(readDocumentTheme());
    void loadVersion(pinnedVersion);
    return () => {
      // A remount (another scene) must not apply this one's load.
      loadRequestRef.current += 1;
    };
    // The scene and its pinned version are fixed for the page's life.
  }, [sceneId, share]);

  /** The page's `?version=N` follows the loaded version (none for the
   * latest), so a reload or a shared link opens the same one. */
  function syncVersionUrl(version: number | null) {
    const target = version === null || version === latestVersion ? null : version;
    window.history.replaceState(
      window.history.state,
      "",
      withVersionParam(`${window.location.pathname}${window.location.search}${window.location.hash}`, target),
    );
  }

  // The bar's version dropdown (or the versions dialog): load that version
  // into the workspace — after a word when it would discard unsaved edits.
  function selectVersion(version: number) {
    setVersionsOpen(false);
    if (version === selectedVersion) {
      return;
    }
    if (anyDirty && !window.confirm(`Discard your unsaved changes and load v${version}?`)) {
      return;
    }
    if (anyDirty) {
      // The user chose to discard: the browser's copy goes with the edits.
      clearSceneDraft(sceneId);
    }
    setError(null);
    setSelectedVersion(version);
    syncVersionUrl(version);
    void loadVersion(version);
  }

  // A screenshot the server registered (the preview panel's "Save to
  // images", the editor's render check): into the draft's image set, at
  // the end; Save publishes it.
  function addImage(sha256: string) {
    const current = imagesRef.current;
    if (!current.includes(sha256)) {
      setImages([...current, sha256]);
      scheduleDraftPersist();
    }
  }

  function setDraftImages(next: string[]) {
    setImages(next);
    scheduleDraftPersist();
  }

  function applyListingChanges(changes: Partial<SceneListingData>) {
    setListing({ ...listingRef.current, ...changes });
    scheduleDraftPersist();
  }

  // The AI edited the listing: same draft, same Save.
  function applyAiListing(changes: AiListingChanges) {
    const next: Partial<SceneListingData> = {};
    if (changes.description !== undefined) {
      next.description = changes.description;
    }
    if (changes.category !== undefined) {
      next.category = changes.category;
    }
    if (changes.frameosVersion !== undefined) {
      next.frameosVersion = changes.frameosVersion;
    }
    if (changes.tags !== undefined) {
      next.tags = changes.tags;
    }
    applyListingChanges(next);
  }

  // The editor captured a frame (its render check, or the JSON panel's
  // screenshot). Owners get it registered and added to the draft's images;
  // everyone else gets ok:false and the editor falls back to downloading
  // the PNG.
  async function saveScreenshot(dataUrl: string) {
    if (!canSave) {
      return { ok: false, error: "Only the scene owner can save to its images" };
    }
    if (!dataUrl.startsWith("data:image/png;base64,")) {
      return { ok: false, fallbackDownload: false, error: "Unexpected screenshot format" };
    }
    try {
      const upload = await fetch(`/api/account/scenes/${sceneId}/images`, {
        body: JSON.stringify({
          content_base64: dataUrl.slice("data:image/png;base64,".length),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await upload.json().catch(() => ({}));
      if (upload.ok && typeof payload.image?.sha256 === "string") {
        addImage(payload.image.sha256 as string);
      }
      return {
        ok: upload.ok,
        // The gallery upload failed for a real reason (quota, moderation,
        // ...): tell the user instead of silently downloading a file they
        // wanted stored.
        fallbackDownload: false,
        error: upload.ok ? undefined : `Saving failed: ${payload.error ?? upload.status}`,
      };
    } catch {
      return { ok: false, fallbackDownload: false, error: "Saving failed" };
    }
  }

  // The URL hash names the open panels; without one, the browser's memory
  // decides, then the default (Info + Editor + Preview). Back/forward and a
  // hand-edited hash are followed live. ?ai=<prompt> hands the AI panel its
  // first message (entry points link here with it); read once, on load.
  const promptReadRef = useRef(false);
  useEffect(() => {
    const sync = () => {
      if (embedRef.current) {
        // The same view for everyone: no hash, no remembered set.
        const next = constrainPanels(defaultSceneEditorPanels, availableRef.current);
        if (next.preview) {
          setPreviewScenes(latestScenesRef.current);
        }
        setPanels(next);
        return;
      }
      const hash = window.location.hash;
      const fromHash = sceneEditorPanelsForHash(hash);
      let next = constrainPanels(
        fromHash ?? readStoredPanels() ?? defaultSceneEditorPanels,
        availableRef.current,
      );
      if (!promptReadRef.current) {
        promptReadRef.current = true;
        const prompt = new URLSearchParams(window.location.search).get("ai")?.trim();
        if (prompt) {
          setInitialPrompt(prompt);
          next = constrainPanels({ ...next, ai: true }, availableRef.current);
        }
      }
      if (fromHash && sceneEditorHashFor(next) !== hash) {
        // An old spelling, or a panel this scene cannot show: keep the URL
        // on what is actually open.
        window.history.replaceState(window.history.state, "", sceneEditorHashFor(next));
      }
      if (next.preview) {
        setPreviewScenes(latestScenesRef.current);
      }
      setPanels(next);
    };
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    sync();
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);

  // Embedded: leave the frame for the scene's page in the whole window,
  // taking the visitor's edits along as the draft that page restores. Runs on
  // a click, so the frame may navigate the window
  // (allow-top-navigation-by-user-activation).
  function carryEditsOut() {
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
    }
    persistDraftNow(true);
  }
  function breakOut(url: string) {
    carryEditsOut();
    window.open(url, "_top");
  }
  /** The scene's page (the embed's own pageUrl), on another version or
   * with other panels open. */
  function fullPageUrl(options: { version?: number; hash?: string } = {}): string {
    const url = new URL(embed?.pageUrl ?? window.location.href);
    if (options.version !== undefined) {
      url.searchParams.set("version", String(options.version));
    }
    url.hash = options.hash ?? "";
    return url.toString();
  }

  function commitPanels(next: SceneEditorPanels) {
    setPanels(next);
    if (embedRef.current) {
      return;
    }
    storePanels(next);
    // Keep the URL truthful (a reload or a shared link reopens the same
    // view) without adding a history entry Back would have to step through.
    window.history.replaceState(window.history.state, "", sceneEditorHashFor(next));
  }

  // Single-panel mode: show this panel (a tab), adding it to the remembered
  // set when it was not in it — the set is what a wide viewport restores.
  function showSinglePanel(panel: SceneEditorPanelName) {
    if (!panels) {
      return;
    }
    setActivePanel(panel);
    if (panel === "preview") {
      setPreviewScenes(latestScenesRef.current);
    }
    if (!panels[panel]) {
      commitPanels({ ...panels, [panel]: true });
    }
  }

  function togglePanel(panel: SceneEditorPanelName) {
    if (!panels) {
      return;
    }
    if (embed && panel === "ai") {
      // The AI needs an account and the store's page: it opens there.
      breakOut(fullPageUrl({ hash: sceneEditorHashFor({ ...panels, ai: true }) }));
      return;
    }
    if (narrow) {
      showSinglePanel(panel);
      return;
    }
    const next = togglePanelIn(panels, panel);
    if (panel === "preview" && next.preview) {
      // Hand the panel what the editor holds right now; it follows edits
      // from here on (publishScenes).
      setPreviewScenes(latestScenesRef.current);
    }
    commitPanels(next);
  }

  // Back: to the page that led here (the store, My scenes, a publisher
  // page, a backend's scene library), else to the store front.
  function goBack() {
    if (canGoBack()) {
      window.history.back();
      return;
    }
    router.push(backUrl);
  }

  // "Show in preview" under a frame the AI rendered: open the Preview panel
  // on exactly those scenes (the editor may have moved on since), and put
  // the editor on the scene that was drawn.
  function showRenderInPreview({ sceneId: renderedSceneId, scenes: rendered }: RenderedScenes) {
    setPreviewScenes(rendered);
    if (rendered.some((scene) => scene.id === renderedSceneId)) {
      selectScene(renderedSceneId);
    }
    if (!panels) {
      return;
    }
    if (narrow) {
      setActivePanel("preview");
    }
    if (!panels.preview) {
      commitPanels(constrainPanels({ ...panels, preview: true }, available));
    }
  }

  // The AI delivered scenes: apply them with a NEW array identity (the
  // editor re-initialises on identity change), select the right one, and
  // let Save / Fork take it from there.
  function applyAiEvent(event: AiScenesEvent): string | null {
    setSuggestedMessage(event.title || undefined);
    const current = latestScenesRef.current ?? scenes ?? [];
    const result = applyAiScenes(current, event, selectedSceneIdRef.current);
    baselinePendingRef.current = false;
    selectedSceneIdRef.current = result.selectedSceneId;
    publishScenes(result.scenes);
    setScenes(result.scenes);
    setSelectedSceneId(result.selectedSceneId);
    setDirty(JSON.stringify(result.scenes) !== initialJsonRef.current);
    scheduleDraftPersist();
    return result.selectedSceneId;
  }

  async function forkAndSave() {
    const latest = latestScenesRef.current;
    if (!latest || latest.length === 0) {
      setError("Nothing to fork yet.");
      return;
    }
    if (
      !window.confirm(
        "Save these scenes (including your edits) as a new private scene in your account?",
      )
    ) {
      return;
    }
    setForking(true);
    setError(null);
    try {
      const response = await fetch(`/api/account/scenes/${sceneId}/fork`, {
        body: JSON.stringify({ scenes: latest }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(
          payload.error === "login_required"
            ? "Sign in to fork this scene."
            : ownerActionErrorMessage(payload, response.status, "Forking failed"),
        );
        return;
      }
      // The edits live in the fork now; a draft left on this scene would
      // restore them here a second time.
      clearSceneDraft(sceneId);
      // Jump to the fresh copy; its workspace opens on unsaved-free state.
      window.location.href = `/s/${payload.scene.slug}`;
    } finally {
      setForking(false);
    }
  }

  // The restored-draft pill's Discard: drop the browser's copy and reload
  // the published version the workspace holds.
  function discardDraft() {
    if (!window.confirm("Discard your unsaved changes and reload the published version?")) {
      return;
    }
    clearSceneDraft(sceneId);
    setRestoredDraft(false);
    setError(null);
    void loadVersion(selectedVersion === null || selectedVersion === latestVersion ? null : selectedVersion);
  }

  /** The bar's Save: the dialog asks what changed and publishes from there. */
  function openSave() {
    const latest = latestScenesRef.current;
    if (!latest || latest.length === 0) {
      setError("Nothing to save yet.");
      return;
    }
    setError(null);
    setSaveOpen(true);
  }

  async function save(message: string) {
    const latest = latestScenesRef.current;
    if (!latest || latest.length === 0) {
      setError("Nothing to save yet.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const draftListing = listingRef.current;
      const draftImages = imagesRef.current;
      const response = await fetch(`/api/account/scenes/${sceneId}/content`, {
        body: JSON.stringify({
          images: draftImages,
          listing: draftListing,
          message,
          scenes: latest,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(
          // The name and the note show on the public page, so both are
          // moderated; the note is the usual suspect, and a Save is where
          // the reader needs to know WHICH field to reword. On a public
          // scene the images newly in the set are checked too (`images`).
          payload.error === "content_rejected" && payload.images
            ? "An image was flagged by moderation. Remove it and save again."
            : payload.error === "content_rejected"
            ? "The scene's name, description, tags or your note was flagged by moderation — please reword it."
            : // Everything else is the shared store wording: a name clash
              // names the other scene, the private-scene quota and a pulled
              // scene say so — instead of the raw code this used to show.
              ownerActionErrorMessage(payload, response.status, "Saving failed"),
        );
        return;
      }
      setDirty(false);
      setSaveOpen(false);
      setSuggestedMessage(undefined);
      clearSceneDraft(sceneId);
      setRestoredDraft(false);
      initialJsonRef.current = JSON.stringify(latest);
      initialListingRef.current = JSON.stringify(draftListing);
      initialImagesRef.current = JSON.stringify(draftImages);
      // The workspace now holds the version just published: the latest.
      const published = typeof payload.scene?.version === "number" ? (payload.scene.version as number) : null;
      if (published !== null) {
        setPublishedVersion(published);
        setPublishedMessage(typeof payload.scene?.message === "string" ? (payload.scene.message as string) : null);
        setSelectedVersion(published);
      }
      syncVersionUrl(null);
      // The page's data (versions, the Info panel) catches up.
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  if (!panels) {
    return null;
  }

  // Owners get no hint: the bar's buttons say it. Visitors learn where a
  // remix ends up.
  const saveHint = canSave
    ? undefined
    : canFork
      ? "“Fork & save copy” saves your remix as a private scene in your account."
      : "Sign in to save a remix as a private scene in your account.";

  // What is on screen: the set, or in single-panel mode one of it.
  const shown = shownPanels(panels, narrow, activePanel);
  const single = narrow ? singlePanelFor(panels, activePanel) : undefined;
  // The scene's name (and its rename pencil) heads the bar.
  // while that column is closed does the bar carry it.
  const nameTitle = <SceneNameTitle name={sceneName} onRename={renameScene} />;
  // The version the workspace holds: a cloud install pins it when it is
  // not the latest, and the zip link downloads it.
  const installVersion =
    info && selectedVersion !== null && latestVersion !== null && selectedVersion !== latestVersion
      ? selectedVersion
      : null;
  const downloadHref =
    downloadUrl && selectedVersion !== null
      ? withVersionParam(downloadUrl, selectedVersion === latestVersion ? null : selectedVersion)
      : downloadUrl;
  // The dropdown lists the known versions — plus the one just published,
  // until the page's data catches up with it.
  const versionOptions =
    versionList.length > 0 && selectedVersion !== null && !versionList.some((option) => option.version === selectedVersion)
      ? [
          {
            createdAt: "",
            message: publishedMessage,
            version: selectedVersion,
            yankedAt: null,
          } satisfies SceneVersionOption,
          ...versionList,
        ]
      : versionList;

  const actions: SceneEditorAction[] = [];
  // A visitor with no way to keep an edit — no Save, no Fork — is signed
  // out: the bar says where saving lives instead of only that it doesn't.
  // `window.location` is safe here: the render stops at the `panels` guard
  // above until the browser has mounted.
  if (!signedIn && !canSave && !canFork) {
    const returnTo = `${window.location.origin}${window.location.pathname}${window.location.search}${window.location.hash}`;
    actions.push({
      Icon: LogIn,
      emphasized: true,
      href: `${loginUrl}${loginUrl.includes("?") ? "&" : "?"}return_to=${encodeURIComponent(returnTo)}`,
      key: "signin",
      label: "Sign in to edit",
      primary: true,
      title: "Sign in to save your edits as a scene of your own — and to use the AI assistant",
    });
  }
  if (canSave) {
    actions.push({
      Icon: Save,
      disabled: saving || !anyDirty,
      key: "save",
      label: saving ? "Saving…" : "Save as new version",
      onSelect: openSave,
      primary: true,
    });
  }
  if (canFork) {
    actions.push({
      Icon: GitFork,
      disabled: forking,
      key: "fork",
      label: forking ? "Forking…" : "Fork & save copy",
      onSelect: () => void forkAndSave(),
      primary: !canSave,
      title: "Save these scenes (including your edits) as a new private scene in your account",
    });
  }
  if (downloadHref) {
    actions.push({
      Icon: FileArchive,
      href: downloadHref,
      key: "download",
      label: "Download .zip",
      title: "Download the scene as a zip (the published version, not the editor's unsaved edits)",
    });
  }
  // Install sits at the far right: the end of the bar, and the end of the
  // overflow menu.
  if (info) {
    actions.push({
      Icon: MonitorDown,
      key: "install",
      label: "Install",
      onSelect: () => setInstallOpen(true),
      title: "Install this scene on a frame",
    });
  }

  // Embedded, the bar offers what the store's page does, but each opens that
  // page in the whole window (with the visitor's edits), where it can be done.
  const embedActions: SceneEditorAction[] = [];
  if (embed) {
    const pageUrl = fullPageUrl();
    embedActions.push(
      signedIn
        ? {
            Icon: GitFork,
            emphasized: true,
            href: pageUrl,
            key: "fork",
            label: "Fork & save copy",
            onSelect: carryEditsOut,
            primary: true,
            target: "_top",
            title: "Opens the scene's page, with your edits, to save them as a scene of your own",
          }
        : {
            Icon: LogIn,
            emphasized: true,
            href: `${loginUrl}${loginUrl.includes("?") ? "&" : "?"}return_to=${encodeURIComponent(pageUrl)}`,
            key: "signin",
            label: "Sign in to edit",
            onSelect: carryEditsOut,
            primary: true,
            target: "_top",
            title: "Sign in, then keep your edits as a scene of your own on the scene's page",
          },
    );
    if (downloadHref) {
      embedActions.push({
        Icon: FileArchive,
        href: downloadHref,
        key: "download",
        label: "Download .zip",
        target: "_top",
        title: "Download the scene as a zip (the published version, not your edits)",
      });
    }
    embedActions.push({
      Icon: MonitorDown,
      href: pageUrl,
      key: "install",
      label: "Install",
      onSelect: carryEditsOut,
      target: "_top",
      title: "Opens the scene's page, to install it on a frame",
    });
  }

  return (
    // ph-no-capture: the scene's own diagram, node labels and settings.
    <div className="editor-modal ph-no-capture">
      <SceneEditorBar
        actions={embed ? embedActions : actions}
        leading={
          restoredDraft ? (
            <span
              className="pill pill-warning editor-modal__unsaved"
              title="Your unsaved edits from your last visit were restored from this browser"
            >
              <span className="editor-modal__unsaved-long">Restored unsaved edits</span>
              <span className="editor-modal__unsaved-short">Restored</span>
              <button className="editor-modal__discard" onClick={discardDraft} type="button">
                Discard
              </button>
            </span>
          ) : (canSave || canFork) && anyDirty ? (
            <UnsavedPill label="Unsaved changes" short="Unsaved" />
          ) : null
        }
      >
        {embed ? (
          // Back, as from the scene's page: the store's front page, in the
          // whole window. Leaving the scene, the edits stay behind.
          <SceneEditorBackButton
            label="Back to the scene store"
            onClick={() => window.open(embed.storeUrl ?? fullPageUrl(), "_top")}
          />
        ) : (
          <SceneEditorBackButton label="Back" onClick={goBack} />
        )}
        <SceneEditorPanelToggles active={single} available={available} onToggle={togglePanel} panels={panels} />
        {versionOptions.length > 0 && selectedVersion !== null ? (
          <select
            aria-label="Version"
            className="input editor-modal__version-select"
            onChange={(event) => {
              if (embed) {
                // Another version, or its details: on the scene's page.
                const version = Number(event.target.value);
                breakOut(
                  event.target.value === manageVersionsValue || !Number.isFinite(version)
                    ? fullPageUrl()
                    : fullPageUrl({ version }),
                );
              } else if (event.target.value === manageVersionsValue) {
                setVersionsOpen(true);
              } else {
                selectVersion(Number(event.target.value));
              }
            }}
            title="The version loaded in the workspace — pick another to load it"
            value={String(selectedVersion)}
          >
            {versionOptions.map((option) => (
              <option key={option.version} value={String(option.version)}>
                {versionOptionLabel(option, latestVersion)}
              </option>
            ))}
            {info || embed ? (
              <>
                <option disabled>──────</option>
                <option value={manageVersionsValue}>{info?.isOwner ? "Manage versions…" : "Version details…"}</option>
              </>
            ) : null}
          </select>
        ) : null}
        {nameTitle}
        {!canSave ? (
          <span
            className="pill"
            title={
              embed
                ? "Explore and tweak freely; Sign in or Fork takes your edits to the scene's page"
                : signedIn
                  ? "Explore and tweak freely; “Fork & save copy” is how an edit becomes yours"
                  : "Explore and tweak freely; sign in to keep an edit"
            }
          >
            Playground — changes are not saved
          </span>
        ) : null}
        {error ? <span className="pill pill-warning">{error}</span> : null}
      </SceneEditorBar>
      <SceneEditorWorkspace
        onClosePanel={togglePanel}
        info={
          info ? (
            <SceneInfoPanel
              {...info}
              draft={
                canSave
                  ? {
                      images,
                      listing,
                      onImagesChange: setDraftImages,
                      onListingChange: applyListingChanges,
                      onIsLayoutChange: changeSceneIsLayout,
                    }
                  : undefined
              }
              isLayout={sceneIsLayout ?? undefined}
              layoutProblem={sceneLayoutProblem}
              heading={info.scene.name}
              shown={{ images, listing }}
            />
          ) : undefined
        }
        ai={{
          aiDisabled,
          ...(aiSettingsUrl ? { aiSettingsUrl } : {}),
          ...(framesUrl ? { framesUrl } : {}),
          getListing: () => listingRef.current,
          getScenes: () => latestScenesRef.current,
          initialPrompt,
          loginUrl,
          mode: "existing",
          onListing: applyAiListing,
          onScenes: applyAiEvent,
          ...(canPreview ? { onShowInPreview: showRenderInPreview } : {}),
          saveHint,
          settingsUrl,
          signedIn,
          storeSceneId: sceneId,
        }}
        description={listing.description ?? description ?? undefined}
        template={{
          category: listing.category,
          description: listing.description,
          frameosVersion: listing.frameosVersion,
          name: info?.scene.name ?? sceneName ?? "Untitled scene",
          tags: listing.tags,
        }}
        // Only the owner's draft is published; a visitor's template.json is
        // shown, not edited.
        onTemplateChanged={canSave ? applyListingChanges : undefined}
        editorApiRef={editorApiRef}
        height={height || 480}
        onSaveScreenshot={saveScreenshot}
        onScenesChanged={(nextScenes) => {
          publishScenes(nextScenes);
          const json = JSON.stringify(nextScenes);
          if (baselinePendingRef.current) {
            baselinePendingRef.current = false;
            initialJsonRef.current = json;
          }
          setDirty(json !== initialJsonRef.current);
          scheduleDraftPersist();
        }}
        // The editor reports null before its first init; there is nothing
        // to follow yet.
        onSelectedSceneChanged={(nextSceneId) => {
          if (nextSceneId !== null && nextSceneId !== selectedSceneIdRef.current) {
            selectScene(nextSceneId);
          }
        }}
        empty={
          <SceneEditorEmptyState
            available={available}
            name={sceneName ?? info?.scene.name ?? "Scene"}
            onToggle={togglePanel}
            panels={panels}
          />
        }
        panels={shown}
        preview={{
          canSaveToGallery: canSave,
          onImageRegistered: addImage,
          sceneId,
          scenes: previewScenes,
          settingsUrl,
          initialDevice: embed?.device,
          initialMemoryDevice: embed?.memory,
          rememberSettings: !embed,
        }}
        initialAppFile={embed?.file}
        initialTreeOpen={embed ? false : undefined}
        sceneId={selectedSceneId}
        scenes={scenes}
        theme={theme}
        width={width || 800}
      />
      {saveOpen && canSave ? (
        <SceneSaveDialog
          error={error}
          isPublic={info ? info.scene.visibility === "public" : true}
          nextVersion={latestVersion === null ? null : latestVersion + 1}
          onClose={() => {
            if (!saving) {
              setSaveOpen(false);
            }
          }}
          onSave={(message) => void save(message)}
          saving={saving}
          sceneName={sceneName ?? info?.scene.name ?? "scene"}
          {...(suggestedMessage ? { defaultMessage: suggestedMessage } : {})}
        />
      ) : null}
      {versionsOpen && info ? (
        <SceneVersionsDialog
          isOwner={info.isOwner}
          latestVersion={info.scene.latestVersion}
          onClose={() => setVersionsOpen(false)}
          onSelectVersion={selectVersion}
          sceneId={sceneId}
          sceneName={info.scene.name}
          share={share}
          slug={info.scene.slug}
          versions={info.versions}
          viewingVersion={selectedVersion}
        />
      ) : null}
      {installOpen && info ? (
        <SceneInstallDialog
          declaredSettingsGroups={
            previewScenes
              ? requiredSettingsForScenes(previewScenes).map((group) => ({
                  key: group.key,
                  title: group.title,
                }))
              : []
          }
          framesUrl={info.framesUrl}
          installVersion={installVersion}
          installableFrames={info.installableFrames}
          isPrivate={info.scene.visibility !== "public"}
          loginUrl={loginUrl}
          onClose={() => setInstallOpen(false)}
          pageUrl={info.pageUrl}
          returnTo={`${window.location.pathname}${window.location.search}${window.location.hash}`}
          sceneId={sceneId}
          sceneName={info.scene.name}
          signedIn={info.signedIn}
          signupUrl={signupUrl}
        />
      ) : null}
    </div>
  );
}
