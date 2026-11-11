# The iOS app on the App Store

How the app (`ios/`, `docs/ios-app.md`) gets to TestFlight and through App
Review, and where it stands against the App Review Guidelines.

## Against the guidelines

| Guideline | What it asks | Where the app stands |
| --- | --- | --- |
| 4.8 Login Services | An app offering a third-party login (Google) must also offer an equivalent login that keeps the email private: in practice **Sign in with Apple** | **Open: the one decision left**, below |
| 5.1.1(v) Account deletion | An app where accounts can be made (Google sign-in creates one) deletes them in the app | Settings → Delete account (`POST /api/account/delete`: the password, or a fresh check of who you are plus the typed email) |
| 5.1.1(i) Privacy policy | A link in the app and in App Store Connect | Settings → About → Privacy policy, Terms (`cloud.frameos.net/legal/…`) |
| 5.1.2(i) Data shared with third-party AI | Say so and ask before sharing | The AI chat asks once before the first message ("Before you chat"): messages and frame details go to OpenAI |
| 1.2 User-generated content | Report objectionable content, act on reports, contact details | Store scenes: "Report this scene" (`POST /api/store/scenes/{id}/report`, the cloud's report queue); the store's moderation and `/admin/reports`; the support address on every cloud page |
| 3.1.1 / 3.1.3(f) In-app purchase | A free companion to a paid web service may skip in-app purchase only with no purchasing and no calls to buy outside the app | No plan, pricing or billing links in the app (the plan is shown, not sold); the cloud's sign-in pages inside the app's sheet leave out "Pricing" (`AuthCard inApp`) |
| 2.1 App completeness | Works for the reviewer | Needs a demo account, below |
| 2.5.1 / Privacy manifest | `PrivacyInfo.xcprivacy` declares required-reason APIs and collected data | `ios/FrameOS/PrivacyInfo.xcprivacy`: UserDefaults (CA92.1); email, photos, other user content, for app functionality; no tracking |
| App Transport Security | Justify arbitrary loads | A self-hosted backend is often plain http on the owner's own network or hostname; the cloud is https. Say so in the review notes |
| Export compliance | Declare encryption | `ITSAppUsesNonExemptEncryption: false` (HTTPS only), so uploads skip the question |
| 4.2 Minimum functionality | More than a website | Native screens for frames, scenes, photos, assets, logs, AI |
| App icon, launch screen | 1024 px icon without transparency; a launch screen | Both in `ios/FrameOS` |

### Sign in with Apple: decide one

The app offers "Continue with Google" (through FrameOS Cloud's own sign-in
page, `cloud/docs/auth.md` "Signing in to the app"). Guideline 4.8 then wants
an equivalent login with private email, and App Review reads that as Sign in
with Apple. Two ways:

1. **Add Sign in with Apple to FrameOS Cloud**, on the web and in the app
   (recommended: Google stays). Cloud work: Apple as a second OIDC provider
   beside Google (the web's form-post callback, and a route that takes the
   app's native Apple identity token), account linking as Google's does it,
   the private relay addresses (register the sending domain with Apple so
   verification and reset mail reaches them), and revoking Apple's tokens when
   an account is deleted (Apple requires it). Apple setup on your side: the
   app's Sign in with Apple capability, a Services ID for the web, a key
   (`.p8`).
2. **Ship 1.0 without Google in the app**: drop "Continue with Google" and hide
   Google on the cloud's pages in the app's sheet. The app then uses FrameOS
   Cloud's own accounts only (4.8's exception); someone who signed up with
   Google adds a password through "Forgot your password?" and signs in with
   it. Add Google and Apple together in a later version.

TestFlight's internal testing is not reviewed against this; App Review (and
an external TestFlight beta review) is.

## Before the first upload (yours)

1. The Apple Developer Program membership the app is published under (the
   seller's name shows on the store).
2. In App Store Connect → Apps → New App: name **FrameOS**, the bundle id
   `net.frameos.app` (register it under Certificates, Identifiers & Profiles
   if it is not offered), a SKU.
3. An App Store Connect API key for uploads: Users and Access → Integrations →
   App Store Connect API, role App Manager. Download the `.p8` once.
4. Deploy FrameOS Cloud with this branch before anyone reviews the app: the
   sign-in sheet's `/api/auth/app/*` and the in-app pages need it.

## TestFlight on your phone

```sh
brew install xcodegen
FRAMEOS_IOS_TEAM=<team id> ASC_KEY_ID=<key id> ASC_ISSUER_ID=<issuer id> \
  ASC_KEY_PATH=~/.appstoreconnect/AuthKey_<key id>.p8 ios/bin/release
```

`ios/bin/release` archives for devices (automatic signing creates the
certificate and profile), sets the build number to the UTC time, and uploads.
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
  Contact Info → Email Address; User Content → Photos or Videos, Other User
  Content. All linked to the user, for App Functionality, none for tracking.
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
