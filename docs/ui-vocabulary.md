# UI vocabulary — the verbs for getting things onto a frame

*Decided 2026-09-12 (the last item of the 2026-09-09 review's frontend
list). Every label, heading, tooltip and toast in the workspace uses these
verbs with these meanings. Prose may describe the mechanism in plain words
("sends the scene list", "queues a notification"); the named action never
changes. When a label needs a verb this page does not list, add it here
first.*

| Verb | Means | Where you see it |
| --- | --- | --- |
| **Install** | Put something where it was not yet: a scene onto a frame's scene list, or FrameOS onto a host. | "Install on frame", "Install all starred scenes", "Approve and install" (chat), "Install over SSH", "Install with a script", "Installation mode", "Install precompiled binaries" |
| **Deploy** | Send the frame's saved scenes and settings (and, for a full deploy, FrameOS itself) to the device, over whatever transport the frame has. | The drawer heading, the sidebar button, "Fast deploy" / "Full deploy", "Deploy scenes & settings" (cloud OTA), "Deploy scenes over USB", the pending-command rows "Deploy scenes" / "Deploy settings", "Deploy & activate", "Deploy Remote" |
| **Update** | Replace something already there with its newer version. | "Update FrameOS" (Pi release, both control planes), "Update firmware" (ESP32 OTA and USB), "Update scene" (a newer version in the repository or store), "Update timezone data" |
| **Sync** | Reconcile changes made on the device itself (its admin panel) with the workspace. Two-way, so it is not a deploy. | The sidebar button and drawer title while the frame reports local changes, "Sync changes detected" |
| **Activate** | Show a scene on the frame now. On the active scene the same action is **Apply** (it re-sends the state fields). | "Activate scene", "Save, deploy & activate", "Apply to active scene" |

Not user-facing, ever: **push** (the cloud command queue's own name for a
`set_scenes` / `set_settings` command — fine in code and comments, never in a
label), **upgrade** (the device runtime's name for its release swap),
**redeploy**. "Reinstall" is allowed for a scene already on the frame's list.

Install and deploy compose: installing a scene adds it to the list; the
device shows it once it is deployed. The chat proposal card says exactly that
("Installed; the deploy lands when the frame reconnects").

## Where the words are pinned

- `cloud/apps/auth-web/src/test/shared-spa/frame-vocabulary.test.ts` scans
  every string literal and JSX text in `frontend/src` for the banned verbs
  at label position, and pins the pending-command labels.
- `cloud-deploy-dialog.test.tsx` renders the cloud deploy drawer and asserts
  its headings and buttons by name; `scene-control-notice.test.ts` pins the
  scene drawer's "Save & deploy" / "Deploy changes" / "Deploy to frame".
- `e2e/frontend-visual/tests/frontend-e2e.spec.ts` ("frame workspace deploy
  vocabulary") opens the self-hosted deploy drawer from the sidebar's Deploy
  button; `visual-cloud-frames-workspace.spec.ts` does the same for a cloud
  Pi frame. Both fail on any "push" / "upgrade" wording inside the drawer.
