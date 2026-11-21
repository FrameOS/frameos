"""A scene as files (docs/scene-packages.md): the backend's port of
frontend/src/utils/scenePackage.ts, pinned with it (and the runtime's reader,
frameos/src/frameos/scene_package.nim) by docs/scene-package-fixtures.json.

    scene.json             the scene, every app's `sources` taken out
    apps/<keyword>/<file>  each file of `apps[keyword].sources`, as it is
    assets/...             reserved

A set (a template zip, a repo sample, a frame's deployed set) is a folder of
scene folders: template.json, whose `scenes` lists the folders in order, and
`<folder>/scene.json` + `<folder>/apps/...` per scene. Readers also take the
form before packages: template.json naming a scenes.json with the whole array.
"""

from __future__ import annotations

import io
import json
import re
import zipfile
from typing import Any

SCENE_FILE = "scene.json"
TEMPLATE_FILE = "template.json"
APPS_FOLDER = "apps"
ASSETS_FOLDER = "assets"

_TEST_FILE = re.compile(r"\.test\.(ts|tsx|js|jsx)$", re.IGNORECASE)
_UNSAFE_FOLDER_CHARACTERS = re.compile(r'[\\/:*?"<>|\x00-\x1f\x7f]')
_FILE_EXTENSION = re.compile(r"\.(json|jpe?g|png|webp|gif|zip)$", re.IGNORECASE)
_RESERVED_FOLDERS = {APPS_FOLDER, ASSETS_FOLDER}


class ScenePackageError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def is_app_test_file(path: str) -> bool:
    """`<name>.test.ts` (.tsx, .js, .jsx): an app's own tests, which run in
    the editor and never on a frame."""
    return bool(_TEST_FILE.search(path))


def app_folder_name(keyword: str) -> str:
    return keyword.replace("%", "%25").replace("/", "%2F")


def keyword_of_app_folder(folder: str) -> str:
    return re.sub("%2F", "/", folder, flags=re.IGNORECASE).replace("%25", "%")


def is_safe_package_path(path: str) -> bool:
    if not path or path.startswith("/") or "\\" in path or "\0" in path:
        return False
    return all(segment not in ("", ".", "..") for segment in path.split("/"))


def _dumps(value: Any) -> str:
    return json.dumps(value, indent=2, ensure_ascii=False) + "\n"


def scene_package_files(scene: dict, *, without_tests: bool = False) -> dict[str, str]:
    """One scene's files: scene.json and every app file."""
    scene_json = dict(scene)
    app_files: dict[str, str] = {}
    apps = scene.get("apps")
    if isinstance(apps, dict):
        out_apps: dict[str, Any] = {}
        for keyword, app in apps.items():
            if not isinstance(app, dict) or not isinstance(app.get("sources"), dict):
                out_apps[keyword] = app
                continue
            rest = {key: value for key, value in app.items() if key != "sources"}
            out_apps[keyword] = rest
            for path, text in app["sources"].items():
                if not isinstance(text, str) or (without_tests and is_app_test_file(path)):
                    continue
                if not is_safe_package_path(path):
                    raise ScenePackageError("unsafe_path", f"The app {keyword} has a file named {path!r}")
                app_files[f"{APPS_FOLDER}/{app_folder_name(keyword)}/{path}"] = text
        scene_json["apps"] = out_apps
    return {SCENE_FILE: _dumps(scene_json), **app_files}


def scene_from_package_files(files: dict[str, str]) -> dict:
    """A scene from its files (scene_package_files' inverse)."""
    text = files.get(SCENE_FILE)
    if not isinstance(text, str):
        raise ScenePackageError("missing_scene", "The package has no scene.json")
    try:
        scene = json.loads(text)
    except ValueError as error:
        raise ScenePackageError("invalid_scene", f"scene.json is not JSON: {error}") from error
    if not isinstance(scene, dict):
        raise ScenePackageError("invalid_scene", "scene.json is not one scene object")
    prefix = f"{APPS_FOLDER}/"
    had_apps = isinstance(scene.get("apps"), dict)
    apps: dict[str, Any] = dict(scene["apps"]) if had_apps else {}
    saw_app = False
    for path in sorted(files):
        if not path.startswith(prefix):
            continue
        rest = path[len(prefix):]
        slash = rest.find("/")
        if slash <= 0 or not is_safe_package_path(path):
            raise ScenePackageError("unsafe_path", f"The package has a file named {path!r}")
        keyword = keyword_of_app_folder(rest[:slash])
        app = dict(apps[keyword]) if isinstance(apps.get(keyword), dict) else {}
        sources = dict(app["sources"]) if isinstance(app.get("sources"), dict) else {}
        app.pop("sources", None)
        sources[rest[slash + 1:]] = files[path]
        app["sources"] = sources
        apps[keyword] = app
        saw_app = True
    if saw_app or had_apps:
        scene["apps"] = apps
    return scene


def _folder_base(text: str) -> str:
    out = _UNSAFE_FOLDER_CHARACTERS.sub("-", text)
    out = re.sub(r"\s+", " ", out).strip()
    out = re.sub(r"^[.\s]+|[.\s]+$", "", out)
    return out[:64].strip()


def scene_folder_names(scenes: list[dict]) -> list[str]:
    taken: set[str] = set()
    names: list[str] = []
    for scene in scenes:
        scene_id = scene.get("id") if isinstance(scene.get("id"), str) else ""
        name = scene.get("name") if isinstance(scene.get("name"), str) else ""
        id_base = _folder_base(scene_id) or "scene"
        folder = _folder_base(name) or id_base

        def clashes(candidate: str) -> bool:
            lower = candidate.lower()
            return lower in taken or lower in _RESERVED_FOLDERS or bool(_FILE_EXTENSION.search(candidate))

        if clashes(folder):
            folder = f"{id_base} (scene)" if folder == id_base else f"{folder} ({id_base})"
        candidate = folder
        n = 2
        while clashes(candidate):
            candidate = f"{folder} {n}"
            n += 1
        taken.add(candidate.lower())
        names.append(candidate)
    return names


