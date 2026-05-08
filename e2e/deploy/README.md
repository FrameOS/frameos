# Deploy E2E Test

The real SSH deploy integration test is opt-in because it starts an SSH target
and writes the same system paths as a deploy (`/srv/frameos` and
`/etc/systemd/system/frameos.service`).

Run it against the bundled disposable Docker SSH target:

```bash
cd backend
TEST=1 FRAMEOS_E2E_DEPLOY=1 pytest app/tasks/tests/test_real_ssh_deploy_e2e.py -s
```

To run against a disposable VM or server instead of Docker, provide the SSH
target explicitly:

```bash
cd backend
TEST=1 FRAMEOS_E2E_DEPLOY=1 \
FRAMEOS_E2E_DEPLOY_HOST=192.0.2.10 \
FRAMEOS_E2E_DEPLOY_PORT=22 \
FRAMEOS_E2E_DEPLOY_USER=frame \
FRAMEOS_E2E_DEPLOY_PASSWORD=framepass \
pytest app/tasks/tests/test_real_ssh_deploy_e2e.py -s
```

The target must be a throwaway Debian/Ubuntu-like host with non-interactive
sudo. The test deploys over real SSH/SCP and covers:

- full deploy with on-device compilation path
- fast deploy
- full deploy with backend cross-compiled binary path
- full deploy with precompiled binary path

The test runs the real FrameOS binary builder. It generates Nim C sources,
compiles a release over SSH on the target, builds a backend cross-compiled
release through Docker, packages that compiled binary as a local precompiled
release archive, downloads it through the precompiled release code path, and
deploys it over SSH.
