# The iOS app on the App Store

How the app (`ios/`, `docs/ios-app.md`) gets to TestFlight and through App
Review, and where it stands against the App Review Guidelines.

## Against the guidelines

| Guideline | What it asks | Where the app stands |
| --- | --- | --- |
| 4.8 Login Services | An app offering a third-party login (Google) must also offer an equivalent login that keeps the email private: in practice **Sign in with Apple** | The native "Continue with Apple" button above Google (`POST /api/auth/apple/native`), and on the cloud's web pages; needs the cloud's Apple key, below |
| 5.1.1(v) Account deletion | An app where accounts can be made (Google sign-in creates one) deletes them in the app | Settings → Delete account (`POST /api/account/delete`: the password, or a fresh check of who you are plus the typed email) |
| 5.1.1(i) Privacy policy | A link in the app and in App Store Connect | Settings → About → Privacy policy, Terms (`cloud.frameos.net/legal/…`) |
| 5.1.2(i) Data shared with third-party AI | Say so and ask before sharing | The AI chat asks once before the first message ("Before you chat"): messages and frame details go to OpenAI |
| 1.2 User-generated content | Report objectionable content, act on reports, contact details | Store scenes: "Report this scene" (`POST /api/store/scenes/{id}/report`, the cloud's report queue); the store's moderation and `/admin/reports`; the support address on every cloud page |
| 3.1.1 / 3.1.3(f) In-app purchase | A free companion to a paid web service may skip in-app purchase only with no purchasing and no calls to buy outside the app | No plan, pricing or billing links in the app (the plan is shown, not sold); the cloud's sign-in pages inside the app's sheet leave out "Pricing" (`AuthCard inApp`) |
| 2.1 App completeness | Works for the reviewer | Needs a demo account, below |
| 2.5.1 / Privacy manifest | `PrivacyInfo.xcprivacy` declares required-reason APIs and collected data | `ios/FrameOS/PrivacyInfo.xcprivacy`: UserDefaults (CA92.1); email, name (from Apple or Google sign-in), photos, other user content, for app functionality; no tracking |
| App Transport Security | Justify arbitrary loads | A self-hosted backend is often plain http on the owner's own network or hostname; the cloud is https. Say so in the review notes |
| Export compliance | Declare encryption | `ITSAppUsesNonExemptEncryption: false` (HTTPS only), so uploads skip the question |
| 4.2 Minimum functionality | More than a website | Native screens for frames, scenes, photos, assets, logs, AI |
| App icon, launch screen | 1024 px icon without transparency; a launch screen | Both in `ios/FrameOS` |

### Sign in with Apple

The app's sign-in screen has the system's "Continue with Apple" button first,
then Google and the web's other ways. The cloud side (both the app's native
route and "Continue with Apple" on the web) is `cloud/docs/auth.md` "Sign in
with Apple"; the App ID `net.frameos.app` has the capability (Xcode's
automatic signing switched it on with the first export that carried the
entitlement), and `ios/bin/release` keeps the entitlement through its
unsigned archive (an ad hoc signature carries it to the export).

FrameOS Cloud's Apple setup (`cloud/docs/auth.md` "Sign in with Apple",
steps 2 to 4) is done and live since 2026-11-12: the Services ID for the
web, the Sign in with Apple key (`APPLE_TEAM_ID`, `APPLE_SIGN_IN_KEY_ID`,
`APPLE_SIGN_IN_PRIVATE_KEY`, `APPLE_SERVICES_ID` on the server), and the
mail domain registered for Apple's private relay; TestFlight build
202611120152 signed in with it. Without the key the app's button answers
"Sign in with Apple is not set up on this FrameOS Cloud".

## Before the first upload (yours)

1. The Apple Developer Program membership the app is published under (the
   seller's name shows on the store). The seller is **Raaven BV**: the
   membership (team `UG8G36W2HB`) was an individual one, and its change to
   an organization was asked of Apple on 2026-11-12. Submit after it is
   through, or the store lists a person as the seller and, in the EU, shows
   their own address as the trader's.
2. In App Store Connect → Apps → New App: name **FrameOS**, the bundle id
   `net.frameos.app` (register it under Certificates, Identifiers & Profiles
   if it is not offered), a SKU.
3. An App Store Connect API key for uploads: Users and Access → Integrations →
   App Store Connect API, role App Manager. Download the `.p8` once.
4. Deploy FrameOS Cloud with the app's routes before anyone reviews the app:
   the sign-in sheet's `/api/auth/app/*`, `/api/auth/apple/native` and the
   in-app pages need it, and the Apple key above.

## TestFlight on your phone

```sh
brew install xcodegen
FRAMEOS_IOS_TEAM=<team id> ASC_KEY_ID=<key id> ASC_ISSUER_ID=<issuer id> \
  ASC_KEY_PATH=~/.appstoreconnect/AuthKey_<key id>.p8 ios/bin/release
```

`ios/bin/release` archives for devices unsigned, signs at export (Xcode makes
the Apple Distribution certificate and the App Store profile the first time;
no registered device is needed), sets the build number to the UTC time, and
uploads. Without an API key it uses the account signed in to Xcode → Settings
→ Accounts.
The build appears in App Store Connect → TestFlight after processing (a few
minutes). Add yourself under Internal Testing, install TestFlight on the
iPhone, and accept the invite. Internal testers need no review.

Without TestFlight: connect the iPhone, turn on Developer Mode on it, run
`ios/bin/open`, pick your team under Signing & Capabilities and the phone as
the destination, then Run.

`ios/bin/release --unsigned` only checks that the device build archives.

## Submitting for review

- **Version**: `MARKETING_VERSION` in `ios/project.yml` (the FrameOS release
  it was built beside, e.g. 2026.11.6).
- **Category**: Utilities. **Price**: free.
- **Subtitle**: "Control your smart frames".
- **Description** (draft): "FrameOS runs e-ink and LCD picture frames that
  show what you choose: your photos, the weather, your calendar, art, clocks
  and more. This app is the remote for them. See every frame and what it
  shows, switch scenes, install new ones from the scene store, change their
  settings, schedule them, upload photos into albums and play them on a frame,
  manage files, read logs, and ask the AI to make a scene. Works with FrameOS
  Cloud and with a FrameOS backend you run yourself."
- **Keywords**: frame, eink, e-paper, picture frame, smart display, dashboard,
  photos, raspberry pi, esp32.
- **URLs**: support `https://frameos.net`, privacy policy
  `https://cloud.frameos.net/legal/privacy`.
- **Age rating**: answer yes to user-generated content (store scenes).
- **App Privacy** (App Store Connect's labels, matching the manifest):
  Contact Info → Name, Email Address; User Content → Photos or Videos, Other
  User Content. All linked to the user, for App Functionality, none for
  tracking. The name is the one Apple or Google gives at sign-in (the
  account's display name).
- **Screenshots**: 6.9-inch iPhone and 13-inch iPad. `ios/bin/ui-test` writes
  every screen to `ios/ui-test-shots/`: run the tour on "iPhone 18 Pro Max"
  and "iPad Pro 13-inch (M5)" (`FRAMEOS_UITEST_DEVICE`) against a backend with
  good-looking scenes and photos.
- **Review notes**: a demo FrameOS Cloud account (email and password; no
  two-factor) with one or two virtual frames that have scenes and an album, so
  every screen has something on it. Say that a self-hosted backend is the
  owner's own server (often plain http on their network: the reason for the
  ATS exception), that the AI chat sends text to OpenAI after asking, that
  store scenes can be reported from the install sheet, and where account
  deletion is (Settings → Delete account).
