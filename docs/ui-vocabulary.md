# UI vocabulary — the verbs for getting things onto a frame

*Decided 2026-09-12 (the last item of the 2026-09-09 review's frontend
list); revised 2026-10-20, when **push** became the verb for scenes and
**deploy** narrowed to settings and FrameOS. Every label, heading, tooltip
and toast in the workspace uses these verbs with these meanings. Prose may
describe the mechanism in plain words ("sends the scene list", "queues a
notification"); the named action never changes. When a label needs a verb
this page does not list, add it here first.*

| Verb | Means | Where you see it |
| --- | --- | --- |
| **Install** | Put something where it was not yet: a scene onto a frame's scene list, or FrameOS onto a host. | "Install on frame", "Install all starred scenes", "Approve and install" (chat), "Install over SSH", "Install with a script", "Installation mode", "Install precompiled binaries", the overview's "3 scenes installed" |
| **Push** | Send scenes to the frame, and nothing else. From the scene drawer: the scene and the connected scenes it draws or switches to that have changes (`frontend/src/utils/scenePush.ts`), saved first on the backend; every other unsaved edit stays unsaved. Elsewhere: the frame's scene list (a cloud frame's `set_scenes`, a board over USB). | "Push to frame", "Push & activate", "Save & push" (scene drawer), "Push scenes over USB", the pending-command row "Push scenes", the cloud progress bar's "Push scenes", "Installed and pushed" (chat), the scene list's "not pushed" tag |
| **Deploy** | Send the frame's settings to the device, with its saved scenes, and FrameOS itself when that is deployed too. Settings and FrameOS are only ever deployed, never pushed. | The drawer heading, the sidebar button, "Deploy scenes & settings" / "Deploy FrameOS, scenes & settings" (Pi), "Deploy scenes & settings" / "Deploy new firmware" / "Deploy both" (backend ESP32), "Deploy scenes & settings" (cloud OTA), the pending-command row "Deploy settings", "Deploy Remote" |
| **Preview** | Show a scene for now without saving or pushing it, on the frame or in the browser. | "Preview on frame", "Preview in browser" |
| **Update** | Replace something already there with its newer version. | "Update FrameOS" (Pi release, both control planes), "Update firmware" (ESP32 OTA and USB), "Update scene" (a newer version in the repository or store), "Update timezone data" |
| **Sync** | Reconcile changes made on the device itself (its admin panel) with the workspace. Two-way, so it is not a deploy. | The sidebar button and drawer title while the frame reports local changes, "Sync changes detected" |
| **Activate** | Show a scene on the frame now. On the active scene the same action is **Apply** (it re-sends the state fields). A scene with changes is pushed as it is activated. | "Activate scene", "Push & activate", "Apply to active scene", "Save & activate scene" (on the device) |

Not user-facing, ever: **upgrade** (the device runtime's name for its
release swap) and **redeploy**. "Reinstall" is allowed for a scene already
on the frame's list. "Deploy" never takes scenes alone as its object
("Deploy scenes" is a push); "Deploy scenes & settings" is a deploy.

Install, push and deploy compose: installing a scene adds it to the list;
the device shows it once it is pushed. The chat proposal card says exactly
that ("Installed; the push lands when the frame reconnects").

## Where the words are pinned

- `cloud/apps/auth-web/src/test/shared-spa/frame-vocabulary.test.ts` scans
  every string literal and JSX text in `frontend/src` for the banned verbs
  at label position and for "deploy" with scenes alone as its object, and
  pins the pending-command labels.
- `cloud-deploy-dialog.test.tsx` renders the cloud deploy drawer and asserts
  its headings and buttons by name; `scene-control-notice.test.ts` pins the
  scene drawer's "Save & push" / "Push to frame", and `scene-push.test.ts`
  its main action ("Push to frame" / "Push & activate") and what a push
  sends.
- `e2e/frontend-visual/tests/frontend-e2e.spec.ts` ("frame workspace deploy
  vocabulary") opens the self-hosted deploy drawer from the sidebar's Deploy
  button; `visual-cloud-frames-workspace.spec.ts` does the same for a cloud
  Pi frame. Both fail on any "upgrade" wording inside the drawer.
