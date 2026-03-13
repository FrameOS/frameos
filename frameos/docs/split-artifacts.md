# Split FrameOS artifacts

FrameOS can now load runtime extensions from separate shared objects:

- `FRAMEOS_SCENE_MODULES_DIR` → directory of scene modules (`*.so`)
- `FRAMEOS_DRIVER_MODULES_DIR` → directory of driver modules (`*.so`)

## Build

From `frameos/`:

```bash
make build
```

This builds:

- core binary: `build/frameos`
- scene modules: `build/modules/scenes/*.so`
- driver modules: `build/modules/drivers/*.so`

## Runtime loading ABI

### Scene module exports

A scene module should export:

- `frameosSceneId(): cstring`
- `frameosSceneName(): cstring` (optional)
- `frameosGetExportedScene(): pointer`

### Driver module exports

A driver module may export any of:

- `frameosDriverInit(frameOS: pointer)`
- `frameosDriverRender(image: pointer)`
- `frameosDriverToPng(rotate: cint): cstring`
- `frameosDriverTurnOn()`
- `frameosDriverTurnOff()`

## Deployment strategy

Use content-hash based rollout with three channels:

1. `frameos-core` (`build/frameos`) – updated on every FrameOS release.
2. `frameos-scenes` (`build/modules/scenes/*.so`) – updated only when scene modules change.
3. `frameos-drivers` (`build/modules/drivers/*.so`) – updated only when driver modules change.

Recommended flow:

1. Calculate SHA256 for core + each module.
2. Compare with hashes already present on the frame.
3. Upload only changed files.
4. Keep modules under stable paths:
   - `/srv/frameos/modules/scenes`
   - `/srv/frameos/modules/drivers`
5. Start FrameOS with matching env vars so it loads installed modules.
