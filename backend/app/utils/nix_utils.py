from __future__ import annotations
import os
import shlex
import subprocess
import tempfile
from typing import Any, Callable, Dict, Tuple

# ─────────────────────────────────────────────────────────────────────────────
# 1.  Ephemeral ssh‑agent helper  (RAM‑only key storage)
# ─────────────────────────────────────────────────────────────────────────────
_active_agent_dirs: list[tempfile.TemporaryDirectory] = []  # keep sockets alive


def _spawn_ephemeral_agent(key: str) -> str:
    """
    Launch a private ssh-agent, feed it *key* (inline PEM or file),
    and return the $SSH_AUTH_SOCK to export.  The key never hits the FS.
    """
    tmpd = tempfile.TemporaryDirectory(prefix="nix_agent_")
    _active_agent_dirs.append(tmpd)              # keep dir alive
    sock = os.path.join(tmpd.name, "agent.sock")

    # Start the agent bound to our private socket
    subprocess.check_call(["ssh-agent", "-a", sock, "-s"],
                          stdout=subprocess.DEVNULL)

    # Prepare the key material
    key_data = (key.strip() + "\n").encode()

    # Load the key into the agent via stdin (ssh‑add -)
    subprocess.run(["ssh-add", "-"],
                   input=key_data,
                   check=True,
                   stdout=subprocess.DEVNULL)

    return sock


# ─────────────────────────────────────────────────────────────────────────────
# 2.  Public API ­– nix_cmd
# ─────────────────────────────────────────────────────────────────────────────
def nix_cmd(base: str, settings: Dict[str, Any] | None) -> Tuple[str, str, Callable[[], None]]:
    """
    Expand *base* with user‑provided Nix settings.

    Returns  (actual_cmd, masked_cmd)  – the latter is safe to log.
    """
    nix = (settings or {}).get("nix") or {}

    # -- 1. free‑form flags --------------------------------------------------
    extra = nix.get("buildExtraArgs")
    if extra:
        base   += f" {extra}"

    masked = base  # will diverge only for secrets

    def cleanup() -> None:
        return None

    # -- 2. remote builder ---------------------------------------------------
    host = nix.get("buildServer")
    if not host:
        return base, masked, cleanup                          # nothing else to add

    user = nix.get("buildServerUser") or os.getenv("USER", "root")
    port = int(nix.get("buildServerPort", 22))

    # Builder URI (host **without** “:port”; port is a query parameter)
    builder_uri = f"ssh://{user}@{host}"

    query_params: list[str] = []
    if port != 22:
        query_params.append(f"ssh-port={port}")

    # ----- key handling -----------------------------------------------------
    private_key = nix.get("buildServerPrivateKey")
    if private_key:
        sock = _spawn_ephemeral_agent(private_key)
        base   = f'SSH_AUTH_SOCK={shlex.quote(sock)} ' + base
        masked = 'SSH_AUTH_SOCK=*** ' + masked

    if query_params:
        builder_uri += "?" + ("&".join(query_params))

    max_jobs = int(nix.get("buildServerMaxParallelJobs", 8))
    if max_jobs < 1:
        raise ValueError("Max parallel jobs must be at least 1")
    builder_spec = f"{builder_uri} aarch64-linux - {max_jobs}"
    base   += f" --builders {shlex.quote(builder_spec)}"
    masked += " --builders '***masked***'"

    return base, masked, cleanup