def set_package_files(scenes: list[dict], manifest: dict | None = None, *, without_tests: bool = False) -> dict[str, str]:
    """A set's files: template.json (`scenes` the folders in order) and every
    scene's package under its folder."""
    folders = scene_folder_names(scenes)
    files = {TEMPLATE_FILE: _dumps({**(manifest or {}), "scenes": [f"./{folder}" for folder in folders]})}
    for folder, scene in zip(folders, scenes):
        for path, text in scene_package_files(scene, without_tests=without_tests).items():
            files[f"{folder}/{path}"] = text
    return files


def _strip_dot_slash(path: str) -> str:
    while path.startswith("./"):
        path = path[2:]
    return path.rstrip("/")


def _files_under(files: dict[str, str], folder: str) -> dict[str, str]:
    if not folder:
        return files
    prefix = folder + "/"
    return {path[len(prefix):]: text for path, text in files.items() if path.startswith(prefix)}


def _dir(path: str) -> str:
    return path.rsplit("/", 1)[0] if "/" in path else ""


def package_root(paths: list[str]) -> str:
    """Where a set's files start: the folder of its shallowest template.json,
    else the parent of its shallowest scene folder, else the folder of its
    shallowest scenes.json; "" for the top."""

    def shallowest(name: str) -> str | None:
        matches = [path for path in paths if path == name or path.endswith("/" + name)]
        if not matches:
            return None
        return sorted(matches, key=lambda path: (path.count("/"), path))[0]

    template = shallowest(TEMPLATE_FILE)
    if template is not None:
        return _dir(template)
    scene = shallowest(SCENE_FILE)
    if scene is not None:
        return _dir(_dir(scene))
    legacy = shallowest("scenes.json")
    return _dir(legacy) if legacy is not None else ""


def set_from_package_files(files: dict[str, str], root: str | None = None) -> tuple[list[dict], dict | None]:
    """A set's scenes and its template.json (None without one), whichever form
    its files are in."""
    if root is None:
        root = package_root(list(files))
    own = _files_under(files, root)
    manifest: dict | None = None
    if isinstance(own.get(TEMPLATE_FILE), str):
        try:
            parsed = json.loads(own[TEMPLATE_FILE])
        except ValueError as error:
            raise ScenePackageError("invalid_template", f"template.json is not JSON: {error}") from error
        if not isinstance(parsed, dict):
            raise ScenePackageError("invalid_template", "template.json is not an object")
        manifest = parsed
    listed = manifest.get("scenes") if manifest is not None else None
    if isinstance(listed, str) or (listed is None and isinstance(own.get("scenes.json"), str)):
        path = _strip_dot_slash(listed) if isinstance(listed, str) else "scenes.json"
        text = own.get(path)
        if not isinstance(text, str):
            raise ScenePackageError("missing_scenes", f"The package has no {path}")
        try:
            parsed_scenes = json.loads(text)
        except ValueError as error:
            raise ScenePackageError("invalid_scenes", f"{path} is not JSON: {error}") from error
        scenes = parsed_scenes if isinstance(parsed_scenes, list) else [parsed_scenes] if isinstance(parsed_scenes, dict) else None
        if scenes is None or not all(isinstance(scene, dict) for scene in scenes):
            raise ScenePackageError("invalid_scenes", f"{path} is not a list of scenes")
        return scenes, manifest
    if isinstance(own.get(SCENE_FILE), str):
        return [scene_from_package_files(own)], manifest
    folders = sorted({path[: -len(SCENE_FILE) - 1] for path in own if path.endswith("/" + SCENE_FILE) and path.count("/") == 1})
    order: list[str] = []
    if isinstance(listed, list):
        for entry in listed:
            folder = _strip_dot_slash(entry) if isinstance(entry, str) else ""
            if not folder or not is_safe_package_path(folder) or "/" in folder:
                raise ScenePackageError("invalid_template", f"template.json lists {entry!r}")
            if folder not in folders:
                raise ScenePackageError("missing_scene", f"template.json lists {folder}, which has no scene.json")
            if folder not in order:
                order.append(folder)
    order.extend(folder for folder in folders if folder not in order)
    if not order:
        raise ScenePackageError("missing_scenes", "The package holds no scene")
    return [scene_from_package_files(_files_under(own, folder)) for folder in order], manifest


# ---- zips -------------------------------------------------------------------


def zip_bytes(files: dict[str, str | bytes], *, prefix: str = "", stored: frozenset[str] = frozenset()) -> bytes:
    """`files` as a zip, deflated, each under `prefix`; the paths in `stored`
    are kept as they are (a device package's scene.json, which a frame reads
    in place). In the order given: a device package's scene.json goes first."""
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as zf:
        for path, content in files.items():
            info = zipfile.ZipInfo(f"{prefix}{path}", date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED if path in stored else zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, content.encode() if isinstance(content, str) else content)
    return out.getvalue()


def device_package_bytes(scene: dict) -> bytes:
    """One scene as the zip a frame keeps: scene.json first and stored (the
    frame reads it in place), the app files deflated, tests left out."""
    return zip_bytes(scene_package_files(scene, without_tests=True), stored=frozenset({SCENE_FILE}))
