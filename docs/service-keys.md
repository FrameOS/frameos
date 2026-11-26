# Service keys

An app that calls a third-party API (OpenAI, Unsplash, Home Assistant, …)
needs a key. This is how keys are declared, stored, chosen per scene, sent to
a frame, read by an app and typed on the frame itself. It replaces the six
hard-coded "service settings" groups.

- **The registry**: `repo/services.json` (data, never compiled into a frame).
  Run `python3 frameos/tools/generate_services.py` after changing it; the
  backend suite runs its `--check`.
- **The rules**: `frontend/src/utils/serviceKeys.ts` (the SPA on both planes
  and the cloud server) and its Python port `backend/app/utils/service_keys.py`.
- **The corpus**: `docs/service-keys-fixtures.json`. Runners:
  `cloud/apps/auth-web/src/test/shared-spa/service-keys-fixtures.test.ts`,
  `backend/app/utils/tests/test_service_keys.py`, and for the frame's half
  (`runtime`, `inject`) `frameos/src/frameos/tests/test_service_keys.nim`.

## The idea in one paragraph

A service is a namespace (`openAI`). An app declares the services it uses
(`"settings": ["openAI"]` in its config.json, as before). The owner keeps
keys on the control plane: one **default** per service, typed once, and as
many **named** keys as they like. Each installed scene is **bound** to a key
per service it declares: the default unless the owner picks another, and
nothing for a store scene until the owner says so. A frame is sent each
scene's bindings and only the keys those name, and `frameos.getSetting`
answers an app with **its own scene's** key. A key can also be typed on the
frame, for one scene, and stays there.

## The registry: adding a vendor

```json
"openAI": {
  "title": "OpenAI",
  "description": "Image and text generation in the OpenAI apps.",
  "help": "https://platform.openai.com/api-keys",
  "fields": [{ "name": "apiKey", "label": "API key", "placeholder": "sk-…" }],
  "hosts": ["api.openai.com"]
}
```

- An id matches `^[A-Za-z][A-Za-z0-9_]{0,40}$`, is not a credential id
  (`k_…`), and is never one of a plane's own settings groups (`defaults`,
  `posthog`, `repositories`, `personal`, `ssh_keys`, `buildEnvironment`,
  `buildHost`, `modalSandbox`, `serviceCredentials`), nor a key that travels
  beside the groups (`serviceKeys`, `serviceSettings`).
- A field is **secret** unless it says `"secret": false` (a server URL).
- `hosts` (`host` or `host:port`, https only) and `hostsFrom` (a non-secret
  field holding a URL, whose origin is then allowed) say where a key may be
  sent by placeholder (see "Keys an app never holds"). A service without
  either can be read with `getSetting` only.
- `optional`: the service works without a key, just limited (GitHub).
- The registry is the arbiter of names: a registered id is that vendor.
  Adding one is a pull request of about ten lines and nothing else: no
  plane, firmware or SPA code names a vendor.

## A service the registry does not know

An app may use any id. To give the owner a proper form it can define it in
its config.json:

```json
"settings": ["acmeWeather"],
"services": {
  "acmeWeather": { "title": "Acme Weather", "fields": [{ "name": "apiKey", "label": "API key" }] }
}
```

- The registry wins when it has the id (an app cannot relabel OpenAI).
- An app never says where a key may go (`hosts` is ignored): such a key is
  read with `getSetting` alone.
- Every field of an unregistered service is a secret to the planes (they
  mask what they cannot see defined).
- The editor fills `settings` from the code on save (`getSetting('x', …)`
  and `secret('x', …)` with a literal first argument), as it does for
  `permissions`, and adds a `services` stub for an id the registry does not
  know.

## Keys on the control plane

- **The default key of a service is the settings group named after it**:
  `settings.openAI.apiKey`, where it always was. Any service id is now a
  valid group (each value a map of strings).
- **More keys** live in one settings group, `serviceCredentials`:
  `{ "k_ab12cd34ef56": { "service": "openAI", "name": "Work", "values": { "apiKey": "…" } } }`.
  Ids match `^k_[a-z0-9]{8,24}$` and are made by the SPA (`newCredentialId`).
