"use client";

import { MonitorUp } from "lucide-react";
import { useState } from "react";

export type InstallableFrame = {
  connected: boolean;
  id: string;
  name: string;
  status: string;
};

// "Install on a frame" on a store scene page: pick one of the account's
// cloud-managed frames, POST /api/frames/{id}/scenes/add, and the scene is
// assigned and pushed. Pending/revoked frames are listed but disabled, so
// the owner sees why a frame is missing rather than wondering.
export function InstallOnFrameBox({
  declaredSettingsGroups = [],
  frames,
  framesUrl,
  sceneId,
  sceneName,
  sceneVersion,
}: {
  // The service-settings groups the scene's apps declare (preview-settings'
  // requiredSettingsForScenes), offered as pre-ticked checkboxes: a scene
  // only asks for a key, the owner grants it per install
  // (docs/cloud-frames.md, "Service settings"). Ticked = sent as
  // settings_groups; the frame is served nothing the owner unticked.
  declaredSettingsGroups?: { key: string; title: string }[];
  frames: InstallableFrame[];
  // The workspace URL for a frame id, minus the id (…/frames/).
  framesUrl: string;
  sceneId: string;
  sceneName: string;
  sceneVersion: number | null;
}) {
  const installable = frames.filter((frame) => frame.status === "active");
  const [frameId, setFrameId] = useState(installable[0]?.id ?? "");
  const [granted, setGranted] = useState<string[]>(() =>
    declaredSettingsGroups.map((group) => group.key),
  );
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "busy" }
    | { kind: "done"; connected: boolean; reDeployed: boolean }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  async function install() {
    if (!frameId) {
      return;
    }
    setState({ kind: "busy" });
    try {
      const response = await fetch(`/api/frames/${frameId}/scenes/add`, {
        body: JSON.stringify({
          scene_id: sceneId,
          scene_version: sceneVersion,
          settings_groups: granted.filter((key) =>
            declaredSettingsGroups.some((group) => group.key === key),
          ),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        already_assigned?: boolean;
        connected?: boolean;
        error?: string;
        max?: number;
      };
      if (!response.ok) {
        setState({ kind: "error", message: installError(payload.error, payload.max) });
        return;
      }
      setState({
        connected: Boolean(payload.connected),
        kind: "done",
        reDeployed: Boolean(payload.already_assigned),
      });
    } catch {
      setState({ kind: "error", message: "The request failed. Try again in a moment." });
    }
  }

  const selected = frames.find((frame) => frame.id === frameId);

  return (
    <section className="card install-box">
      <h3>Install on a frame</h3>
      {frames.length === 0 ? (
        <p>
          You have no cloud-managed frames yet.{" "}
          <a href={framesUrl}>Add one</a> and it will show up here.
        </p>
      ) : (
        <>
          <p>
            Adds <strong>{sceneName}</strong>{" "}to the frame&apos;s scenes and
            deploys it. Scenes already on the frame stay.
          </p>
          {declaredSettingsGroups.length > 0 ? (
            <fieldset className="install-box__grants">
              <legend>This scene asks for your API keys</legend>
              <p className="copy">
                Tick what it may use on the frame. Keys come from your account settings; the
                frame is never sent one you untick.
              </p>
              {declaredSettingsGroups.map((group) => (
                <label className="install-box__grant" key={group.key}>
                  <input
                    checked={granted.includes(group.key)}
                    disabled={state.kind === "busy"}
                    onChange={(event) =>
                      setGranted((current) =>
                        event.target.checked
                          ? [...current.filter((key) => key !== group.key), group.key]
                          : current.filter((key) => key !== group.key),
                      )
                    }
                    type="checkbox"
                  />{" "}
                  {group.title}
                </label>
              ))}
            </fieldset>
          ) : null}
          <div className="install-box__row">
            <select
              aria-label="Frame"
              className="input"
              disabled={state.kind === "busy" || installable.length === 0}
              onChange={(event) => {
                setFrameId(event.target.value);
                setState({ kind: "idle" });
              }}
              value={frameId}
            >
              {frames.map((frame) => (
                <option
                  disabled={frame.status !== "active"}
                  key={frame.id}
                  value={frame.id}
                >
                  {frame.name}
                  {frame.status !== "active"
                    ? ` (${frame.status})`
                    : frame.connected
                      ? " · online"
                      : " · offline"}
                </option>
              ))}
            </select>
            <button
              className="button button-primary"
              disabled={!frameId || state.kind === "busy" || installable.length === 0}
              onClick={() => void install()}
              type="button"
            >
              <MonitorUp aria-hidden size={16} />
              {state.kind === "busy" ? "Installing…" : "Install"}
            </button>
          </div>
          {installable.length === 0 ? (
            <p className="copy">
              None of your frames is active yet — confirm a pending frame under{" "}
              <a href={framesUrl}>Frames</a> first.
            </p>
          ) : null}
          {state.kind === "done" ? (
            <p className="notice" role="status">
              {state.reDeployed ? "Re-deployed" : "Installed"} on{" "}
              <a href={`${framesUrl}${selected?.id ?? frameId}`}>
                {selected?.name ?? "the frame"}
              </a>
              .{" "}
              {state.connected
                ? "The frame applies it within seconds."
                : "The frame is offline; the deploy lands when it reconnects."}
            </p>
          ) : null}
          {state.kind === "error" ? (
            <p className="notice-error" role="alert">
              {state.message}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function installError(code: string | undefined, max: number | undefined) {
  switch (code) {
    case "login_required":
      return "Your session expired. Sign in again and retry.";
    case "frame_not_active":
      return "That frame is not active yet — confirm it under Frames first.";
    case "too_many_scenes":
      return `A frame can hold at most ${max ?? 20} scenes. Remove one first.`;
    case "scene_not_allowed":
      return "This scene version runs shell commands, which the cloud never pushes. Install it from the frame itself.";
    case "scene_not_found":
    case "invalid_scene":
      return "This scene can no longer be installed.";
    default:
      return "Installing failed. Try again in a moment.";
  }
}
