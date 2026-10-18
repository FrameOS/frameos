"""Where a Linux frame's NEW assets folder may be. Scenes and the frame's asset
routes write there, so it must never be, or contain, the runtime's own files
(state/local_access.json, the release, frame.json). The frame's own settings
save applies the same rule (frameos/src/frameos/config.nim, assetsPathAllowed).
Only a changed value is held to it: a folder stored before the rule keeps
working. An ESP32 mounts its SD card at its assets path instead and is not
held to this."""

ASSETS_PATH_ROOTS = ("/srv/assets", "/mnt", "/media")
ASSETS_PATH_RULE = "The assets path must be /srv/assets, /mnt or /media, or a folder inside one of them."


def assets_path_allowed(path: str) -> bool:
    """One of ASSETS_PATH_ROOTS, or a folder inside one: absolute, no `.`, `..`
    or empty segments, a trailing slash allowed."""
    trimmed = path.rstrip("/")
    if not trimmed.startswith("/"):
        return False
    if any(segment in ("", ".", "..") for segment in trimmed[1:].split("/")):
        return False
    return any(trimmed == root or trimmed.startswith(root + "/") for root in ASSETS_PATH_ROOTS)


def assets_path_change_allowed(path: str, stored: str | None) -> bool:
    """Whether a save may set `path`: empty (the default), inside the roots,
    or the folder already stored (the form sends every field)."""
    value = path.strip()
    if not value or assets_path_allowed(value):
        return True
    return value.rstrip("/") == (stored or "").strip().rstrip("/")
