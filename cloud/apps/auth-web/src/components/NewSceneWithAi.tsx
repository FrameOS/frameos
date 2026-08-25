"use client";

import { ArrowLeft, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { applyAiScenes, blankScene, prepareForEditor, type AiScenesEvent, type SceneJson } from "../lib/ai-scenes-apply";
import type { SceneEditorPanels } from "../lib/scene-views";
import {
  readDocumentTheme,
  SceneEditorPanelToggles,
  SceneEditorWorkspace,
  SceneNameTitle,
  sceneNameFor,
  useEditorStylesheet,
  type EmbeddedSceneEditorApi,
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
  loginUrl?: string | undefined;
  /** Where "Back" goes. */
  myScenesUrl: string;
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
export function NewSceneWithAi({ initialPrompt, settingsUrl, loginUrl, myScenesUrl }: NewSceneWithAiProps) {
  // Scenes are minted on the client (crypto ids) after mount, so the server
  // render and the hydration pass agree.
  const [scenes, setScenes] = useState<SceneJson[] | null>(null);
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  // The selected scene's name, as the bar shows it and "Save to my scenes"
  // sends it; follows the editor's edits and its scene tabs.
  const [sceneName, setSceneName] = useState<string | null>(null);
  const [presetIndex, setPresetIndex] = useState(0);
  const [panels, setPanels] = useState<SceneEditorPanels>({ ai: true, preview: false });
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
  useEditorStylesheet(true);

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
    setTouched(true);
    if (editorApiRef.current) {
      editorApiRef.current.renameScene(targetId, name);
    } else {
      setScenes(next);
    }
  }

  useEffect(() => {
    setTheme(readDocumentTheme());
    const initial = [blankScene()];
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

  function applyAiEvent(event: AiScenesEvent): string | null {
    const result = applyAiScenes(latestScenesRef.current ?? scenes ?? [], event, selectedSceneIdRef.current);
    selectedSceneIdRef.current = result.selectedSceneId;
    publishScenes(result.scenes);
    setScenes(result.scenes);
    setSelectedSceneId(result.selectedSceneId);
    setTouched(true);
    return result.selectedSceneId;
  }

  function togglePanel(panel: keyof SceneEditorPanels) {
    const next = { ...panels, [panel]: !panels[panel] };
    if (panel === "preview" && next.preview) {
      setPreviewScenes(latestScenesRef.current);
    }
    setPanels(next);
  }

  function changePreset(index: number) {
    setPresetIndex(index);
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
      window.location.href = `/s/${payload.scene.slug}`;
    } catch {
      setError("Saving failed — check your connection");
    } finally {
      setSaving(false);
    }
  }

  return (
    // ph-no-capture: the scene being built is the user's own.
    <div className="editor-modal ph-no-capture">
      <div className="editor-modal__bar">
        <div className="editor-modal__title">
          <SceneNameTitle name={sceneName} onRename={renameScene} />
          {touched ? <span className="pill pill-warning">Not saved yet</span> : null}
          {error ? (
            <span className="pill pill-warning" role="alert">
              {error}
            </span>
          ) : null}
        </div>
        <div className="button-row">
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
          <SceneEditorPanelToggles onToggle={togglePanel} panels={panels} />
          <button
            className="button button--small button-primary"
            disabled={saving || !scenes}
            onClick={() => void save()}
            title="Create a private scene in your account from what is in the editor"
            type="button"
          >
            <Save aria-hidden size={16} />
            {saving ? "Saving…" : "Save to my scenes"}
          </button>
          <a className="button button--small" href={myScenesUrl}>
            <ArrowLeft aria-hidden size={16} />
            Back
          </a>
        </div>
      </div>
      <SceneEditorWorkspace
        ai={{
          getScenes: () => latestScenesRef.current,
          initialPrompt,
          loginUrl,
          mode: "new",
          onScenes: applyAiEvent,
          saveHint: "“Save to my scenes” creates a private scene in your account from what is in the editor.",
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
          setTouched(true);
        }}
        // The editor reports null before its first init; nothing to follow.
        onSelectedSceneChanged={(nextSceneId) => {
          if (nextSceneId !== null && nextSceneId !== selectedSceneIdRef.current) {
            selectScene(nextSceneId);
          }
        }}
        panels={panels}
        // Not saved yet: the only source is the editor (no versions exist).
        preview={{ sceneId: null, scenes: previewScenes }}
        sceneId={selectedSceneId}
        scenes={scenes}
        theme={theme}
        width={preset.width}
      />
    </div>
  );
}
