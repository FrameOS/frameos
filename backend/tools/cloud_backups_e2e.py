#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from pathlib import Path
from typing import Iterable
from urllib.parse import parse_qs, urlparse

import httpx


REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPO_ROOT / "backend"
DEFAULT_CLOUD_REPO = REPO_ROOT.parent / "frameos-docs"


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def copy_cloud_repo(source: Path, destination: Path) -> None:
    ignore = shutil.ignore_patterns(".git", ".next", ".data", "node_modules")
    shutil.copytree(source, destination, symlinks=True, ignore=ignore)
    source_node_modules = source / "node_modules"
    if source_node_modules.exists():
        os.symlink(source_node_modules, destination / "node_modules", target_is_directory=True)


class RunningProcess:
    def __init__(self, command: list[str], cwd: Path, env: dict[str, str], verbose: bool = False):
        self.command = command
        self.cwd = cwd
        self.verbose = verbose
        self.lines: deque[str] = deque(maxlen=240)
        self.process = subprocess.Popen(
            command,
            cwd=str(cwd),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        self.reader = threading.Thread(target=self._read_output, daemon=True)
        self.reader.start()

    def _read_output(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            clean = line.rstrip()
            self.lines.append(clean)
            if self.verbose:
                print(f"[cloud] {clean}")

    def stop(self) -> None:
        if self.process.poll() is not None:
            return
        self.process.terminate()
        try:
            self.process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=8)

    def assert_running(self) -> None:
        code = self.process.poll()
        if code is not None:
            logs = "\n".join(self.lines)
            raise RuntimeError(f"Cloud app exited with code {code}.\n\nRecent output:\n{logs}")


async def wait_for_cloud(base_url: str, process: RunningProcess, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    async with httpx.AsyncClient(base_url=base_url, timeout=2.0) as client:
        while time.monotonic() < deadline:
            process.assert_running()
            try:
                response = await client.get("/api/auth/me")
                if response.status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            await asyncio.sleep(0.5)

    logs = "\n".join(process.lines)
    raise TimeoutError(f"Cloud app did not become ready at {base_url}.\n\nRecent output:\n{logs}")


def envelope(*, with_kdf: bool = False) -> dict[str, object]:
    payload: dict[str, object] = {
        "version": 1,
        "algorithm": "AES-256-GCM",
        "encoding": "base64url",
        "iv": "MTIzNDU2Nzg5MDEy",
        "ciphertext": "Y2lwaGVydGV4dC1kYXRhLWZvci1lMmU",
    }
    if with_kdf:
        payload.update(
            {
                "kdf": "PBKDF2-SHA-256",
                "iterations": 250000,
                "salt": "c2FsdC1mb3ItZTJl",
            }
        )
    return payload


def print_step(message: str) -> None:
    print(f"ok - {message}")


def import_backend_app(cloud_url: str, backend_db: Path):
    os.environ.pop("TEST", None)
    os.environ["DEBUG"] = "0"
    os.environ["SECRET_KEY"] = "cloud-backups-e2e-secret"
    os.environ["DATABASE_URL"] = f"sqlite:///{backend_db}"
    os.environ["FRAMEOS_CLOUD_URL"] = cloud_url
    os.environ.setdefault("REDIS_URL", "redis://localhost:6379/15")

    sys.path.insert(0, str(BACKEND_ROOT))
    os.chdir(BACKEND_ROOT)

    from app.database import Base, engine
    import app.models  # noqa: F401
    from app.fastapi import app

    Base.metadata.create_all(bind=engine)
    return app


def backend_path_from_absolute_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.path:
        raise AssertionError(f"Expected an absolute callback URL, got: {url}")
    return f"{parsed.path}?{parsed.query}" if parsed.query else parsed.path


async def run_e2e(args: argparse.Namespace) -> None:
    cloud_repo = args.cloud_repo.resolve()
    if not (cloud_repo / "package.json").exists():
        raise SystemExit(f"FrameOS docs/cloud repo not found: {cloud_repo}")
    if not (cloud_repo / "node_modules").exists() and not args.install_cloud_deps:
        raise SystemExit(f"{cloud_repo}/node_modules is missing. Run npm install there or pass --install-cloud-deps.")

    temp_root = Path(tempfile.mkdtemp(prefix="frameos-cloud-e2e-"))
    cloud_worktree = temp_root / "frameos-docs"
    backend_db = temp_root / "frameos-backend.db"
    cloud_port = args.cloud_port or find_free_port()
    cloud_url = f"http://127.0.0.1:{cloud_port}"
    cloud_process: RunningProcess | None = None

    try:
        copy_cloud_repo(cloud_repo, cloud_worktree)
        if args.install_cloud_deps:
            subprocess.run(["npm", "install"], cwd=str(cloud_worktree), check=True)

        env = {
            **os.environ,
            "NEXT_TELEMETRY_DISABLED": "1",
            "NODE_ENV": "development",
        }
        cloud_command = ["npm", "run", "start", "--", "--hostname", "127.0.0.1", "--port", str(cloud_port)]
        if args.webpack:
            cloud_command.append("--webpack")

        cloud_process = RunningProcess(
            cloud_command,
            cwd=cloud_worktree,
            env=env,
            verbose=args.verbose,
        )
        await wait_for_cloud(cloud_url, cloud_process, args.timeout)
        print_step(f"FrameOS Cloud app is serving at {cloud_url}")

        backend_app = import_backend_app(cloud_url, backend_db)
        transport = httpx.ASGITransport(app=backend_app)

        async with httpx.AsyncClient(base_url=cloud_url, timeout=30.0, follow_redirects=False) as cloud_client:
            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://frameos-backend.test",
                timeout=30.0,
                follow_redirects=False,
            ) as backend_client:
                cloud_email = "owner@example.com"
                cloud_password = "cloud-password"
                local_password = "local-password"

                cloud_register = await cloud_client.post(
                    "/api/auth/register",
                    json={"email": cloud_email, "password": cloud_password, "name": "E2E Owner"},
                )
                assert cloud_register.status_code == 200, cloud_register.text
                assert cloud_register.json()["user"]["email"] == cloud_email
                print_step("cloud account registered and session cookie set")

                signup_start = await backend_client.post(
                    "/api/cloud/signup/start",
                    json={
                        "email": cloud_email,
                        "password": local_password,
                        "password2": local_password,
                        "newsletter": False,
                    },
                )
                assert signup_start.status_code == 200, signup_start.text
                cloud_auth_url = signup_start.json()["cloud_auth_url"]
                assert cloud_auth_url.startswith(f"{cloud_url}/api/cloud/backend/auth/start?"), cloud_auth_url
                print_step("backend produced cloud auth URL with local CSRF state")

                cloud_auth = await cloud_client.get(cloud_auth_url)
                assert cloud_auth.status_code in {307, 308}, cloud_auth.text
                callback_url = cloud_auth.headers["location"]
                callback_query = parse_qs(urlparse(callback_url).query)
                assert callback_query.get("code", [""])[0]
                assert callback_query.get("state", [""])[0]
                print_step("cloud auth start returned one-time backend callback code")

                callback = await backend_client.get(backend_path_from_absolute_url(callback_url))
                assert callback.status_code in {307, 308}, callback.text
                assert "frameos_session" in backend_client.cookies
                print_step("backend exchanged code with cloud and created linked local user")

                status = await backend_client.get("/api/cloud/status")
                assert status.status_code == 200, status.text
                assert status.json()["linked"] is True
                assert status.json()["cloud_auth_required"] is True
                print_step("backend reports linked cloud status")

                frontend_return_url = "http://localhost:8616/settings"
                reauth_start = await backend_client.post(
                    "/api/cloud/reauth/start",
                    headers={
                        "origin": "http://localhost:8616",
                        "x-frameos-return-to": frontend_return_url,
                    },
                )
                assert reauth_start.status_code == 200, reauth_start.text
                reauth_url = reauth_start.json()["cloud_auth_url"]
                reauth_query = parse_qs(urlparse(reauth_url).query)
                assert reauth_query["redirect_uri"] == ["http://localhost:8616/api/cloud/callback"]
                reauth_cloud = await cloud_client.get(reauth_url)
                assert reauth_cloud.status_code in {307, 308}, reauth_cloud.text
                reauth_callback = await backend_client.get(backend_path_from_absolute_url(reauth_cloud.headers["location"]))
                assert reauth_callback.status_code in {307, 308}, reauth_callback.text
                assert reauth_callback.headers["location"] == frontend_return_url
                print_step("authenticated backend session reauthenticated with FrameOS Cloud")

                create_backup = await backend_client.post(
                    "/api/cloud/backups",
                    json={"backupId": "e2e-backup", "encryptedManifest": envelope(with_kdf=True)},
                )
                assert create_backup.status_code == 200, create_backup.text
                backup = create_backup.json()["backup"]
                assert backup["id"] == "e2e-backup"
                assert "encryptedManifest" in backup
                print_step("backend uploaded encrypted manifest through cloud token")

                put_object = await backend_client.put(
                    "/api/cloud/backups/e2e-backup/objects/e2e-object",
                    json={"digest": "sha256:e2e", "encryptedObject": envelope()},
                )
                assert put_object.status_code == 200, put_object.text
                assert put_object.json()["object"]["id"] == "e2e-object"
                print_step("backend uploaded encrypted object through cloud token")

                list_backups = await backend_client.get("/api/cloud/backups")
                assert list_backups.status_code == 200, list_backups.text
                assert any(item["id"] == "e2e-backup" for item in list_backups.json()["backups"])
                print_step("backend listed cloud backups through cloud token")

                get_object = await backend_client.get("/api/cloud/backups/e2e-backup/objects/e2e-object")
                assert get_object.status_code == 200, get_object.text
                assert get_object.json()["object"]["encryptedObject"]["algorithm"] == "AES-256-GCM"
                print_step("backend downloaded encrypted object through cloud token")

                export_manifest = await backend_client.get("/api/cloud/export/manifest?includeFrameFiles=false")
                assert export_manifest.status_code == 200, export_manifest.text
                manifest = export_manifest.json()
                assert manifest["schemaVersion"] == "frameos.backend.export.v1"
                print_step("backend produced plaintext export manifest for browser encryption")

                import_prepare = await backend_client.post("/api/cloud/import/prepare", json={"manifest": manifest})
                assert import_prepare.status_code == 200, import_prepare.text
                assert import_prepare.json()["sessionId"].startswith("imp_")
                print_step("backend accepted decrypted manifest for restore preparation")

                plaintext_rejection = await backend_client.post(
                    "/api/cloud/backups",
                    json={"frames": [], "encryptedManifest": envelope(with_kdf=True)},
                )
                assert plaintext_rejection.status_code == 400, plaintext_rejection.text
                print_step("backend rejects plaintext backup fields before cloud upload")

        print(f"\nE2E passed: backend and FrameOS Cloud worked together via {cloud_url}")
    finally:
        if cloud_process is not None:
            cloud_process.stop()
        if args.keep_temp:
            print(f"kept temp workspace: {temp_root}")
        else:
            shutil.rmtree(temp_root, ignore_errors=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run FrameOS backend <-> FrameOS Cloud backup e2e test.")
    parser.add_argument("--cloud-repo", type=Path, default=DEFAULT_CLOUD_REPO, help="Path to the frameos-docs checkout.")
    parser.add_argument("--cloud-port", type=int, default=0, help="Port for the temporary cloud app. Defaults to a free port.")
    parser.add_argument("--timeout", type=float, default=45.0, help="Seconds to wait for the cloud app to become ready.")
    parser.add_argument("--install-cloud-deps", action="store_true", help="Run npm install in the temporary cloud copy if needed.")
    parser.add_argument("--webpack", action=argparse.BooleanOptionalAction, default=True, help="Start Next.js dev with --webpack. Enabled by default because Turbopack rejects the temporary node_modules symlink.")
    parser.add_argument("--keep-temp", action="store_true", help="Keep the temporary cloud/backend data directory after the run.")
    parser.add_argument("--verbose", action="store_true", help="Print cloud app logs while running.")
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        asyncio.run(run_e2e(args))
    except AssertionError as exc:
        print(f"\nE2E assertion failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"\nE2E failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
