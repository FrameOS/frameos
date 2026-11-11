# FrameOS for iOS

A native SwiftUI app (iOS 17 and up, iPhone and iPad) for FrameOS Cloud and
self-hosted FrameOS backends. What it does, which routes it calls and how it
stays in step with the web workspace: `docs/ios-app.md`.

## Run it

You need Xcode and [XcodeGen](https://github.com/yonaskolb/XcodeGen):

```sh
brew install xcodegen
ios/bin/open          # generates FrameOS.xcodeproj from project.yml and opens it
```

Pick a simulator or your phone and run. To run on a phone, choose your team
under Signing & Capabilities (the bundle id is `net.frameos.app`; change it
if your team cannot use it).

The project file is generated and not committed: edit `project.yml`, never
the `.xcodeproj`.

## Layout

| | |
| --- | --- |
| `FrameOS/` | the app target: `FrameOSApp.swift` (the entry point) and the assets (icon, logo, accent color) |
| `FrameOSKit/` | a Swift package with no UI: the two control planes' clients (`Core/APIClient.swift` is the app's `apiFetch`), the models, the contract readers (`Contracts/`), the generated tables (`Generated/`, written by `frameos/tools/generate_*_contract.py`) and the services (`Services/`, one per area of the workspace) |
| `FrameOSKit/Tests/` | the runners of the repo's shared corpora (`docs/*-fixtures.json`) and the client's own tests |
| `FrameOSUI/` | a Swift package with the screens, one folder per tab; each screen's state is an `@Observable` model next to it |
| `project.yml` | the XcodeGen spec |
| `bin/` | `open`, `test`, `check-ui` |

## Without Xcode

Most of the app builds with only the Command Line Tools:

```sh
ios/bin/test        # FrameOSKit's tests: the corpora, the contracts, the client
ios/bin/check-ui    # type-checks every screen for macOS
```

Against real planes (skipped unless asked for):

```sh
# An EMPTY self-hosted backend (it creates an account and a frame there):
FRAMEOS_IT_BACKEND=http://127.0.0.1:8997 ios/bin/test --filter BackendIntegrationTests
# A cloud, read-only (a wrong-password sign-in, the public store):
FRAMEOS_IT_CLOUD=http://localhost:3000 ios/bin/test --filter CloudProbeTests
```

A throwaway backend for the first: from `backend/`, with its own SQLite
(`DATABASE_URL=sqlite:////tmp/fos.db python -m alembic upgrade head`) and
Redis (`redis-server --port 6391`, `REDIS_URL=redis://localhost:6391/0`),
`uvicorn app.fastapi:app --port 8997` with `PYTHONPATH=.` and a `SECRET_KEY`.

The screens are written to compile for macOS too (`Common/Platform.swift`
wraps what is iOS-only), which is what makes `check-ui` possible. The iOS
build itself needs Xcode: CI's **iOS app** job (`.github/workflows/ios.yml`)
builds the app for the simulator on every change under `ios/` and to the
corpora and contracts it reads.

## Signing in

- **FrameOS Cloud**: email and password, then the code from your
  authenticator when the account has two-factor sign-in. The session cookie
  is kept in the Keychain and slides like the web's (30 days idle). An action
  the cloud keeps for a recent sign-in (deleting a frame) asks for the
  password or code again. Signing up, a password reset and Google sign-in
  open the web (a Google account can add a password through "Forgot your
  password?").
- **Self-hosted backend**: its address (`frames.local:8989`,
  `https://frames.example.com`; read like every plane reads a typed address,
  `docs/server-address-fixtures.json`), email and password. A backend
  without an account yet offers to create the first one. The app keeps a
  year-long API token, named "FrameOS iOS app" on the backend's API tokens
  page, and revokes it at sign-out. A backend behind Home Assistant ingress
  cannot be reached by an app: use its own address.
