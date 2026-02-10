# FrameOS Rust migration strategy (phased)

## Goals
- Ship Rust runtime slices incrementally without regressing production frame behavior.
- Keep rollback simple while parity remains incomplete.

## Phases

1. **Bootstrap + contracts (current)**
   - Establish config/models/manifests with tests.
   - Define CLI and log/event contracts.
   - Deliver deterministic `check` mode for CI and package smoke tests.

2. **Shadow mode runtime wiring**
   - Run Rust process in side-by-side mode where it loads config/manifests and emits lifecycle/validation events without driving hardware.
   - Compare emitted state/logs against Nim runtime for selected frames.

3. **Feature-flagged subsystem replacement**
   - Introduce feature flags by subsystem (example: `RUST_SCENE_LOADER`, `RUST_SERVER`, `RUST_RENDER_LOOP`).
   - Route specific responsibilities to Rust while Nim remains fallback.

4. **Primary runtime with Nim fallback**
   - Rust runtime becomes default launcher path.
   - Keep Nim binary as fallback/rollback for one release window.

5. **Nim retirement**
   - Remove fallback once telemetry + parity tests are green for the agreed soak period.

## Rollout controls
- Environment-gated activation for each feature flag.
- Health checks + startup `check` command in deployment pipelines.
- Incremental hardware cohort rollout (dev → internal frames → small customer cohort → fleet).

## Verification expectations
- Maintain parity map with status per capability.
- Add golden/parity tests for scene + app manifest behavior before runtime takeover.
- Capture representative event logs from Nim and Rust and compare shape/content.
