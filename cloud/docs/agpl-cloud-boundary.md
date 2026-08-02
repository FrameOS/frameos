# AGPL And Cloud Service Boundary

> **Note (2026-07):** FrameOS Cloud now lives in this monorepo under `cloud/`
> and is AGPL-3.0-only like the rest of it, so the *license* boundary this
> document polices no longer exists. The *service* boundary rules below —
> FrameOS runs fully without the cloud, the protocol stays reimplementable by
> third parties — still apply. See `docs/cloud-frames.md`.

The AGPL FrameOS codebase remains a complete self-hosted FrameOS product.
FrameOS Cloud is a separately operated hosted service.

FrameOS should be able to run without FrameOS Cloud. The default auth provider
URL can point at `https://cloud.frameos.net`, a compatible alternate provider, or
be disabled by the self-hosted operator.

FrameOS Cloud owns hosted-service state:

- Cloud accounts.
- Linked backend records.
- Backend-link credentials, consent events, and audit events.

Local FrameOS backend data remains local. FrameOS Cloud currently does not
define cloud organizations, projects, memberships, hosted backends, billing,
quotas, backup, or storage state.
