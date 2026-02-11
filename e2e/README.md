
```bash
cd e2e                 # come to this folder
./run                  # run all Nim-based snapshot tests
./run dataGradient     # run one Nim-based scene test
./run --zig            # run Zig parity snapshot harness (no Nim build/download)
./run --zig blue       # run one Zig parity snapshot by filter
```


- `./run --zig` auto-builds `../zig/zig-out/bin/scene_renderer` when needed (`zig build`) and uses it for per-scene output before image-diff checks.
