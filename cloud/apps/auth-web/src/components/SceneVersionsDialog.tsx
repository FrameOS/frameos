"use client";

import { X } from "lucide-react";
import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { formatBytes, formatDateTime } from "../lib/format";
import type { SceneInfoVersion } from "./SceneInfoPanel";
import { YankVersionButton } from "./YankVersionButton";

export type SceneVersionsDialogProps = {
  sceneId: string;
  sceneName: string;
  slug: string;
  latestVersion: number;
  /** Any order; shown newest first. */
  versions: readonly SceneInfoVersion[];
  /** Owners get the Unpublish / Republish actions. */
  isOwner: boolean;
  /** Share token for private scenes; travels with every link. */
  share?: string | undefined;
  /** The version the workspace has loaded (marked in the table). */
  viewingVersion: number | null;
  /** A click on a version loads it into the workspace. */
  onSelectVersion: (version: number) => void;
  onClose: () => void;
};

// The bar's "Manage versions…": every published version of the scene in a
// table — the version with its status, when it was published and the
// zip's details, and for the owner the Unpublish / Republish action (the
// page's data refreshes behind it, so the bar's dropdown follows). Closed
// by its ×, a click on the backdrop, or Esc. On <body>, like the Install
// dialog: the editor frame's transform would otherwise keep a fixed
// element inside a column.
export function SceneVersionsDialog({
  sceneId,
  sceneName,
  slug,
  latestVersion,
  versions,
  isOwner,
  share,
  viewingVersion,
  onSelectVersion,
  onClose,
}: SceneVersionsDialogProps) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const withShare = (path: string) =>
    share ? `${path}${path.includes("?") ? "&" : "?"}share=${share}` : path;
  function versionClick(version: number) {
    return (event: ReactMouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      onSelectVersion(version);
    };
  }
  const sorted = [...versions].sort((a, b) => b.version - a.version);

  return createPortal(
    <div aria-label={`Versions of ${sceneName}`} aria-modal className="dialog" onClick={onClose} role="dialog">
      <div className="dialog__panel dialog__panel--wide" onClick={(event) => event.stopPropagation()}>
        <div className="dialog__head">
          <h2>Versions</h2>
          <button aria-label="Close" autoFocus className="dialog__close" onClick={onClose} type="button">
            <X aria-hidden size={18} />
          </button>
        </div>
        <p className="copy">
          Every save publishes a new version; installs and updates take the latest published one.
          {isOwner
            ? " Unpublishing a version hides it from new installs — it stays downloadable when asked for by number."
            : ""}
        </p>
        <table className="table scene-versions">
          <thead>
            <tr>
              <th>Version</th>
              <th>Published</th>
              {isOwner ? <th>Action</th> : null}
            </tr>
          </thead>
          <tbody>
            {sorted.map((version) => (
              <tr key={version.version}>
                <td>
                  <a
                    href={withShare(`/s/${slug}?version=${version.version}`)}
                    onClick={versionClick(version.version)}
                    title={`Load v${version.version} into the workspace`}
                  >
                    v{version.version}
                  </a>
                  <div className="scene-versions__pills">
                    {version.yankedAt ? (
                      <span
                        className="pill pill-warning"
                        title="Skipped by new installs; still downloadable when requested explicitly"
                      >
                        Unpublished
                      </span>
                    ) : version.version === latestVersion ? (
                      <span className="pill pill-ok">Latest</span>
                    ) : (
                      <span className="pill">Published</span>
                    )}
                    {viewingVersion === version.version ? <span className="pill">In the editor</span> : null}
                  </div>
                  {version.message ? (
                    <div className="scene-versions__message">{version.message}</div>
                  ) : null}
                </td>
                <td>
                  {formatDateTime(new Date(version.createdAt))}
                  <div className="scene-versions__detail">
                    <span title="Minimum FrameOS version">
                      {version.frameosVersion ? `FrameOS ${version.frameosVersion}+` : "any FrameOS"}
                    </span>
                    {" · "}
                    <span>{formatBytes(version.sizeBytes)}</span>
                    {" · "}
                    <code title={`SHA-256 ${version.sha256}`}>{version.sha256.slice(0, 12)}…</code>
                  </div>
                </td>
                {isOwner ? (
                  <td>
                    <YankVersionButton sceneId={sceneId} version={version.version} yanked={Boolean(version.yankedAt)} />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>,
    document.body,
  );
}
