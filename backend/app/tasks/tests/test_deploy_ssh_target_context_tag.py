"""The SSH target image tag must be the same whichever way it is computed.

CI computes it twice: the workflow runs context_tag.py as a script to name
the image it pre-builds, and the E2E test imports the module to decide
whether that image is already present. Importing writes ``__pycache__`` into
the build context, and a digest over "every file" moved with it — so the two
disagreed, the pre-built image was never found, and every run rebuilt it.
"""

from __future__ import annotations

import importlib.util
import py_compile
import shutil
import sys
from pathlib import Path

CONTEXT_DIR = Path(__file__).with_name("deploy_ssh_target")


def _load_helper():
    spec = importlib.util.spec_from_file_location("context_tag", CONTEXT_DIR / "context_tag.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _copy_context(tmp_path: Path) -> Path:
    target = tmp_path / "ctx"
    shutil.copytree(CONTEXT_DIR, target, ignore=shutil.ignore_patterns("__pycache__"))
    return target


def test_bytecode_and_ignore_files_do_not_move_the_tag(tmp_path: Path) -> None:
    helper = _load_helper()
    ctx = _copy_context(tmp_path)
    clean = helper.context_tag(ctx)

    # What `import context_tag` leaves behind on a machine that writes bytecode.
    py_compile.compile(str(ctx / "context_tag.py"), cfile=str(ctx / "__pycache__" / "context_tag.cpython-312.pyc"))
    (ctx / "__pycache__" / "stray.pyo").write_bytes(b"\x00")
    assert helper.context_tag(ctx) == clean

    # The two files that are in the directory but never in the image.
    (ctx / ".dockerignore").write_text("# rewritten\n")
    (ctx / "context_tag.py").write_text("# rewritten helper\n")
    assert helper.context_tag(ctx) == clean


def test_image_inputs_do_move_the_tag(tmp_path: Path) -> None:
    helper = _load_helper()
    ctx = _copy_context(tmp_path)
    clean = helper.context_tag(ctx)

    with (ctx / "Dockerfile").open("a") as handle:
        handle.write("\n# a change to the image\n")
    assert helper.context_tag(ctx) != clean


def test_dockerignore_agrees_with_the_digest() -> None:
    """Whatever the digest skips, Docker must not send either — and vice
    versa — or the tag would name an image built from different inputs."""
    ignored = {
        line.strip()
        for line in (CONTEXT_DIR / ".dockerignore").read_text().splitlines()
        if line.strip() and not line.startswith("#")
    }
    assert ignored == {"context_tag.py", "__pycache__/", "*.pyc", "*.pyo", ".dockerignore"}


def test_helper_is_importable_by_the_e2e_test() -> None:
    sys.path.insert(0, str(CONTEXT_DIR))
    try:
        import context_tag  # noqa: F401
    finally:
        sys.path.remove(str(CONTEXT_DIR))
