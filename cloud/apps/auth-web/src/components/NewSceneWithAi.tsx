"use client";

import { Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { applyAiScenes, blankScene, prepareForEditor, type AiScenesEvent, type SceneJson } from "../lib/ai-scenes-apply";
import {
  clearNewSceneDraft,
  draftIdFromHash,
  hashForDraftId,
  newSceneDraftId,
  readNewSceneDraft,
  writeNewSceneDraft,
  type NewSceneDraft,
  type NewSceneDraftChat,
} from "../lib/new-scene-draft";
import { takeHandoffScenes } from "../lib/scene-handoff";
import { singlePanelFor, type SceneEditorPanelName, type SceneEditorPanels } from "../lib/scene-views";
import type { RenderedScenes } from "./SceneAiPanel";
import {
  readDocumentTheme,
  SceneEditorBackButton,
  SceneEditorBar,
  SceneEditorPanelToggles,
  SceneEditorWorkspace,
  SceneNameTitle,
  sceneNameFor,
  shownPanels,
  togglePanelIn,
  useEditorStylesheet,
  useSinglePanelMode,
  type EmbeddedSceneEditorApi,
  type SceneEditorAction,
} from "./SceneEditorModal";

export const newScenePresets = [
  { height: 480, label: "800 × 480 (7.5″ landscape)", width: 800 },
  { height: 800, label: "480 × 800 (7.5″ portrait)", width: 480 },
  { height: 825, label: "1200 × 825 (10.3″)", width: 1200 },
  { height: 1200, label: "1600 × 1200 (13.3″)", width: 1600 },
  { height: 1404, label: "1872 × 1404 (13.3″ HD)", width: 1872 },
] as const;

type NewSceneWithAiProps = {
  /** From ?prompt=…: submitted to the AI as soon as the page opens. */
  initialPrompt?: string | undefined;
  settingsUrl?: string | undefined;
  /** The account switched AI features off; the panel says so up front. */
  aiDisabled?: boolean | undefined;
  /** Where to turn AI back on. */
  aiSettingsUrl?: string | undefined;
  loginUrl?: string | undefined;
  /** Where "Back" goes. */
  myScenesUrl: string;
  /** sessionStorage key holding scenes to open instead of a blank one (the
   *  converter's "Open in the editor"); read once on mount, then removed. */
  handoffKey?: string | undefined;
};

// Headless automation hook (src/lib/ai/eval/realign.ts drives it through
// Playwright to lay out AI-built scenes with the editor's own auto-arrange):
// `load` hands the editor a fresh set of scenes (sentinel positions + the
// autoArrangeOnLoad marker, so it arranges them once measured), `select`
// switches the arranged scene (the editor only arranges the selected one),
// `scenes` returns the latest onScenesChanged payload and `version` counts
// those payloads. Harmless for humans: nothing reads it unless a script does.
export type FrameosEditorHook = {
  load: (scenes: unknown[], sceneId?: string) => void;
  select: (sceneId: string) => void;
  scenes: () => unknown[] | null;
  version: number;
};

declare global {
  interface Window {
    __frameosEditor?: FrameosEditorHook;
  }
}

const createErrors: Record<string, string> = {
  content_rejected: "Rejected by content moderation",
  daily_scene_limit_exceeded: "Daily new-scene limit reached",
  invalid_scenes: "The scene is empty",
  login_required: "Sign in to save scenes",
  moderation_unavailable: "Moderation service unavailable — try again later",
  scene_name_taken: "You already have a scene with this name — rename it in Scene settings",
  scene_quota_exceeded: "Scene limit reached",
  storage_quota_exceeded: "Cloud scene storage limit reached",
  store_banned: "This account cannot publish scenes",
};

// A full-page editor for a brand-new scene, AI panel open: start from one
// blank scene, describe what you want, then "Save to my scenes" creates it
// as a private scene and jumps to its page.
export function NewSceneWithAi({
  aiDisabled = false,
  aiSettingsUrl,
  initialPrompt,
  settingsUrl,
  loginUrl,
  myScenesUrl,
  handoffKey,
}: NewSceneWithAiProps) {
  // Scenes are minted on the client (crypto ids) after mount, so the server
  // render and the hydration pass agree.
  const [scenes, setScenes] = useState<SceneJson[] | null>(null);
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  // The selected scene's name, as the bar shows it and "Save to my scenes"
  // sends it; follows the editor's edits and its scene tabs.
  const [sceneName, setSceneName] = useState<string | null>(null);
  const [presetIndex, setPresetIndex] = useState(0);
  const [panels, setPanels] = useState<SceneEditorPanels>({ ai: true, editor: true, info: false, preview: false });
  // A narrow viewport shows one panel of the set at a time (the last one
  // picked there, else singlePanelFor's).
  const narrow = useSinglePanelMode();
  const [activePanel, setActivePanel] = useState<SceneEditorPanelName | null>(null);
  // The editor's latest scenes as state, for the Preview panel (kept up to
  // date only while it is open — each update re-renders the page).
  const [previewScenes, setPreviewScenes] = useState<SceneJson[] | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latestScenesRef = useRef<SceneJson[] | null>(null);
  const selectedSceneIdRef = useRef<string | null>(null);
  const editorApiRef = useRef<EmbeddedSceneEditorApi | null>(null);
  const hookRef = useRef<FrameosEditorHook | null>(null);
  const panelsRef = useRef(panels);
  panelsRef.current = panels;
  selectedSceneIdRef.current = selectedSceneId;
  // The scenes the editor started from (its own echo of them, normalised);
  // anything else means there is something to keep.
  const initialJsonRef = useRef("");
  const baselinePendingRef = useRef(false);
  const presetIndexRef = useRef(presetIndex);
  presetIndexRef.current = presetIndex;
  const chatRef = useRef<NewSceneDraftChat | null>(null);
  useEditorStylesheet(true);

  // The draft this page is keeping in the browser: its id rides in the URL
  // hash, so a reload lands back on the same one. Read at the first render,
  // not in an effect — the AI panel decides on mount whether to run
  // ?prompt=, and a restored draft must not run it a second time. (None of
  // it reaches the DOM, so the server render still matches.)
  const openedRef = useRef<{ draftId: string | null; draft: NewSceneDraft | null } | null>(null);
  if (openedRef.current === null) {
    const draftId = typeof window === "undefined" ? null : draftIdFromHash(window.location.hash);
    openedRef.current = { draft: draftId ? readNewSceneDraft(draftId) : null, draftId };
  }
  const restored = openedRef.current.draft;
  const draftIdRef = useRef<string | null>(openedRef.current.draftId);

  function publishScenes(next: SceneJson[]) {
    latestScenesRef.current = next;
    setSceneName(sceneNameFor(next, selectedSceneIdRef.current));
    if (panelsRef.current.preview) {
      setPreviewScenes(next);
    }
  }

  function selectScene(nextSceneId: string | null) {
    selectedSceneIdRef.current = nextSceneId;
    setSelectedSceneId(nextSceneId);
    setSceneName(sceneNameFor(latestScenesRef.current, nextSceneId));
  }

  // Nothing here is saved server-side until "Save to my scenes", so every
  // change lands in localStorage (debounced) and the URL hash names it: a
  // reload, a Back, a closed-and-reopened tab picks the scene up where it
  // was instead of starting over. Cleared once the scene is saved.
  const draftTimerRef = useRef<number | null>(null);
  function persistDraftNow() {
    draftTimerRef.current = null;
    const latest = latestScenesRef.current;
    if (!latest || latest.length === 0) {
      return;
    }
    const chat = chatRef.current;
    if (JSON.stringify(latest) === initialJsonRef.current && !chat) {
      // Still the blank scene the page opened with: nothing to keep, and no
      // reason to stamp a draft id into the URL.
      return;
    }
    let draftId = draftIdRef.current;
    if (!draftId) {
      draftId = newSceneDraftId();
      draftIdRef.current = draftId;
      window.history.replaceState(window.history.state, "", hashForDraftId(draftId));
    }
    writeNewSceneDraft(draftId, {
      chat,
      presetIndex: presetIndexRef.current,
      savedAt: new Date().toISOString(),
      scenes: latest,
      selectedSceneId: selectedSceneIdRef.current,
    });
  }
  function scheduleDraftPersist() {
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
    }
    draftTimerRef.current = window.setTimeout(persistDraftNow, 500);
  }
  // A change still inside the debounce window must not be lost to the very
  // reload the draft guards against: flushed when the page goes away.
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

  // The bar's pencil: rename the selected scene through the mounted editor
  // (in place, echoed back through onScenesChanged) — or, before it has
  // mounted, by handing it the renamed scenes to start from.
  function renameScene(name: string) {
    const current = latestScenesRef.current;
    const targetId = selectedSceneIdRef.current ?? current?.[0]?.id ?? null;
    if (!current || targetId === null) {
      return;
    }
    const next = current.map((scene) => (scene.id === targetId ? { ...scene, name } : scene));
    publishScenes(next);
    // Whatever the editor echoes back now is an edit, not the baseline.
    baselinePendingRef.current = false;
    setTouched(true);
    scheduleDraftPersist();
    if (editorApiRef.current) {
      editorApiRef.current.renameScene(targetId, name);
    } else {
      setScenes(next);
    }
  }

  useEffect(() => {
    setTheme(readDocumentTheme());
    // A draft from this browser (#d=…) reopens as it was — scenes, selected
    // scene, display size — and counts as unsaved work from the start.
    if (restored) {
      chatRef.current = restored.chat;
      if (newScenePresets[restored.presetIndex]) {
        setPresetIndex(restored.presetIndex);
      }
      latestScenesRef.current = restored.scenes;
      setPreviewScenes(restored.scenes);
      setScenes(restored.scenes);
      selectScene(
        restored.scenes.some((scene) => scene.id === restored.selectedSceneId)
          ? restored.selectedSceneId
          : (restored.scenes[0]?.id ?? null),
      );
      setTouched(true);
      return;
    }
    // Handed-off scenes (the converter's "Open in the editor") open as they
    // are, unsaved, with the preview beside the editor instead of the AI
    // panel: the user came to look at a result, not to describe a new one.
    const handedOff = handoffKey ? takeHandoffScenes(handoffKey) : null;
    const initial = handedOff
      ? handedOff.map((scene) =>
          prepareForEditor({
            ...scene,
            id: typeof scene.id === "string" && scene.id ? scene.id : crypto.randomUUID(),
          }),
        )
      : [blankScene()];
    if (handedOff) {
      setPanels({ ai: false, editor: true, info: false, preview: true });
      setTouched(true);
    } else {
      // The editor answers with its own normalised copy of the blank scene;
      // that echo, not this array, is what "still untouched" compares to.
      baselinePendingRef.current = true;
    }
    latestScenesRef.current = initial;
    setPreviewScenes(initial);
    setScenes(initial);
    selectScene(initial[0]?.id ?? null);
  }, []);

  useEffect(() => {
    const hook: FrameosEditorHook = {
      load: (input, sceneId) => {
        const prepared = input
          .filter(
            (scene): scene is Record<string, unknown> =>
              Boolean(scene) && typeof scene === "object" && !Array.isArray(scene),
          )
          .map((scene) =>
            prepareForEditor({
              ...scene,
              id: typeof scene.id === "string" && scene.id ? scene.id : crypto.randomUUID(),
            }),
          );
        const selected = prepared.find((scene) => scene.id === sceneId)?.id ?? prepared[0]?.id ?? null;
        selectedSceneIdRef.current = selected;
        publishScenes(prepared);
        setScenes(prepared);
        setSelectedSceneId(selected);
      },
      scenes: () => latestScenesRef.current,
      select: (sceneId) => selectScene(sceneId),
      version: 0,
    };
    hookRef.current = hook;
    window.__frameosEditor = hook;
    return () => {
      if (window.__frameosEditor === hook) {
        delete window.__frameosEditor;
      }
      hookRef.current = null;
    };
  }, []);

  const preset = newScenePresets[presetIndex] ?? newScenePresets[0];

  // What the AI panel opens with. A restored draft brings its conversation
  // back instead — and the ?prompt= that started that conversation must not
  // run (and be paid for) a second time.
  const aiEntry: { initialChat?: NewSceneDraftChat; initialPrompt?: string | undefined } = restored
    ? restored.chat
      ? { initialChat: restored.chat }
      : {}
    : { initialPrompt };

  function applyAiEvent(event: AiScenesEvent): string | null {
    const result = applyAiScenes(latestScenesRef.current ?? scenes ?? [], event, selectedSceneIdRef.current);
    baselinePendingRef.current = false;
    selectedSceneIdRef.current = result.selectedSceneId;
    publishScenes(result.scenes);
    setScenes(result.scenes);
    setSelectedSceneId(result.selectedSceneId);
    setTouched(true);
    scheduleDraftPersist();
    return result.selectedSceneId;
  }

  function togglePanel(panel: SceneEditorPanelName) {
    if (narrow) {
      // A tab: show this panel, adding it to the set a wide viewport shows.
      setActivePanel(panel);
      if (panel === "preview") {
        setPreviewScenes(latestScenesRef.current);
      }
      if (!panels[panel]) {
        setPanels({ ...panels, [panel]: true });
      }
      return;
    }
    const next = togglePanelIn(panels, panel);
    if (!next) {
      return;
    }
    if (panel === "preview" && next.preview) {
      setPreviewScenes(latestScenesRef.current);
    }
    setPanels(next);
  }

  // "Show in preview" under a frame the AI rendered: open the Preview panel
  // on exactly those scenes (the editor may have moved on since), and put
  // the editor on the scene that was drawn.
  function showRenderInPreview({ sceneId, scenes: rendered }: RenderedScenes) {
    setPreviewScenes(rendered);
    if (rendered.some((scene) => scene.id === sceneId)) {
      selectScene(sceneId);
    }
    if (narrow) {
      setActivePanel("preview");
    }
    if (!panels.preview) {
      setPanels({ ...panels, preview: true });
    }
  }

  function changePreset(index: number) {
    setPresetIndex(index);
    presetIndexRef.current = index;
    scheduleDraftPersist();
    // The editor only re-reads its width/height when the scenes identity
    // changes; hand it the same scenes in a fresh array.
    setScenes((current) => (current ? [...current] : current));
  }

  async function save() {
    const latest = latestScenesRef.current;
    if (!latest || latest.length === 0) {
      setError("Nothing to save yet.");
      return;
    }
    const first = latest.find((scene) => scene.id === selectedSceneIdRef.current) ?? latest[0];
    const name =
      typeof first?.name === "string" && first.name.trim() ? first.name.trim() : "New scene";
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/account/scenes", {
        body: JSON.stringify({ name, scenes: latest }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        scene?: { slug?: string };
      };
      if (!response.ok || !payload.scene?.slug) {
        const code = payload.error ?? String(response.status);
        setError(createErrors[code] ?? `Saving failed: ${code}`);
        return;
      }
      // Saved: the browser copy has done its job.
      if (draftTimerRef.current !== null) {
        window.clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
      }
      if (draftIdRef.current) {
        clearNewSceneDraft(draftIdRef.current);
        draftIdRef.current = null;
      }
      window.location.href = `/s/${payload.scene.slug}`;
    } catch {
      setError("Saving failed — check your connection");
    } finally {
      setSaving(false);
    }
  }

  const shown = shownPanels(panels, narrow, activePanel);
  const actions: SceneEditorAction[] = [
    {
      Icon: Save,
      disabled: saving || !scenes,
      emphasized: true,
      key: "save",
      label: saving ? "Saving…" : "Save to my scenes",
      onSelect: () => void save(),
      primary: true,
      title: "Create a private scene in your account from what is in the editor",
    },
  ];

  return (
    // ph-no-capture: the scene being built is the user's own.
    <div className="editor-modal ph-no-capture">
      <SceneEditorBar
        actions={actions}
        leading={
          <label className="editor-modal__preset">
            <span className="editor-modal__preset-label">Display</span>
            <select
              aria-label="Display size"
              className="input editor-modal__preset-select"
              onChange={(event) => changePreset(Number(event.target.value))}
              value={presetIndex}
            >
              {newScenePresets.map((option, index) => (
                <option key={option.label} value={index}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        }
      >
        <SceneEditorBackButton href={myScenesUrl} label="Back" />
        <SceneEditorPanelToggles
          active={narrow ? singlePanelFor(panels, activePanel) : undefined}
          available={{ info: false }}
          onToggle={togglePanel}
          panels={panels}
        />
        <SceneNameTitle name={sceneName} onRename={renameScene} />
        {touched ? <span className="pill pill-warning">Not saved yet</span> : null}
        {error ? (
          <span className="pill pill-warning" role="alert">
            {error}
          </span>
        ) : null}
      </SceneEditorBar>
      <SceneEditorWorkspace
        ai={{
          ...aiEntry,
          getScenes: () => latestScenesRef.current,
          loginUrl,
          mode: "new",
          onChatChange: (chat) => {
            chatRef.current = chat;
            scheduleDraftPersist();
          },
          onScenes: applyAiEvent,
          onShowInPreview: showRenderInPreview,
          aiDisabled,
          ...(aiSettingsUrl ? { aiSettingsUrl } : {}),
          settingsUrl,
          signedIn: true,
        }}
        editorApiRef={editorApiRef}
        height={preset.height}
        onScenesChanged={(nextScenes) => {
          publishScenes(nextScenes);
          if (hookRef.current) {
            hookRef.current.version += 1;
          }
          const json = JSON.stringify(nextScenes);
          if (baselinePendingRef.current) {
            // The editor's first echo of the blank scene it was handed.
            baselinePendingRef.current = false;
            initialJsonRef.current = json;
            return;
          }
          setTouched(true);
          scheduleDraftPersist();
        }}
        // The editor reports null before its first init; nothing to follow.
        onSelectedSceneChanged={(nextSceneId) => {
          if (nextSceneId !== null && nextSceneId !== selectedSceneIdRef.current) {
            selectScene(nextSceneId);
          }
        }}
        panels={shown}
        // Not saved yet: the only source is the editor (no versions exist).
        preview={{ sceneId: null, scenes: previewScenes, settingsUrl }}
        sceneId={selectedSceneId}
        scenes={scenes}
        theme={theme}
        width={preset.width}
      />
    </div>
  );
}
