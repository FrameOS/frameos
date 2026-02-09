# Nim Runtime Inventory (for Zig Port)

## Entrypoint
- `frameos/src/frameos.nim`
  - `startFrameOS()` → `newFrameOS()` → `FrameOS.start()`.
  - Boot flow: load config, init logger/metrics, init drivers, start runner, start scheduler, start server.

## Core runtime modules (`frameos/src/frameos/`)
- `frameos.nim`: Constructs `FrameOS`, boot sequence, network check + hotspot handling, then starts runner and server.
- `config.nim`: Runtime configuration loading.
- `logger.nim` / `metrics.nim`: Structured logging + metrics logging.
- `runner.nim`: Orchestrates app/scene execution.
- `scheduler.nim`: Background scheduling.
- `server.nim`: Device API/server lifecycle.
- `portal.nim`: Network portal + hotspot control.
- `apps.nim` / `scenes.nim`: App and scene registries.
- `channels.nim` / `types.nim` / `values.nim`: Core data types and IPC/value primitives.
- `interpreter.nim` / `js_runtime.nim`: Script/runtime support.
- `utils/`: Helper utilities.

## Subsystems outside core
- Apps (`frameos/src/apps/`): app definitions with `data`, `logic`, `render`, plus `legacy`.
- Drivers (`frameos/src/drivers/`): device drivers (`evdev`, `frameBuffer`, `gpioButton`, `httpUpload`, `inkyHyperPixel2r`, `inkyPython`, `waveshare`).
- System scenes (`frameos/src/system/`): system scenes and options (`wifiHotspot`, `index`).
- Scenes (`frameos/src/scenes/`): default scene set + scene registration.
- Lib (`frameos/src/lib/`): shared lib code (`burrito`, `httpclient`, `lgpio`, `tz`, Makefile).

## Notes for Zig parity planning
- Minimum parity boot sequence should mirror: config → logger/metrics → drivers init → runner → scheduler → server.
