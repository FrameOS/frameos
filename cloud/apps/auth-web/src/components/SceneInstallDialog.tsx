"use client";

import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { CopyUrlField } from "./CopyUrlField";
import { InstallOnFrameBox, type InstallableFrame } from "./InstallOnFrameBox";

export type SceneInstallDialogProps = {
  sceneId: string;
  sceneName: string;
  /** The scene page's absolute URL (share token and pinned version
   * included) — what a self-hosted frame's Templates panel takes. */
  pageUrl: string;
  isPrivate: boolean;
  /** The visitor's cloud frames, or null when a cloud install is not on
   * offer (signed out, pulled scene). */
  installableFrames: InstallableFrame[] | null;
  framesUrl: string;
  /** The version a cloud install pins (null: the latest). */
  installVersion: number | null;
  /** The service-settings groups the scene declares, shown as grant
   * checkboxes on a cloud install (InstallOnFrameBox). */
  declaredSettingsGroups?: { key: string; title: string }[] | undefined;
  signedIn: boolean;
  /** The sign-in page; `return_to` is appended. */
  loginUrl: string;
  signupUrl: string;
  /** Where sign-in comes back to: this page. */
  returnTo: string;
  onClose: () => void;
};

// The bar's "Install": the two ways onto a frame, each a section — a cloud
// frame (one click; signed-out visitors are invited to sign in or join
// instead) and a self-hosted FrameOS (the page's link, pasted into its
// Templates panel). Closed by its ×, a click on the backdrop, or Esc. On
// <body>, like the lightbox: the editor frame's transform would otherwise
// keep a fixed element inside a column.
export function SceneInstallDialog({
  sceneId,
  sceneName,
  pageUrl,
  isPrivate,
  installableFrames,
  framesUrl,
  installVersion,
  declaredSettingsGroups,
  signedIn,
  loginUrl,
  signupUrl,
  returnTo,
  onClose,
}: SceneInstallDialogProps) {
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

  const signInHref = `${loginUrl}${loginUrl.includes("?") ? "&" : "?"}return_to=${encodeURIComponent(returnTo)}`;

  return createPortal(
    <div aria-label={`Install ${sceneName}`} aria-modal className="dialog" onClick={onClose} role="dialog">
      <div className="dialog__panel" onClick={(event) => event.stopPropagation()}>
        <div className="dialog__head">
          <h2>Install {sceneName}</h2>
          <button aria-label="Close" autoFocus className="dialog__close" onClick={onClose} type="button">
            <X aria-hidden size={18} />
          </button>
        </div>
        <div className="stack">
          {installableFrames ? (
            <InstallOnFrameBox
              declaredSettingsGroups={declaredSettingsGroups ?? []}
              frames={installableFrames}
              framesUrl={framesUrl}
              sceneId={sceneId}
              sceneName={sceneName}
              sceneVersion={installVersion}
            />
          ) : !signedIn ? (
            <section className="card">
              <h3>Install on a frame</h3>
              <p className="copy">
                Frames managed by FrameOS Cloud get one-click installs: pick a frame here and the scene
                is on it. Sign in, or create a FrameOS Cloud account, to see yours.
              </p>
              <div className="button-row">
                <a className="button button--small button-primary" href={signInHref}>
                  Sign in
                </a>
                <a className="button button--small" href={signupUrl}>
                  Create an account
                </a>
              </div>
            </section>
          ) : null}
          <section className="card">
            <h3>Install on a self-hosted FrameOS</h3>
            <p>Copy this link into the search box of a frame&apos;s Templates panel:</p>
            <CopyUrlField value={pageUrl} />
            {isPrivate ? (
              <p className="copy">
                The link carries a sharing secret: anyone who has it can view and install this private
                scene.
              </p>
            ) : null}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
