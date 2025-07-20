from __future__ import annotations

import os
import stat
import tempfile
from typing import Dict, Any, Tuple, Callable, Optional


# ────────────────────────────────────────────────────────────────────────────
# Private helpers
# ────────────────────────────────────────────────────────────────────────────

def _prepare_ssh_key(raw_or_path: str) -> str:
    """
    Return an *absolute* path to a private key file usable by `ssh`:

    • If *raw_or_path* already points to a file → return its absolute path.
    • Otherwise treat *raw_or_path* as inline PEM, write it once to a unique
      0600 temp file and return that path.
    """
    path = os.path.abspath(os.path.expanduser(raw_or_path))
    if os.path.exists(path):
        return path                               # already a file on disk

    tf = tempfile.NamedTemporaryFile(
        prefix="nixkey_", suffix=".pem", delete=False, mode="w", encoding="utf-8"
    )
    # TODO: make this safer
    tf.write(raw_or_path.strip() + "\n")
    tf.flush()
    os.fchmod(tf.fileno(), stat.S_IRUSR | stat.S_IWUSR)   # 0600
    return tf.name


def _ssh_builder_uri(nix_cfg: Dict[str, Any]) -> Tuple[Optional[str], Optional[str]]:
    """
    Return *(builder_uri, key_path)*.

    • builder_uri - e.g. 'ssh://alice@builder.example'  (no :port!)
    • key_path    - absolute path to private key (temp), or *None*
    """
    host = nix_cfg.get("buildServer")
    if not host:
        return None, None

    user = nix_cfg.get("buildServerUser") or os.getenv("USER", "root")
    uri  = f"ssh://{user}@{host}"

    key_val = nix_cfg.get("buildServerPrivateKey")
    if key_val:
        key_path = _prepare_ssh_key(key_val)
        return uri, key_path

    return uri, None


# ────────────────────────────────────────────────────────────────────────────
# Public helper
# ────────────────────────────────────────────────────────────────────────────

def nix_cmd(base: str, settings: Dict[str, Any] | None) -> Tuple[str, str, Callable[[], None]]:
    """
    Expand a ready-made **`base`** `nix …` command string using the project's
    **Settings → nix → …** fields and return a triple:

        *(cmd, masked_cmd, cleanup_fn)*

    * **cmd**        - string ready to `subprocess …`
    * **masked_cmd** - safe for logs (identity path redacted)
    * **cleanup_fn** - ALWAYS call once the build finishes (even on errors)

    Recognised settings (all optional):
      • nix.buildExtraArgs
      • nix.buildServer, nix.buildServerPort, nix.buildServerUser
      • nix.buildServerPrivateKey / nix.buildServerPublicKey
    """
    nix_cfg = (settings or {}).get("nix") or {}

    # 1. arbitrary extra flags ------------------------------------------------
    extra = nix_cfg.get("buildExtraArgs")
    if extra:
        base   += f" {extra}"

    masked = base
    def cleanup() -> None:
        return None          # default no-op

    # 2. remote builder -------------------------------------------------------
    builder_uri, key_path = _ssh_builder_uri(nix_cfg)
    if builder_uri:
        # --- craft NIX_SSHOPTS ----------------------------------------------
        port = int(nix_cfg.get("buildServerPort") or 22)
        ssh_opts: list[str] = []

        if key_path:
            ssh_opts += ["-i", key_path]
        if port != 22:
            ssh_opts += ["-p", str(port)]

        ssh_opts += ["-o", "StrictHostKeyChecking=no"]

        if ssh_opts:
            env_prefix = f'NIX_SSHOPTS="{" ".join(ssh_opts)}" '
            base   = env_prefix + base
            masked = (
                'NIX_SSHOPTS="' +
                " ".join("***" if tok == key_path else tok for tok in ssh_opts) +
                '" ' + masked
            )

        # attach builder (no :port here!)
        base   += f" --builders '{builder_uri}'"
        masked += " --builders '***masked***'"

        # cleanup temp key afterwards
        if key_path:
            def cleanup() -> None:
                os.unlink(key_path)

    return base, masked, cleanup