- **Secret or not** (`serviceFieldSecrecy`): a registered service's field
  says so itself; a field the registry does not list in a registered
  service's group is the plane's own and its own list decides (e.g.
  `openAI.backendApiKey`, Home Assistant's MQTT settings); every field of an
  unregistered service is secret. Every value of `serviceCredentials` follows
  the same rule by its `service`. Masking (GET answers a mask, a mask posted
  back means "keep") works as it did.
- **What a frame may get** (`deliverableServiceValues`): a registered
  service's registry fields only, so a plane's own fields in the same group
  never ship; every string field of an unregistered one; empty strings are
  "not configured" and never sent.

## Which key a scene gets

The install keeps it, like its button map and its layout: `keys` beside
`eventMap` (the backend's `frame.scenes` entry; the cloud's
`frame_scene_assignments.service_keys`). It is the install's, never the
scene's: stripped with `origin` before a publish, never in a template.

```json
"keys": { "openAI": "default", "homeAssistant": "k_ab12cd34ef56", "unsplash": null }
```

`resolveSceneKeyBindings`, for every service the scene's apps declare:

1. the install's own `keys[service]`: `null` (or `false`) is refused,
   `"default"` the default, a credential id that credential if it still
   exists for that service, else refused (a removed key is never swapped for
   another);
2. else `"default"` when the plane's older grant covers it
   (`legacyGranted`): on a backend all a scene the owner made declares, and
   for a store scene (`origin.storeSceneId`) the frame's
   `service_setting_groups`; on the cloud the assignment's grant
   (`grantedSettingsGroupsForAssignment`);
3. else refused.

A binding for a service no app declares means nothing. The SPA writes
`keys` for every declared service when the owner chooses ("Keys" in the
scene menu, and the install dialog of a store scene); the older grant only
answers for scenes nobody chose for yet.

The preview a frame shows (`scene_preview`) is bound by the same rule with
no `keys`: a scene the owner made gets the defaults, a store scene nothing.

## On the wire

Every frame-facing payload that carried `settings` carries `serviceKeys`
beside it, built by `buildServiceKeysWire`:

```json
"serviceKeys": {
  "v": 1,
  "keys": {
    "openAI":        { "service": "openAI", "values": { "apiKey": "sk-…" } },
    "k_ab12cd34ef56": { "service": "homeAssistant", "values": { "url": "https://cabin…", "accessToken": "…" } }
  },
  "scenes": {
    "art":       { "openAI": "openAI" },
    "cabin":     { "homeAssistant": "k_ab12cd34ef56" },
    "store-art": { "openAI": null }
  },
  "services": {
    "openAI": { "title": "OpenAI", "fields": [{ "name": "apiKey", "label": "API key" }], "hosts": ["api.openai.com"] },
    "homeAssistant": { "title": "Home Assistant", "fields": [{ "name": "url", "label": "Home Assistant URL", "secret": false }, { "name": "accessToken", "label": "Access token" }], "hostsFrom": "url" }
  }
}
```

- `scenes`: every scene on the frame that declares a service, by its id on
  the frame (a backend's scene id, the cloud's runtime scene id), each
  declared service named: a key id, or `null` when refused. A scene with no
  entry gets no key.
- `keys`: only the keys `scenes` names and that have a value; a default's id
  is the service id, any other key's its credential id. A name in `scenes`
  with no entry in `keys` is a key the owner has not filled in.
- `services`: the title and field labels of every service `scenes` names
  (the frame's "Keys" page draws them; no registry on the frame), with
  `hosts` / `hostsFrom`.
- `settings` stays, for runtimes that do not read `serviceKeys`: one set of
  values per service bound anywhere, the default's when any scene uses it,
  else the first credential bound by id. An older runtime therefore behaves
  as before (one key per service, frame-wide).

Where it goes:

| Path | Today | Adds |
|---|---|---|
| Pi via a backend | frame.json `settings` (deploy) | frame.json `serviceKeys`; the settings fingerprints include it |
| ESP32 via a backend | the embedded settings pull, groups at top level | `serviceSettings` (the groups, by name, so the firmware needs no list) and `serviceKeys` |
| Any frame via the cloud | `GET …/service-settings` `{settings, groups}` | `serviceKeys` in the same body (the ETag covers it); `groups` lists every service bound anywhere |
| Rendered on a plane (thin clients, `render_mode: remote`, virtual frames) | the wasm config's `settings` | `serviceKeys` the same way |
| The browser preview | `settings` after consent | nothing: a preview runs one scene, and `settings` stays its source |

The wasm runtime takes it any of three ways: beside the groups in
`frameos_wasm_init`'s settings JSON, as `serviceKeys` in
`frameos_wasm_set_frame`'s object, or alone through
`frameos_wasm_set_service_keys` after init. The firmware hands its runtime
`{"settings", "serviceKeys", "groups"}` (`fos_settings.c`, which keeps no
list of services: an older backend's groups are every object at the root
but `frame` and `schedule`), at most 16 KB.

Keys never travel over a command queue (the cloud's `refresh_service_settings`
nudge stays zero-payload) and never into scene JSON, state, `app.frame`,
templates, logs or the Home Assistant topics.

## On the frame

`frameos.getSetting(service, field?)` in an app whose config declares
`service` (unchanged gate) answers, for the app's own scene:

1. when the config has `serviceKeys`: `keys[scenes[sceneId][service]].values`;
   a scene not in `scenes` or a `null` is nothing; a key id with no entry in
   `keys` (the plane has no value for it) falls back to `settings[service]`,
   which is where a Pi keeps what was typed on its own admin page;
2. else (a frame with no plane, an older plane): `settings[service]` as before;
3. over either, the keys typed on the frame (below), field by field, unless
   the binding is `null`; a typed address takes its group whole.

With no field it answers the group: the bound values with the typed ones
over them. The app's own scene is the scene its node belongs to (a split's
panel is its own scene, not the split's).

The runtime takes any service id: no list of groups anywhere on a frame.
A plane's pull REPLACES what the plane owns: every group it sent, every group
it sent last time (kept with the config), and on the cloud the six groups it
always owned; local groups stay. On an ESP32 `settings` and `serviceKeys`
live in RAM and the pull's cache, as before; the cap is 16 KB.

### Keys an app never holds: `frameos.secret`

`frameos.secret('openAI', 'apiKey')` returns the placeholder
`{{key:openAI.apiKey}}`, or `undefined` when the app does not declare the
service or its scene has no value there (so an app can say which key is
missing, and learns nothing more). A request the app makes — `fetch`, `frameos.fetchJson`,
`frameos.fetchImage`, `useFetch` — has each placeholder in its URL's path or
query, or in a header value, replaced on the way out:

- the app must declare the service (`undeclared`), and its scene must have
  a value for that field (`missing`);
- a placeholder in the scheme or authority is refused (`placement`);
- when the config has `serviceKeys`, the request's origin must be allowed
  for that service (`host`): `https://` + a `hosts` entry (default port
  unless the entry names one), or exactly the origin of the `hostsFrom`
  field's value (scheme, host, port); a look-alike, another port, plain http
  to a registry host, a user-info trick: refused. With no `serviceKeys`
  (a frame with no plane) any origin is allowed;
- in a URL the value is percent-encoded (everything but `A-Za-z0-9-._~`);
  in a header it is sent as it is, and a value holding a control character
  is refused (`value`);
- a key goes only into a header the HTTP clients drop when a redirect leaves
  the origin (`Authorization`, `Proxy-Authorization`, `Cookie`,
  `X-Api-Key`); any other header is refused (`header`);
- a refused request is not sent, and the app's call fails with
  `key not allowed: <reason>` naming the origin only;
- so a redirect to another origin is never followed with a header that
  carried a key.

Prefer `secret` to `getSetting` in an app that only sends its key to the
vendor: a store scene with such an app cannot send the key elsewhere.
`getSetting` stays for apps that must compute with a key (a signature), and
because a scene must run on runtimes without `secret`
(`typeof frameos.secret === 'function'`).

### Typing a key on the frame

The frame page's **Service keys** (`system/sceneSettings`,
docs/scene-settings.md "Service keys") is where a key is typed on the frame:
one for the whole frame, as on the plane, so the same OpenAI key is typed
once. It lists every service the frame knows of (the plane's
`serviceKeys.services` with their labels, the services of the scene it was
opened from, the groups it holds and those typed), no list of its own; a
secret of the plane's shows only as "Saved". Only while the frame offers
its page (`frame_settings_on_screen`).

- Kept on the device only, never told to a plane (as the Wi-Fi network): a
  Pi's `state/service_keys.json` (0600), an ESP32's NVS (`svc_typed`), at
  most 4 KB (`frame_service_keys.nim`).
- Field by field it wins over what the plane gave a scene, for every scene
  the owner did **not** refuse that service: a typed key never undoes a
  "Don't give a key". A scene the plane does not know (made on the frame)
  gets it too.
- An address typed there (the service's `hostsFrom` field, else `url`)
  takes its group whole: a plane's token never goes to an address somebody
  at the frame typed, so the token for it is typed too.
- It is what a frame with no plane uses for a key at all.

## What changed from "service settings"

- Six groups hard-coded in eight places (backend schema and masking, the
  cloud's deliverable fields and account fields, the SPA's titles and forms,
  the Linux runtime's admin fields and cloud groups, the firmware's group
  list) are now the registry.
- A grant used to reach the whole frame: a store scene nobody granted
  OpenAI read the key anyway when another scene on the frame used it. Keys
  are now per scene on the frame.
- One key per service per account became a default plus named keys, chosen
  per installed scene.
