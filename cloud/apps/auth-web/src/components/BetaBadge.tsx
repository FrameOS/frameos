"use client";

import { useRef } from "react";

// The "beta" tag after the FrameOS Cloud wordmark. Clicking it opens a
// native <dialog> that says what beta means here. The /frames SPA renders
// the same markup and copy in cloud-frontend AccountHeader.tsx — keep the
// two in step.
export function BetaBadge() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button
        aria-haspopup="dialog"
        className="frameos-account-header__beta"
        onClick={() => dialogRef.current?.showModal()}
        title="What beta means"
        type="button"
      >
        beta
      </button>
      <dialog
        aria-labelledby="frameos-beta-title"
        className="frameos-beta-dialog"
        onClick={(event) => {
          // Backdrop click: the dialog itself is the target only outside
          // its body.
          if (event.target === dialogRef.current) {
            dialogRef.current?.close();
          }
        }}
        ref={dialogRef}
      >
        <div className="frameos-beta-dialog__body">
          <h2 id="frameos-beta-title">FrameOS Cloud is in beta</h2>
          <BetaCopy />
          <div className="frameos-beta-dialog__actions">
            <button
              className="frameos-beta-dialog__close"
              onClick={() => dialogRef.current?.close()}
              type="button"
            >
              Got it
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}

export function BetaCopy() {
  return (
    <>
      <p>
        The cloud is new and still changing. It works — frames enroll, scenes
        deploy — but expect rough edges, and expect things to move around.
      </p>
      <ul>
        <li>
          <strong>It is free while in beta.</strong> Limits (frames, storage,
          logs) exist so one account cannot crowd out the rest; they may change.
        </li>
        <li>
          <strong>Your data stays yours.</strong> Scenes, backups and frame
          settings can be exported from your account at any time, every frame
          keeps working on its own if the cloud is unreachable, and easy
          cloud ↔ self-hosted migrations are coming.
        </li>
        <li>
          <strong>Self-hosting is not going anywhere.</strong> The cloud is an
          option next to the self-hosted FrameOS backend, not a replacement for
          it. The cloud itself is open source too — you can run your own, though
          we do not recommend it yet.
        </li>
        <li>
          <strong>Tell us what breaks.</strong> Bugs and ideas are welcome on{" "}
          <a href="https://github.com/FrameOS/frameos/issues" rel="noreferrer" target="_blank">
            GitHub
          </a>{" "}
          or{" "}
          <a href="https://discord.gg/9dT9y7EzUw" rel="noreferrer" target="_blank">
            Discord
          </a>
          .
        </li>
      </ul>
    </>
  );
}
